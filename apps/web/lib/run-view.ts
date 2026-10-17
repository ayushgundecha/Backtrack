/**
 * Pure helpers the run stream renders from: what a step called (even before it was recorded) and
 * how to name the actions it depends on. Kept out of the components so they are unit-tested.
 */
import type { SessionState, StepView } from './session';

export interface StepCall {
  tool: string;
  args: Record<string, unknown>;
  /** The step's action id once an event has named it (recorded, gated or blocked). */
  actionId: string | null;
}

/**
 * The tool call a step made. A recorded action is the authority; a gated call is known from
 * approval.requested and a blocked one from action.blocked, before (or instead of) being recorded.
 */
export function stepCall(step: StepView): StepCall | null {
  if (step.action) {
    return { tool: step.action.tool, args: step.action.args, actionId: step.action.id };
  }
  if (step.approval) {
    return { tool: step.approval.tool, args: step.approval.args, actionId: step.approval.actionId };
  }
  if (step.blocked) return { tool: step.blocked.tool, args: {}, actionId: step.blocked.actionId };
  return null;
}

export type StepPhase = 'calling' | 'awaiting-approval' | 'denied' | 'blocked' | 'recorded';

/** Where a step is in its life, from the events seen so far. */
export function stepPhase(step: StepView): StepPhase {
  if (step.action) return 'recorded';
  if (step.blocked) return 'blocked';
  if (step.approval?.state === 'denied') return 'denied';
  if (step.approval) return 'awaiting-approval';
  return 'calling';
}

export interface ActionRef {
  tool: string;
  seq: number;
}

/** Action id → tool and seq, from every action.recorded event in the session. */
export function recordedActions(state: SessionState): Map<string, ActionRef> {
  const refs = new Map<string, ActionRef>();
  for (const step of state.steps) {
    if (step.action) refs.set(step.action.id, { tool: step.action.tool, seq: step.action.seq });
  }
  return refs;
}

/** `key: value` pairs on one line, values as JSON so strings and numbers stay distinguishable. */
export function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
}
