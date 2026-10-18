'use client';

import type { RehearsalDiff, UndoPlan, UndoStep } from '@backtrack/core/contracts';
import {
  Ban,
  Check,
  CircleDot,
  FlaskConical,
  Minus,
  TriangleAlert,
  Undo2,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { agentName } from '@/lib/tools';
import { executionCounts, planPhase, planStepStates, type StepState } from '@/lib/undo';
import { useBacktrack } from './BacktrackProvider';
import { useSelection } from './SelectionProvider';
import { StatusBadge } from './StatusBadge';

/** Icon for a step before it runs: ↩ revert, ⚠ irreversible (gets a mitigation), else neutral. */
function ModeIcon({ mode }: { mode: UndoStep['mode'] }) {
  if (mode === 'mitigation')
    return <TriangleAlert aria-hidden className="size-4 shrink-0 text-red" />;
  if (mode === 'conflict') return <Ban aria-hidden className="size-4 shrink-0 text-red" />;
  if (mode === 'skip') return <Minus aria-hidden className="size-4 shrink-0 text-fg-muted" />;
  return <Undo2 aria-hidden className="size-4 shrink-0 text-fg-muted" />;
}

/** Icon and words for a step once the executor has reported on it (undo.step events only). */
const stateView: Record<Exclude<StepState, 'queued'>, { label: string; className: string }> = {
  running: { label: 'Reverting', className: 'text-accent' },
  reverted: { label: 'Reverted', className: 'text-green' },
  mitigated: { label: 'Mitigated', className: 'text-fg-muted' },
  conflict: { label: 'Conflict, left as is', className: 'text-red' },
  skipped: { label: 'Skipped', className: 'text-fg-muted' },
};

function StateIcon({ state, mode }: { state: StepState; mode: UndoStep['mode'] }) {
  // One motion per change: the tick zooms in once when its undo.step done event lands.
  const enter = 'zoom-in-50 fade-in-0 animate-in duration-200';
  switch (state) {
    case 'queued':
      return <ModeIcon mode={mode} />;
    case 'running':
      return <CircleDot aria-hidden className="size-4 shrink-0 text-accent" />;
    case 'reverted':
      return <Check aria-hidden className={`size-4 shrink-0 text-green ${enter}`} />;
    case 'mitigated':
      return <TriangleAlert aria-hidden className={`size-4 shrink-0 text-red ${enter}`} />;
    case 'conflict':
      return <X aria-hidden className={`size-4 shrink-0 text-red ${enter}`} />;
    case 'skipped':
      return <Minus aria-hidden className="size-4 shrink-0 text-fg-muted" />;
  }
}

const show = (value: unknown) =>
  value === null || value === undefined
    ? 'none'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

/** The rehearsal: what the world would look like after the undo, computed on a forked graph. */
function DiffCard({ diff }: { diff: RehearsalDiff }) {
  return (
    <section
      aria-label="Rehearsal diff"
      className="fade-in-0 flex animate-in flex-col gap-2 rounded-md border bg-bg p-3 duration-200"
    >
      <h5 className="flex items-center gap-2 font-medium text-sm">
        <FlaskConical aria-hidden className="size-4 text-fg-muted" />
        Rehearsal: {diff.changes.length} {diff.changes.length === 1 ? 'change' : 'changes'}
      </h5>
      <p className="text-fg-muted text-xs">
        Ran on the fork <span className="font-mono">{diff.forkGraph}</span> (GRAPH.COPY), diffed
        with Q15. The live graph is untouched until you confirm.
      </p>
      {diff.changes.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {diff.changes.map((change) => {
            const where = `${change.entity.type}:${change.entity.key}`;
            const key = `${where}.${change.field ?? '*'}`;
            // A null field means the whole entity appears or disappears (a create or delete undone).
            const verdict =
              change.field === null
                ? change.to === null
                  ? 'removed'
                  : change.from === null
                    ? 'added'
                    : 'replaced'
                : null;
            return (
              <li key={key} className="flex flex-col gap-0.5 font-mono text-code">
                <span className="text-fg">
                  {where}
                  {change.field ? <span className="text-fg-muted">.{change.field}</span> : null}
                </span>
                {verdict ? (
                  <span className="text-fg-muted">{verdict}</span>
                ) : (
                  <span className="break-words text-fg-muted">
                    <span className="line-through decoration-fg-muted/60">{show(change.from)}</span>
                    <span aria-hidden> → </span>
                    <span className="sr-only"> becomes </span>
                    <span className="text-green">{show(change.to)}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** Root-to-dependent tool path (UndoStep.via, the Q1 row): why this step is in the plan. */
function ViaPath({ via }: { via: string[] }) {
  if (via.length < 2) return null;
  return (
    <span className="break-words font-mono text-fg-muted text-xs [font-variant-ligatures:none]">
      {via.join(' → ')}
    </span>
  );
}

/**
 * Scrolls a descendant into view, instantly: the tick or the diff card already animates for this
 * change, and a smooth scroll (of browser-chosen length) would be a second motion (PLAN §7.3).
 */
function reveal(root: HTMLElement | null, selector: string) {
  root?.querySelector(selector)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

/**
 * Plan outcome: the ordered checklist (seq DESC), the cross-agent line, Rehearse and Confirm.
 * Execution ticks come from undo.step events in the session, so the list moves exactly when the
 * graph and world do.
 */
export function PlanCard({ plan }: { plan: UndoPlan }) {
  const { state, actions } = useBacktrack();
  const { rejected } = useSelection();
  const [diff, setDiff] = useState<RehearsalDiff | null>(null);
  const [rehearsing, setRehearsing] = useState(false);
  const [showPaths, setShowPaths] = useState(false);
  const section = useRef<HTMLElement>(null);
  const rehearsal = diff?.planId === plan.id ? diff : null;

  const execution = state.session.undo;
  const states = planStepStates(plan, execution);
  const phase = planPhase(plan, execution, rehearsal !== null);
  const counts = executionCounts(states);
  const started = phase !== 'proposed' && phase !== 'rehearsed';
  const busy = state.streaming || rehearsing;
  const viaOf = new Map(plan.steps.map((s) => [s.actionId, s.via]));
  const { blast } = plan;

  // Keep the step being reverted (and a fresh diff) in view inside the scrolling console.
  const running = [...states].find(([, s]) => s === 'running')?.[0] ?? null;
  useEffect(() => {
    if (running !== null) reveal(section.current, '[aria-current="step"]');
  }, [running]);
  useEffect(() => {
    if (rehearsal) reveal(section.current, '[aria-label="Rehearsal diff"]');
  }, [rehearsal]);

  const rehearse = async () => {
    setRehearsing(true);
    setDiff(await actions.rehearseUndo(plan.id));
    setRehearsing(false);
  };

  return (
    <section ref={section} aria-label={`Undo plan ${plan.id}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h4 className="font-medium">Undo plan</h4>
          <span className="font-mono text-fg-muted text-xs">{plan.id}</span>
          <StatusBadge status={phase} className="ml-auto" />
        </div>
        <p className="text-fg-muted text-sm">{plan.summary}</p>
      </header>

      {/*
        Depth has one control, the blast chip's slider in the graph (PLAN §7.3); a proposed plan
        is re-asked at the slider's depth, so this line only reports the depth it was planned at.
      */}
      <p className="text-fg-muted text-xs">
        <span className="font-mono">
          {blast.actions} actions · {blast.irreversible} irreversible · {blast.entities.length}{' '}
          entities · depth {plan.depth}
        </span>{' '}
        (Q3 blast radius
        {started ? ')' : '; the depth slider in the graph changes it)'}
      </p>
      {/* A refused re-plan leaves this plan as it was; say so here too, not only by the slider. */}
      {!started && rejected && rejected.depth !== plan.depth ? (
        <p className="text-sm">
          <span className="text-red">
            Re-planning at depth {rejected.depth} failed: {rejected.message}
          </span>{' '}
          <span className="text-fg-muted">This plan is still the depth {plan.depth} one.</span>
        </p>
      ) : null}

      {/* Cross-agent reach first: it is the line a reviewer most needs before confirming. */}
      {plan.crossAgent.map((c) => (
        <p key={c.actionId} className="flex items-start gap-2 text-sm">
          <Users aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
          <span>
            Reaches {agentName[c.agentId] ?? c.agentId}: <span className="font-mono">{c.tool}</span>
            , {c.hops} {c.hops === 1 ? 'hop' : 'hops'} away{' '}
            <span className="text-fg-muted text-xs">(Q7 cross-agent)</span>
            {viaOf.get(c.actionId) ? (
              <span className="block">
                <ViaPath via={viaOf.get(c.actionId) ?? []} />
              </span>
            ) : null}
          </span>
        </p>
      ))}

      <ol aria-label="Undo steps, newest first" className="flex flex-col">
        {plan.steps.map((step) => {
          const stepState = states.get(step.order) ?? 'queued';
          const view = stepState === 'queued' ? null : stateView[stepState];
          const crossAgent = plan.crossAgent.some((c) => c.actionId === step.actionId);
          return (
            <li
              key={step.order}
              className="flex items-start gap-2.5 border-b py-1.5 last:border-b-0"
              aria-current={stepState === 'running' ? 'step' : undefined}
            >
              <span className="w-4 pt-0.5 text-right font-mono text-fg-muted text-xs">
                {step.order}
              </span>
              <span className="pt-0.5">
                <StateIcon state={stepState} mode={step.mode} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 font-mono text-code [overflow-wrap:anywhere]">
                    {step.label}
                  </span>
                  <span className="text-fg-muted text-xs">
                    seq {step.seq}
                    {crossAgent ? ` · ${agentName[step.agentId] ?? step.agentId}` : ''}
                    {step.mode === 'mitigation' ? (
                      <span className="text-red"> · irreversible</span>
                    ) : null}
                  </span>
                </span>
                {showPaths ? <ViaPath via={step.via} /> : null}
              </span>
              {view ? (
                <span className={`shrink-0 pt-0.5 text-xs ${view.className}`}>
                  {stepState === 'running' && step.mode === 'mitigation'
                    ? 'Mitigating'
                    : view.label}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {/* Paths are the evidence for each step; folded by default so the checklist stays short. */}
      {plan.steps.some((s) => s.via.length > 1) ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="self-start text-fg-muted"
          aria-expanded={showPaths}
          onClick={() => setShowPaths((v) => !v)}
        >
          {showPaths ? 'Hide dependency paths' : 'Show dependency paths (Q1)'}
        </Button>
      ) : null}

      {rehearsal ? <DiffCard diff={rehearsal} /> : null}

      {/* Sticky so Rehearse and Confirm (then the progress line) stay in view however long the plan. */}
      <div className="sticky -bottom-3 -mx-3 -mb-3 flex min-h-15 flex-wrap items-center gap-2 border-t bg-surface px-3 py-3">
        {started ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-live="polite">
            <StatusBadge status={phase} />
            {phase === 'executing'
              ? `${counts.finished} of ${plan.steps.length} steps done`
              : `${counts.reverted} reverted, ${counts.mitigated} mitigated, ${counts.conflict} in conflict, ${counts.skipped} skipped`}
            {/* The counts are the executor's own undo.step events, not a client tally. */}
            <span className="font-mono text-fg-muted text-xs">
              undo.step events · POST /api/undo/execute
            </span>
          </p>
        ) : (
          <>
            <Button type="button" size="lg" variant="secondary" disabled={busy} onClick={rehearse}>
              <FlaskConical aria-hidden />
              {rehearsing ? 'Rehearsing…' : rehearsal ? 'Rehearse again' : 'Rehearse'}
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={busy}
              onClick={() => void actions.executeUndo(plan.id)}
            >
              <Undo2 aria-hidden />
              Confirm undo
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
