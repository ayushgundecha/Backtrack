'use client';

import { CircleAlert, Info } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { type ActionRef, recordedActions } from '@/lib/run-view';
import {
  latestRun,
  pendingApproval,
  type RunView,
  type SessionNotice,
  type StepView,
} from '@/lib/session';
import { agentName } from '@/lib/tools';
import { useBacktrack } from './BacktrackProvider';
import { EmptyState } from './EmptyState';
import { StatusBadge } from './StatusBadge';
import { StepCard } from './StepCard';

function RunSection({
  run,
  steps,
  actions,
}: {
  run: RunView;
  steps: StepView[];
  actions: Map<string, ActionRef>;
}) {
  const name = agentName[run.agentId] ?? run.agentId;
  return (
    <section aria-label={`${name} run ${run.runId}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{name}</h3>
          <span className="font-mono text-fg-muted text-xs">{run.runId}</span>
          <StatusBadge status={run.status} />
          <Badge variant="outline" className="border-border font-normal text-fg-muted">
            {run.mode === 'replay' ? 'Replay' : 'Live LLM'}
          </Badge>
          {run.model ? (
            <Badge variant="outline" className="border-border font-mono font-normal text-fg-muted">
              {run.model}
            </Badge>
          ) : null}
        </div>
        <p className="text-fg-muted text-sm">{run.goal}</p>
      </header>
      {steps.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {steps.map((step) => (
            <StepCard
              key={step.stepId}
              step={step}
              actions={actions}
              ended={run.status === 'done' || run.status === 'failed'}
            />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/**
 * An `error` event, in the stream where it happened. One naming a run is a failure (red); one
 * without a run is the server explaining a fallback, such as live mode showing the replay.
 */
function Notice({ notice }: { notice: SessionNotice }) {
  const failed = notice.runId !== null;
  const Icon = failed ? CircleAlert : Info;
  return (
    <p
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
        failed ? 'border-red/50 text-fg' : 'bg-surface-2 text-fg'
      }`}
    >
      <Icon
        aria-hidden
        className={`mt-0.5 size-4 shrink-0 ${failed ? 'text-red' : 'text-fg-muted'}`}
      />
      <span>{notice.message}</span>
    </p>
  );
}

/** Center column, top: one section per run, its step cards newest last, as events stream in. */
export function RunStream() {
  const { state, meta } = useBacktrack();
  const { session } = state;
  // The stream shows runs started from this page; a tenant can already hold history (another
  // tab, the CLI, an earlier visit), so "nothing recorded" is only said when the graph agrees.
  const recorded = state.graph?.nodes.filter((n) => n.label === 'Action').length ?? 0;
  const run = latestRun(session);
  const waiting = pendingApproval(session);
  const actions = useMemo(() => recordedActions(session), [session]);
  // One polite announcement for screen readers instead of making every card a live region.
  const announcement = waiting
    ? `Approval needed for ${waiting.tool}`
    : run
      ? `${agentName[run.agentId] ?? run.agentId} run ${run.status}`
      : '';

  const noticesAt = (beforeRun: number) =>
    session.errors
      .map((notice, i) => ({ notice, i }))
      .filter(({ notice }) => notice.beforeRun === beforeRun)
      .map(({ notice, i }) => <Notice key={`notice-${i}`} notice={notice} />);

  // Keep the newest step (and an approval waiting on a human) in view while the run streams.
  // Only when the pane scrolls on its own (>= 1024 px); on a stacked page it would yank the user.
  const end = useRef<HTMLDivElement>(null);
  // Counts events that grow the stream: a new step, its recorded action, a gate opening.
  const progress = session.steps.length + actions.size + (waiting ? 1 : 0) + session.errors.length;
  useEffect(() => {
    if (progress > 0 && window.matchMedia('(min-width: 1024px)').matches) {
      end.current?.scrollIntoView({ block: 'end' });
    }
  }, [progress]);

  return (
    <div className="flex flex-col gap-6">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {session.runs.length === 0 && session.errors.length === 0 && !state.graph ? (
        // Until the graph is read, "nothing recorded" would be a guess.
        state.loadError ? (
          <p className="text-fg-muted text-sm">
            The graph could not be read, so whether anything is recorded is unknown.
          </p>
        ) : (
          <div
            role="status"
            aria-busy="true"
            aria-label="Reading the graph"
            className="h-24 rounded-lg border bg-surface-2"
          />
        )
      ) : session.runs.length === 0 && session.errors.length === 0 ? (
        <EmptyState
          title={
            recorded > 0
              ? `bt:${meta.tenant} already holds ${recorded} recorded ${recorded === 1 ? 'action' : 'actions'} (GET /api/graph); they are in the graph. Runs started here stream step by step.`
              : 'Nothing recorded yet. Run the ops agent. Each step appears here as it happens.'
          }
        />
      ) : (
        session.runs.map((r, i) => (
          <Fragment key={r.runId}>
            {noticesAt(i)}
            <RunSection
              run={r}
              steps={session.steps.filter((s) => s.runId === r.runId)}
              actions={actions}
            />
          </Fragment>
        ))
      )}
      {noticesAt(session.runs.length)}
      <div ref={end} />
    </div>
  );
}
