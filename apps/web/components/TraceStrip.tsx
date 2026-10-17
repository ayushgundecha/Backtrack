'use client';

import { ChevronRight } from 'lucide-react';
import type { StepView } from '@/lib/session';
import { useBacktrack } from './BacktrackProvider';

/** The evidence behind a step: the Cypher that recorded it, how long it took, rows touched. */
export function TraceStrip({ trace }: { trace: NonNullable<StepView['trace']> }) {
  const { meta } = useBacktrack();
  return (
    <details className="group rounded-md border bg-bg">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-fg-muted text-xs [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
        Cypher · {trace.ms} ms · {trace.rows} {trace.rows === 1 ? 'row' : 'rows'}
        {meta.source === 'mock' ? <span className="ml-auto">mock trace</span> : null}
      </summary>
      <pre className="overflow-x-auto border-t px-3 py-2 font-mono text-code text-fg-muted">
        {trace.cypher}
      </pre>
    </details>
  );
}
