'use client';

import { Check, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { StepView } from '@/lib/session';
import { useBacktrack } from './BacktrackProvider';

/**
 * The evidence behind a step: the Cypher that recorded it, how long it took and the rows it
 * returned, exactly as the action.recorded event carries them. Collapsed by default so the stream
 * stays readable; a native <details> gives keyboard and screen-reader support for free.
 */
export function TraceStrip({ trace }: { trace: NonNullable<StepView['trace']> }) {
  const { meta } = useBacktrack();
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(reset.current ?? undefined), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(trace.cypher);
      setCopied(true);
      clearTimeout(reset.current ?? undefined);
      reset.current = setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error(`Could not copy the Cypher: ${error instanceof Error ? error.message : error}`);
    }
  };

  const rows = `${trace.rows} ${trace.rows === 1 ? 'row' : 'rows'}`;
  // `relative` keeps the sr-only live region inside the pane instead of stretching the page.
  return (
    <details className="group relative rounded-md border bg-bg">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5 text-fg-muted text-xs hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90"
        />
        <span>Cypher</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{trace.ms} ms</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{rows}</span>
        {meta.source === 'mock' ? <span className="ml-auto">Mock trace</span> : null}
      </summary>
      <div className="flex flex-col gap-1 border-t px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-fg-muted text-xs">
            {meta.source === 'mock'
              ? 'Mirrors the catalogue query; the mock does not run it'
              : `Ran on bt:${meta.tenant}`}
          </span>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={copy}
            aria-label="Copy the Cypher"
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <span className="sr-only" aria-live="polite">
            {copied ? 'Cypher copied to the clipboard' : ''}
          </span>
        </div>
        {/* Wrapped, and without ligatures, so `->` reads as typed and nothing hides off-screen. */}
        <pre className="whitespace-pre-wrap break-words font-mono text-code text-fg-muted [font-variant-ligatures:none]">
          <code>{trace.cypher}</code>
        </pre>
      </div>
    </details>
  );
}
