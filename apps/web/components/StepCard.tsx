'use client';

import { Ban } from 'lucide-react';
import type { StepView } from '@/lib/session';
import { ApprovalCard } from './ApprovalCard';
import { StatusBadge } from './StatusBadge';
import { TraceStrip } from './TraceStrip';

const formatArgs = (args: Record<string, unknown>) =>
  Object.entries(args)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');

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

export function StepCard({ step }: { step: StepView }) {
  const { action, approval, blocked } = step;
  return (
    <li>
      <article
        aria-label={`Step ${step.index + 1}`}
        className="flex flex-col gap-2 rounded-lg border bg-surface p-3"
      >
        <div className="flex items-center gap-2 text-fg-muted text-xs">
          <span>Step {step.index + 1}</span>
          {action ? <span className="font-mono">seq {action.seq}</span> : null}
          {action ? <StatusBadge status={action.status} className="ml-auto" /> : null}
        </div>
        <p className="text-fg italic">{step.thought}</p>
        {action ? (
          <>
            <p className="flex min-w-0 items-baseline gap-2">
              <code className="shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-code">
                {action.tool}
              </code>
              <code
                className="truncate font-mono text-code text-fg-muted"
                title={formatArgs(action.args)}
              >
                {formatArgs(action.args)}
              </code>
            </p>
            <p className="line-clamp-2 text-fg-muted text-sm">{resultLine(action.result)}</p>
          </>
        ) : null}
        {blocked ? (
          <p className="flex items-center gap-2 text-red text-sm">
            <Ban aria-hidden className="size-4" />
            Blocked by policy {blocked.policyId}: {blocked.rule}
          </p>
        ) : null}
        {approval ? <ApprovalCard approval={approval} /> : null}
        {step.trace ? <TraceStrip trace={step.trace} /> : null}
      </article>
    </li>
  );
}
