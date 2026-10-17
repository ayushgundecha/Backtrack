'use client';

import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { latestRun, pendingApproval, type RunView, type StepView } from '@/lib/session';
import { agentName } from '@/lib/tools';
import { useBacktrack } from './BacktrackProvider';
import { StatusBadge } from './StatusBadge';
import { StepCard } from './StepCard';

function RunSection({ run, steps }: { run: RunView; steps: StepView[] }) {
  const name = agentName[run.agentId] ?? run.agentId;
  return (
    <section aria-label={`${name} run ${run.runId}`} className="flex flex-col gap-3">
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
      {steps.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {steps.map((step) => (
            <StepCard key={step.stepId} step={step} />
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
  // One polite announcement for screen readers instead of making every card a live region.
  const announcement = waiting
    ? `Approval needed for ${waiting.tool}`
    : run
      ? `${agentName[run.agentId] ?? run.agentId} run ${run.status}`
      : '';

  // Keep the newest step (and an approval waiting on a human) in view while the run streams.
  // Only when the pane scrolls on its own (>= 1024 px); on a stacked page it would yank the user.
  const end = useRef<HTMLDivElement>(null);
  const progress = session.steps.length + (waiting ? 1 : 0);
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
        <p className="text-fg-muted">Each step the agent takes appears here as it happens.</p>
      ) : (
        session.runs.map((r) => (
          <RunSection
            key={r.runId}
            run={r}
            steps={session.steps.filter((s) => s.runId === r.runId)}
          />
        ))
      )}
      <div ref={end} />
    </div>
  );
}
