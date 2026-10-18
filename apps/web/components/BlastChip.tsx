'use client';

/**
 * What undoing the selected action would touch, and how far to look. Every number here is a field
 * of the UndoOutcome that POST /api/undo returned for { actionId, depth }: membership and hops
 * from Q1, the counts from Q3 (blast radius), the other agents from Q7. Moving the slider asks
 * again at the new depth; nothing is executed.
 */
import { cn } from 'cn';
import { Hourglass, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { agentName } from '@/lib/tools';
import { MAX_DEPTH, MIN_DEPTH, useSelection } from './SelectionProvider';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function BlastChip({
  root,
  className,
  children,
}: {
  /** The selected action as the snapshot names it. */
  root: { tool: string; seq: number | undefined };
  className?: string;
  /** Extra actions for the selection (the explain button). */
  children?: React.ReactNode;
}) {
  const { closure, status, error, depth, setDepth, select, rejected, retry } = useSelection();
  // The thumb follows the drag; the query runs once on release (or per key press), because each
  // ask proposes a plan and dragging 1 → 5 should not propose four of them.
  const [dragDepth, setDragDepth] = useState(depth);
  useEffect(() => setDragDepth(depth), [depth]);

  const blast = closure?.blast ?? null;
  const fresh = closure !== null && closure.depth === depth;

  return (
    <section
      aria-label="Blast radius of the selected action"
      className={cn('flex flex-col gap-3 rounded-lg border bg-surface p-3', className)}
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 truncate font-medium text-sm">
          Undoing <span className="font-mono text-code">{root.tool}</span>
          {root.seq !== undefined ? (
            <span className="font-mono font-normal text-fg-muted text-xs"> seq {root.seq}</span>
          ) : null}
        </h3>
        {/* Static on purpose: only the pending pulse may loop (PLAN §7.3), so no spinner. */}
        {status === 'loading' ? (
          <Hourglass
            role="img"
            aria-label="Asking the graph"
            className="size-3.5 shrink-0 text-fg-muted"
          />
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {children}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear the selection"
            onClick={() => select(null)}
          >
            <X aria-hidden />
          </Button>
        </div>
      </div>

      <div aria-live="polite" className={cn('min-h-5 text-sm', !fresh && 'text-fg-muted')}>
        {status === 'error' ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-red">
            {error}
            <Button variant="secondary" size="xs" onClick={retry}>
              <RotateCw aria-hidden />
              Ask again
            </Button>
          </p>
        ) : blast ? (
          <p>
            {plural(blast.actions, 'action')} ·{' '}
            <span className={cn(blast.irreversible > 0 && 'text-red')}>
              {blast.irreversible} irreversible
            </span>{' '}
            · {plural(blast.entities.length, 'entity', 'entities')}
            {closure && closure.crossAgents.length > 0 ? (
              <span className="text-fg-muted">
                {' '}
                · reaches {closure.crossAgents.map((a) => agentName[a] ?? a).join(', ')}
              </span>
            ) : null}
          </p>
        ) : closure?.note ? (
          <p className="text-fg-muted">{closure.note}</p>
        ) : (
          <p className="text-fg-muted">Asking the graph…</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <label htmlFor="blast-depth" className="shrink-0 text-fg-muted text-xs">
          Depth <span className="font-mono text-fg">{dragDepth}</span>
        </label>
        <Slider
          id="blast-depth"
          aria-label="Dependency depth"
          min={MIN_DEPTH}
          max={MAX_DEPTH}
          step={1}
          value={[dragDepth]}
          onValueChange={([v]) => v !== undefined && setDragDepth(v)}
          onValueCommit={([v]) => v !== undefined && setDepth(v)}
          className="max-w-56"
        />
        <span className="shrink-0 font-mono text-fg-muted text-xs">
          {MIN_DEPTH}–{MAX_DEPTH} hops
        </span>
      </div>

      {/* The slider went back to the depth on screen; this says which depth was refused and why. */}
      {rejected ? (
        <p role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-red">
            Depth {rejected.depth} was not applied: {rejected.message}
          </span>
          <span className="text-fg-muted">Still showing depth {depth}.</span>
          <Button variant="secondary" size="xs" onClick={() => setDepth(rejected.depth)}>
            <RotateCw aria-hidden />
            Try depth {rejected.depth} again
          </Button>
        </p>
      ) : null}

      <p className="font-mono text-fg-muted text-xs">
        POST /api/undo · Q1 closure, Q3 blast radius, Q7 other agents · depth{' '}
        {closure?.depth ?? depth}
        {closure?.planId ? ` · proposed ${closure.planId}, nothing executed` : ''}
      </p>
    </section>
  );
}
