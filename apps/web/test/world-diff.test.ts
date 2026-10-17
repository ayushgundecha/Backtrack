import type { RunEvent, WorldSnapshot } from '@backtrack/core/contracts';
import { describe, expect, it } from 'vitest';
import { MockApiClient } from '../lib/mock';
import { initialSession, type SessionState, sessionReducer } from '../lib/session';
import { diffWorld, isEmptyDiff, isRevert, undoProgress, type WorldDiff } from '../lib/world-diff';

const seed = (asOfSeq: number | null = null): WorldSnapshot => ({
  tenant: 'demo',
  asOfSeq,
  entities: [
    { type: 'order', key: 'ord_1', display: 'ord_1', state: { address: 'A', items: ['x'] } },
  ],
});

describe('diffWorld', () => {
  it('animates nothing on the first read, another tenant, or another point in time', () => {
    expect(diffWorld(null, seed(), false)).toBeNull();
    expect(diffWorld(seed(), { ...seed(), tenant: 'acme' }, false)).toBeNull();
    // The time scrubber moving is travel through history, not a change to the world.
    expect(diffWorld(seed(), { ...seed(4), entities: [] }, false)).toBeNull();
  });

  it('finds changed fields, creates and deletes, and ignores key order', () => {
    const next: WorldSnapshot = {
      ...seed(),
      entities: [
        { type: 'order', key: 'ord_1', display: 'ord_1', state: { items: ['x'], address: 'B' } },
        { type: 'ticket', key: 'tkt_1', display: 'tkt_1', state: { status: 'open' } },
      ],
    };
    expect(diffWorld(seed(), next, false)).toEqual({
      created: ['ticket:tkt_1'],
      deleted: [],
      fields: { 'order:ord_1': { address: 'changed' } },
    });
    expect(diffWorld(next, seed(), true)).toEqual({
      created: [],
      deleted: ['ticket:tkt_1'],
      fields: { 'order:ord_1': { address: 'restored' } },
    });
    expect(isEmptyDiff(diffWorld(seed(), seed(), false))).toBe(true);
  });
});

describe('isRevert', () => {
  it('is true only when an undo step finished since the previous read', () => {
    expect(isRevert('', '')).toBe(false);
    expect(isRevert('plan_1:1', 'plan_1:1')).toBe(false);
    expect(isRevert('plan_1:1', 'plan_1:2')).toBe(true);
    expect(isRevert('', 'plan_2:1')).toBe(true);
    // A world reset clears the undo: what changes then is the seed coming back, not a revert.
    expect(isRevert('plan_1:4', '')).toBe(false);
  });
});

/** Replays what the panel sees: every event folded into the session, the world read after each. */
async function watch(
  client: MockApiClient,
  events: AsyncIterable<RunEvent>,
  from: { session: SessionState; world: WorldSnapshot },
) {
  let { session, world } = from;
  let progress = undoProgress(session);
  const diffs: WorldDiff[] = [];
  for await (const event of events) {
    if (event.type === 'approval.requested') {
      void client.approval({ runId: event.runId, actionId: event.actionId, approved: true });
    }
    session = sessionReducer(session, event);
    const next = await client.world();
    const now = undoProgress(session);
    const diff = diffWorld(world, next, isRevert(progress, now));
    if (diff && !isEmptyDiff(diff)) diffs.push(diff);
    world = next;
    progress = now;
  }
  return { session, world, diffs };
}

describe('world flashes over the golden run and its undo', () => {
  it('flashes the agent change blue and the undo of it green, collapsing what the undo removed', async () => {
    const client = new MockApiClient({ stepDelayMs: 0, undoStepDelayMs: 0 });
    const start = { session: initialSession, world: await client.world() };
    const run = await watch(client, client.runAgent({ agent: 'ops-agent', mode: 'replay' }), start);

    const all = run.diffs;
    expect(all.some((d) => d.fields['order:ord_1001']?.address === 'changed')).toBe(true);
    expect(all.flatMap((d) => d.created)).toContain('message:msg_1');
    expect(all.flatMap((d) => Object.values(d.fields).flatMap(Object.values))).not.toContain(
      'restored',
    );

    const graph = await client.graph();
    const root = graph.nodes.find((n) => n.tool === 'update_address')?.id as string;
    const outcome = await client.undo({ actionId: root, depth: 2 });
    if (outcome.kind !== 'plan') throw new Error(`expected a plan, got ${outcome.kind}`);
    const undo = await watch(client, client.executeUndo(outcome.plan.id), run);

    const fields = undo.diffs.flatMap((d) => Object.values(d.fields).flatMap(Object.values));
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => f === 'restored')).toBe(true);
    expect(undo.diffs.some((d) => d.fields['order:ord_1001']?.address === 'restored')).toBe(true);
    expect(undo.diffs.flatMap((d) => d.deleted)).toContain('message:msg_1');
  });
});
