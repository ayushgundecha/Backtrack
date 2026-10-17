'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { type ActionRef, recordedActions } from '@/lib/run-view';
import { latestRun, pendingApproval, type RunView, type StepView } from '@/lib/session';
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
            <StepCard key={step.stepId} step={step} actions={actions} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** Center column, top: one section per run, its step cards newest last, as events stream in. */
export function RunStream() {
  const { state } = useBacktrack();
  const { session } = state;
  const run = latestRun(session);
  const waiting = pendingApproval(session);
  const actions = useMemo(() => recordedActions(session), [session]);
  // One polite announcement for screen readers instead of making every card a live region.
  const announcement = waiting
    ? `Approval needed for ${waiting.tool}`
    : run
      ? `${agentName[run.agentId] ?? run.agentId} run ${run.status}`
      : '';

  // Keep the newest step (and an approval waiting on a human) in view while the run streams.
  // Only when the pane scrolls on its own (>= 1024 px); on a stacked page it would yank the user.
  const end = useRef<HTMLDivElement>(null);
  // Counts events that grow the stream: a new step, its recorded action, a gate opening.
  const progress = session.steps.length + actions.size + (waiting ? 1 : 0);
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
      {session.runs.length === 0 ? (
        <EmptyState title="Nothing recorded yet. Run the ops agent. Each step appears here as it happens." />
      ) : (
        session.runs.map((r) => (
          <RunSection
            key={r.runId}
            run={r}
            steps={session.steps.filter((s) => s.runId === r.runId)}
            actions={actions}
          />
        ))
      )}
      <div ref={end} />
    </div>
  );
}
