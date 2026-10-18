/**
 * The undo console's behaviour: ⌘Z picks the last change still in force and leaves text fields
 * alone, the four outcomes come back for the requests the demo makes, and the checklist ticks only
 * when undo.step events say so.
 */
import type { RunEvent, UndoPlan } from '@backtrack/core/contracts';
import { describe, expect, it } from 'vitest';
import { MockApiClient } from '../lib/mock';
import { initialSession, type SessionState, sessionReducer } from '../lib/session';
import {
  executionCounts,
  isEditableTarget,
  isUndoShortcut,
  lastUndoableAction,
  planFollowsDepth,
  planPhase,
  planStepStates,
} from '../lib/undo';

async function goldenClient() {
  const client = new MockApiClient({ stepDelayMs: 0, undoStepDelayMs: 0 });
  for (const agent of ['ops-agent', 'billing-agent'] as const) {
    for await (const e of client.runAgent({ agent, mode: 'replay' })) {
      if (e.type === 'approval.requested') {
        await client.approval({ runId: e.runId, actionId: e.actionId, approved: true });
      }
    }
  }
  return client;
}

async function planFor(client: MockApiClient, text: string): Promise<UndoPlan> {
  const outcome = await client.undo({ text, depth: 5 });
  if (outcome.kind !== 'plan') throw new Error(`expected a plan, got ${outcome.kind}`);
  return outcome.plan;
}

const key = (
  k: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>>,
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('⌘Z', () => {
  it('is ⌘Z or Ctrl+Z, never redo or an Alt chord', () => {
    expect(isUndoShortcut(key('z', { metaKey: true }))).toBe(true);
    expect(isUndoShortcut(key('z', { ctrlKey: true }))).toBe(true);
    expect(isUndoShortcut(key('Z', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isUndoShortcut(key('z', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isUndoShortcut(key('z', {}))).toBe(false);
    expect(isUndoShortcut(key('y', { metaKey: true }))).toBe(false);
  });

  it('leaves text editing alone but takes it from buttons and the page', () => {
    expect(isEditableTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget({ tagName: 'BODY' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('prefills the latest change still in force, skipping lookups, undo actions and undone ones', async () => {
    const client = await goldenClient();
    expect(lastUndoableAction(null)).toBeNull();
    const last = lastUndoableAction(await client.graph());
    expect(last).toMatchObject({ tool: 'apply_credit', text: 'undo apply_credit (seq 9)' });

    const plan = await planFor(client, 'undo the address change');
    for await (const _ of client.executeUndo(plan.id)) {
      // drain
    }
    // Every reversible change is undone now. The email was mitigated, not unsent, so it is still
    // done and is the latest change in force; lookups and undo actions never qualify.
    expect(lastUndoableAction(await client.graph())).toMatchObject({ tool: 'send_email', seq: 5 });
  });
});

describe('undo outcomes', () => {
  it('returns plan, none, unknown and memory for the requests the console sends', async () => {
    const client = await goldenClient();
    expect((await client.undo({ text: 'undo the weather' })).kind).toBe('unknown');
    const last = lastUndoableAction(await client.graph());
    if (!last) throw new Error('expected an action');
    // Nothing depends on the latest change, so its plan is that one step (as the engine plans it).
    const leaf = await client.undo({ actionId: last.actionId });
    expect(leaf.kind === 'plan' && leaf.plan.steps.map((s) => s.tool)).toEqual(['apply_credit']);
    const lookups = (await client.actions()).actions.filter((a) => a.tool === 'lookup_order');
    expect((await client.undo({ actionId: lookups[0]?.id })).kind).toBe('none');

    const plan = await planFor(client, 'undo the address change');
    for await (const _ of client.executeUndo(plan.id)) {
      // drain
    }
    const again = await client.undo({ text: 'undo the address change' });
    expect(again.kind).toBe('memory');
    expect(again.kind === 'memory' && again.priorPlans.map((p) => p.id)).toEqual([plan.id]);
  });
});

describe('plan checklist', () => {
  it('ticks each step only when its undo.step event arrives', async () => {
    const client = await goldenClient();
    const plan = await planFor(client, 'undo the address change');
    expect(planPhase(plan, null, false)).toBe('proposed');
    expect(planPhase(plan, null, true)).toBe('rehearsed');
    expect([...planStepStates(plan, null).values()].every((s) => s === 'queued')).toBe(true);

    let session: SessionState = initialSession;
    const seen: string[][] = [];
    for await (const event of client.executeUndo(plan.id)) {
      session = sessionReducer(session, event as RunEvent);
      seen.push([...planStepStates(plan, session.undo).values()]);
    }

    // First event: step 1 started, nothing else moved.
    expect(seen[0]).toEqual(['running', 'queued', 'queued', 'queued', 'queued', 'queued']);
    // Second event: step 1 done (apply_credit reverted), step 2 still waiting.
    expect(seen[1]).toEqual(['reverted', 'queued', 'queued', 'queued', 'queued', 'queued']);
    // The email cannot be unsent: its done step is a recorded mitigation, not a revert.
    expect(seen.at(-1)).toEqual([
      'reverted',
      'reverted',
      'mitigated',
      'reverted',
      'reverted',
      'reverted',
    ]);
    expect(planPhase(plan, session.undo, false)).toBe('executed');
    expect(executionCounts(planStepStates(plan, session.undo))).toEqual({
      reverted: 5,
      mitigated: 1,
      conflict: 0,
      skipped: 0,
      finished: 6,
    });
  });

  it('ignores events for another plan', async () => {
    const client = await goldenClient();
    const plan = await planFor(client, 'undo the address change');
    const other = sessionReducer(initialSession, {
      type: 'undo.step',
      planId: 'plan_other',
      order: 1,
      actionId: 'act_x',
      mode: 'restore',
      status: 'done',
      label: 'x',
      entity: null,
    });
    expect(planStepStates(plan, other.undo).get(1)).toBe('queued');
    expect(planPhase(plan, other.undo, false)).toBe('proposed');
  });
});

describe('one depth for the panel', () => {
  it('re-plans a proposal when the slider moves, and leaves executed plans alone', async () => {
    const client = await goldenClient();
    const outcome = await client.undo({ text: 'undo the address change', depth: 1 });
    if (outcome.kind !== 'plan') throw new Error('expected a plan');
    const root = outcome.plan.rootActionId;
    expect(planFollowsDepth(outcome, 1, null)).toBeNull();
    expect(planFollowsDepth(outcome, 3, null)).toBe(root);

    // Asking at the new depth answers the plan for that depth, which then stops following.
    const wider = await client.undo({ actionId: root, depth: 3 });
    expect(wider.kind === 'plan' && wider.plan.steps.map((s) => s.tool)).toContain('apply_credit');
    expect(planFollowsDepth(wider, 3, null)).toBeNull();

    // Once confirmed, the card records what ran at its own depth.
    let session: SessionState = initialSession;
    for await (const e of client.executeUndo(outcome.plan.id)) session = sessionReducer(session, e);
    expect(planFollowsDepth(outcome, 3, session.undo)).toBeNull();
    expect(planFollowsDepth({ kind: 'none', actionId: root, reason: 'r' }, 3, null)).toBeNull();
  });
});
