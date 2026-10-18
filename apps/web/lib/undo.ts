/**
 * Pure logic behind the undo console: which action ⌘Z prefills, when ⌘Z belongs to us rather than
 * to a text field, and how undo.step events map onto the plan's checklist. Framework-free so it is
 * unit-tested; the components only render what these return.
 */
import type { GraphSnapshot, UndoOutcome, UndoPlan } from '@backtrack/core/contracts';
import type { UndoExecutionView } from './session';

export interface UndoTarget {
  actionId: string;
  tool: string;
  seq: number;
  /** The text placed in the console; submitting it unchanged sends the actionId, not the text. */
  text: string;
}

/**
 * The most recent action that changed something and is still in force: a `do` action with status
 * done and at least one CAUSED edge (a lookup has nothing to undo), highest seq. Read from the
 * graph snapshot, so it is whatever the graph says, not what the UI remembers.
 */
export function lastUndoableAction(graph: GraphSnapshot | null): UndoTarget | null {
  let best: UndoTarget | null = null;
  const changed = new Set(
    (graph?.links ?? []).filter((l) => l.type === 'CAUSED').map((l) => l.source),
  );
  for (const node of graph?.nodes ?? []) {
    if (node.label !== 'Action' || node.kind !== 'do' || node.status !== 'done') continue;
    if (!changed.has(node.id)) continue;
    if (node.seq === undefined || !node.tool) continue;
    if (!best || node.seq > best.seq) {
      best = {
        actionId: node.id,
        tool: node.tool,
        seq: node.seq,
        text: `undo ${node.tool} (seq ${node.seq})`,
      };
    }
  }
  return best;
}

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** ⌘Z on macOS or Ctrl+Z elsewhere; ⇧⌘Z (redo) and chords with Alt are left alone. */
export function isUndoShortcut(e: KeyLike): boolean {
  return e.key.toLowerCase() === 'z' && e.metaKey !== e.ctrlKey && !e.shiftKey && !e.altKey;
}

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
}

/** Input types where ⌘Z is not text undo, so the console may take it. */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'radio',
  'range',
  'submit',
  'reset',
  'file',
]);

/** True when ⌘Z should stay native: the user is editing text and expects their own undo. */
export function isEditableTarget(target: TargetLike | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase());
  return false;
}

export type StepState = 'queued' | 'running' | 'reverted' | 'mitigated' | 'conflict' | 'skipped';

/**
 * The checklist state of each plan step, driven only by undo.step events for this plan: nothing
 * ticks on a timer, so the list can never run ahead of what the executor reported.
 */
export function planStepStates(
  plan: UndoPlan,
  execution: UndoExecutionView | null,
): Map<number, StepState> {
  const states = new Map<number, StepState>();
  const events = execution?.planId === plan.id ? execution.steps : {};
  for (const step of plan.steps) {
    const event = events[step.order];
    let state: StepState = 'queued';
    if (event?.status === 'started') state = 'running';
    else if (event?.status === 'conflict') state = 'conflict';
    else if (event?.status === 'skipped') state = 'skipped';
    // A done mitigation did not revert anything: it recorded a correction (COULD_NOT_REVERT).
    else if (event?.status === 'done')
      state = event.mode === 'mitigation' ? 'mitigated' : 'reverted';
    states.set(step.order, state);
  }
  return states;
}

export type PlanPhase =
  | 'proposed'
  | 'rehearsed'
  | 'executing'
  | 'executed'
  | 'partial'
  | 'conflict';

/** What the plan card's status pill says: the executor's verdict wins over the proposal. */
export function planPhase(
  plan: UndoPlan,
  execution: UndoExecutionView | null,
  rehearsed: boolean,
): PlanPhase {
  if (execution?.planId === plan.id) {
    return execution.status === 'running' ? 'executing' : execution.status;
  }
  if (plan.status === 'proposed' && rehearsed) return 'rehearsed';
  return plan.status;
}

/** Counts of finished steps by outcome, for the line under the checklist. */
export function executionCounts(states: Map<number, StepState>) {
  const counts = { reverted: 0, mitigated: 0, conflict: 0, skipped: 0, finished: 0 };
  for (const state of states.values()) {
    if (state === 'queued' || state === 'running') continue;
    counts[state] += 1;
    counts.finished += 1;
  }
  return counts;
}

/**
 * The root to re-plan when the shared depth moves, or null. Only a plan that is still a proposal
 * follows the slider: once it is executing or done, the card is a record of what ran at its own
 * depth and must not be swapped for a different plan.
 */
export function planFollowsDepth(
  outcome: UndoOutcome | null,
  depth: number,
  execution: UndoExecutionView | null,
): string | null {
  if (outcome?.kind !== 'plan') return null;
  const { plan } = outcome;
  if (plan.depth === depth || plan.status !== 'proposed') return null;
  if (execution?.planId === plan.id) return null;
  return plan.rootActionId;
}
