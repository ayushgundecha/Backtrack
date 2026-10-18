'use client';

import { Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
/**
 * Center column, bottom: ask for an undo in plain words (or press ⌘Z anywhere for the last action)
 * and see which of the four honest outcomes the engine returned: a plan to rehearse and confirm,
 * a memory of an earlier undo, nothing to undo, or no matching action with the closest candidates.
 */
import type { UndoRequest } from '@/lib/api';
import {
  isEditableTarget,
  isUndoShortcut,
  lastUndoableAction,
  planFollowsDepth,
  type UndoTarget,
} from '@/lib/undo';
import { useBacktrack } from './BacktrackProvider';
import { PlanCard } from './PlanCard';
import { useSelection } from './SelectionProvider';
import { MemoryCard, NoneCard, UnknownCard } from './UndoOutcomes';

/** ⌘ on Apple platforms, Ctrl elsewhere; decided after mount so server and client HTML match. */
function useShortcutLabel() {
  const [label, setLabel] = useState('Ctrl+Z');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setLabel('⌘Z');
  }, []);
  return label;
}

export function UndoConsole() {
  const { state, actions } = useBacktrack();
  // One depth for the whole panel (PLAN §7.3): the blast chip's slider sets it, and every plan
  // the console asks for uses it, so the plan card and the lit closure always agree.
  const { depth, select } = useSelection();
  const [text, setText] = useState('');
  // Set by ⌘Z: while the text is exactly the prefill, the request names the action by id.
  const [target, setTarget] = useState<UndoTarget | null>(null);
  const [planning, setPlanning] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const shortcut = useShortcutLabel();
  const hasActions = (state.graph?.nodes ?? []).some((n) => n.label === 'Action');
  const busy = planning || state.streaming;

  // The latest graph without re-binding the key listener on every refresh.
  const graph = useRef(state.graph);
  useEffect(() => {
    graph.current = state.graph;
  }, [state.graph]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isUndoShortcut(event)) return;
      const focused = event.target instanceof HTMLElement ? event.target : null;
      // Text fields keep their own undo, and an open dialog owns the keyboard.
      if (isEditableTarget(focused) || focused?.closest('[role="dialog"]')) return;
      event.preventDefault();
      const last = lastUndoableAction(graph.current);
      if (last) {
        setText(last.text);
        setTarget(last);
      }
      // Selected, so typing replaces the prefill and Enter plans it as is.
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const plan = async (request: UndoRequest) => {
    setPlanning(true);
    const outcome = await actions.requestUndo({ ...request, depth });
    setPlanning(false);
    // Select what the plan is about, so the graph lights its closure and the blast chip (with
    // the depth slider) is there to widen it.
    if (outcome && outcome.kind !== 'unknown') {
      select(outcome.kind === 'plan' ? outcome.plan.rootActionId : outcome.actionId);
    }
  };

  // Moving the slider re-plans a plan that is still only a proposal at the new depth.
  const outcome = state.undoOutcome;
  const follow = planFollowsDepth(outcome, depth, state.session.undo);
  const replan = useRef(actions.requestUndo);
  replan.current = actions.requestUndo;
  useEffect(() => {
    if (follow) void replan.current({ actionId: follow, depth });
  }, [follow, depth]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const words = text.trim();
    if (!words) return;
    void plan(target && text === target.text ? { actionId: target.actionId } : { text: words });
  };

  // One short announcement per outcome; the plan card announces its own execution progress.
  const announcement = !outcome
    ? ''
    : outcome.kind === 'plan'
      ? `Undo plan with ${outcome.plan.steps.length} steps`
      : outcome.kind === 'memory'
        ? 'Already undone before'
        : outcome.kind === 'none'
          ? 'No plan needed'
          : 'No matching action';
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="undo-request" className="text-fg-muted text-xs">
            Describe what to undo
          </label>
          {/* The shortcut needs a keyboard; on narrow (touch) screens the hint is noise. */}
          <p className="hidden text-fg-muted text-xs sm:block">
            <kbd className="rounded-sm border bg-surface-2 px-1 font-mono">{shortcut}</kbd> anywhere
            picks the last action
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={input}
            id="undo-request"
            name="undo-request"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="undo the address change…"
            className="h-9 min-w-0 flex-1 rounded-lg border bg-bg px-3 text-sm placeholder:text-fg-muted"
          />
          <Button
            type="submit"
            size="lg"
            variant="secondary"
            disabled={!hasActions || busy || !text.trim()}
          >
            <Undo2 aria-hidden />
            {planning ? 'Planning…' : 'Plan undo'}
          </Button>
        </div>
      </form>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <div className="min-h-0">
        {/* relative: sr-only text inside is positioned against this scroller, not the page. */}
        {outcome ? (
          <div className="fade-in-0 relative animate-in overflow-y-auto rounded-lg border bg-surface p-3 duration-200 lg:max-h-[55dvh]">
            {outcome.kind === 'plan' ? (
              <PlanCard key={outcome.plan.id} plan={outcome.plan} />
            ) : outcome.kind === 'memory' ? (
              <MemoryCard outcome={outcome} />
            ) : outcome.kind === 'none' ? (
              <NoneCard outcome={outcome} />
            ) : (
              <UnknownCard
                outcome={outcome}
                disabled={busy}
                onPick={(actionId) => void plan({ actionId })}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
