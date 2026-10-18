'use client';

import { Ban, Link2 } from 'lucide-react';
import { type ActionRef, formatArgs, stepCall, stepPhase } from '@/lib/run-view';
import type { StepView } from '@/lib/session';
import { familyDotClass, familyOf } from '@/lib/tools';
import { ApprovalCard } from './ApprovalCard';
import { StatusBadge } from './StatusBadge';
import { TraceStrip } from './TraceStrip';

const idOf = (value: unknown) =>
  value && typeof value === 'object' && 'id' in value ? String(value.id) : null;

/**
 * One line for a tool result: its own summary if it has one, else the id it returned, else the
 * records it returned by id (lookups), else JSON.
 */
function resultLine(result: unknown): string {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (typeof r.summary === 'string') return r.summary;
    const id = idOf(r);
    if (id) return `Returned ${id}`;
    const records = Object.entries(r).flatMap(([key, value]) => {
      const ids = (Array.isArray(value) ? value : [value]).map(idOf).filter(Boolean);
      return ids.length > 0 ? [`${key} ${ids.join(', ')}`] : [];
    });
    if (records.length > 0) return `Read ${records.join(', ')}`;
  }
  return JSON.stringify(result);
}

/** The status pill for the phases that have no recorded action yet. */
const phaseStatus = {
  calling: null,
  'awaiting-approval': 'pending',
  denied: 'denied',
  blocked: 'blocked',
  recorded: null,
} as const;

/**
 * One agent step, filled in as its events arrive: the thought (step), then the tool call and
 * result (action.recorded), or the gate (approval.requested / resolved), or a policy block.
 */
export function StepCard({
  step,
  actions,
  ended = false,
}: {
  step: StepView;
  actions: Map<string, ActionRef>;
  /** The run has finished or failed: a step without a call will not get one. */
  ended?: boolean;
}) {
  const { action, approval, blocked } = step;
  const call = stepCall(step);
  const phase = stepPhase(step);
  const status = action?.status ?? phaseStatus[phase];
  // DEPENDS_ON comes with the recorded event; naming it by tool and seq is the graph's "why".
  const dependsOn = step.dependsOn.map((id) => ({ id, ref: actions.get(id) }));

  return (
    <li className="fade-in-0 slide-in-from-bottom-1 animate-in duration-300">
      <article
        aria-label={`Step ${step.index + 1}${call ? `: ${call.tool}` : ''}`}
        className="flex flex-col gap-2 rounded-lg border bg-surface p-3"
      >
        <div className="flex items-center gap-2 text-fg-muted text-xs">
          <span>Step {step.index + 1}</span>
          {action ? <span className="font-mono">seq {action.seq}</span> : null}
          {status ? <StatusBadge status={status} className="ml-auto" /> : null}
        </div>
        <p className="text-fg italic">{step.thought}</p>
        {call ? (
          <p className="flex min-w-0 items-center gap-2">
            <code className="flex shrink-0 items-center gap-1.5 rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-code">
              <span
                aria-hidden
                className={`size-2 rounded-full ${familyDotClass[familyOf(call.tool)]}`}
              />
              {call.tool}
            </code>
            {Object.keys(call.args).length > 0 ? (
              <code
                className="truncate font-mono text-code text-fg-muted"
                title={formatArgs(call.args)}
              >
                {formatArgs(call.args)}
              </code>
            ) : null}
          </p>
        ) : (
          <p className="text-fg-muted text-sm">
            {ended ? 'No tool call was recorded for this step.' : 'Waiting for the tool call…'}
          </p>
        )}
        {action ? (
          <p className="line-clamp-2 text-fg-muted text-sm">{resultLine(action.result)}</p>
        ) : null}
        {dependsOn.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-fg-muted text-xs">
            <Link2 aria-hidden className="size-3.5" />
            <span>Depends on</span>
            {dependsOn.map(({ id, ref }, i) => (
              <span key={id} className="font-mono">
                {ref ? `${ref.tool} (seq ${ref.seq})` : id}
                {i < dependsOn.length - 1 ? ',' : ''}
              </span>
            ))}
          </p>
        ) : null}
        {blocked ? (
          <p className="flex items-center gap-2 text-red text-sm">
            <Ban aria-hidden className="size-4 shrink-0" />
            Blocked by policy {blocked.policyId}: {blocked.rule}
          </p>
        ) : null}
        {approval ? <ApprovalCard approval={approval} /> : null}
        {step.trace ? <TraceStrip trace={step.trace} /> : null}
      </article>
    </li>
  );
}
