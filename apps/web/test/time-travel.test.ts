/**
 * BT-047: the time scrubber's stops, what dims at seq N, and the mock's fold. The mock must fold
 * the way the real worldSnapshot does (later Effects rolled back by their `before`, newest
 * first); time-travel-routes.test.ts checks the two against each other on a real FalkorDB.
 */
import type { GraphSnapshot, RunEvent, WorldSnapshot } from '@backtrack/core/contracts';
import { describe, expect, it } from 'vitest';
import { MockApiClient } from '../lib/mock';
import { laterNodes, stopIndex, stopLabel, stops, timeline } from '../lib/time-travel';

const action = (id: string, seq: number, extra: Partial<GraphSnapshot['nodes'][number]> = {}) => ({
  id,
  label: 'Action' as const,
  title: extra.tool ?? 'tool',
  tool: 'tool',
  seq,
  status: 'done',
  kind: 'do',
  agentId: 'ops-agent',
  ...extra,
});

const snapshot: GraphSnapshot = {
  nodes: [
    action('a3', 3, { tool: 'create_ticket' }),
    action('a1', 1, { tool: 'lookup_order' }),
    action('a2', 2, { tool: 'update_address' }),
    action('u4', 4, { tool: 'restore_address', kind: 'undo', agentId: 'backtrack' }),
    { id: 'order:ord_1001', label: 'Entity', title: 'ord_1001', status: 'present' },
    { id: 'ticket:tkt_1', label: 'Entity', title: 'tkt_1', status: 'present' },
    { id: 'ops-agent', label: 'Agent', title: 'ops-agent' },
  ],
  links: [],
};

const frameAt = (asOfSeq: number | null, keys: string[]): WorldSnapshot => ({
  tenant: 'demo',
  asOfSeq,
  entities: keys.map((id) => {
    const [type = '', key = ''] = id.split(':');
    return { type, key, display: key, state: {} };
  }),
});

describe('time scrubber stops', () => {
  it('has one stop before the first action, one per action in seq order, and now', () => {
    const all = stops(timeline(snapshot));
    expect(all.map((s) => s.asOfSeq)).toEqual([0, 1, 2, 3, 4, null]);
    expect(all.map(stopLabel)).toEqual([
      'Before seq 1',
      'After seq 1 · lookup_order · Ops agent',
      'After seq 2 · update_address · Ops agent',
      'After seq 3 · create_ticket · Ops agent',
      'After seq 4 · restore_address (undo step) · Backtrack',
      'Now',
    ]);
    expect(stopIndex(all, null)).toBe(5);
    expect(stopIndex(all, 2)).toBe(2);
    expect(stopIndex(all, 0)).toBe(0);
  });

  it('is just now when nothing is recorded', () => {
    expect(stops(timeline({ nodes: [], links: [] }))).toEqual([{ kind: 'now', asOfSeq: null }]);
  });
});

describe('what dims at seq N', () => {
  it('dims nothing at now', () => {
    expect(laterNodes(snapshot, null, null).size).toBe(0);
  });

  it('dims every action after N, and before the frame arrives only those', () => {
    expect([...laterNodes(snapshot, 2, null)].sort()).toEqual(['a3', 'u4']);
    // A frame for another seq is not evidence for this one.
    expect([...laterNodes(snapshot, 2, frameAt(3, []))].sort()).toEqual(['a3', 'u4']);
  });

  it('dims the entities the frame at N does not contain', () => {
    const frame = frameAt(2, ['order:ord_1001', 'customer:cust_42']);
    expect([...laterNodes(snapshot, 2, frame)].sort()).toEqual(['a3', 'ticket:tkt_1', 'u4']);
    expect([...laterNodes(snapshot, 0, frameAt(0, ['order:ord_1001']))].sort()).toEqual([
      'a1',
      'a2',
      'a3',
      'ticket:tkt_1',
      'u4',
    ]);
  });
});

async function drain(stream: AsyncIterable<RunEvent>, client: MockApiClient) {
  for await (const e of stream) {
    if (e.type === 'approval.requested') {
      await client.approval({ runId: e.runId, actionId: e.actionId, approved: true });
    }
  }
}

const stateOf = (w: WorldSnapshot) =>
  Object.fromEntries(w.entities.map((e) => [`${e.type}:${e.key}`, e.state]));

describe('mock world(asOfSeq)', () => {
  it('rolls later effects back by their before, including an undo that came later', async () => {
    const client = new MockApiClient({ stepDelayMs: 0, undoStepDelayMs: 0 });
    const seed = stateOf(await client.world());
    await drain(client.runAgent({ agent: 'ops-agent', mode: 'replay' }), client);
    await drain(client.runAgent({ agent: 'billing-agent', mode: 'replay' }), client);
    const afterRuns = stateOf(await client.world());
    const { actions } = await client.actions();
    const last = Math.max(...actions.map((a) => a.seq));
    const address = actions.find((a) => a.tool === 'update_address');
    if (!address) throw new Error('no update_address in the golden run');

    const outcome = await client.undo({ actionId: address.id, depth: 1 });
    if (outcome.kind !== 'plan') throw new Error(`expected a plan, got ${outcome.kind}`);
    await drain(client.executeUndo(outcome.plan.id), client);

    // Before the first action: the seed. After the last agent action: the world the runs left,
    // even though an undo has since changed it. Now: the undo's result.
    expect(stateOf(await client.world(0))).toEqual(seed);
    expect(stateOf(await client.world(last))).toEqual(afterRuns);
    const order = (w: WorldSnapshot) => w.entities.find((e) => e.key === 'ord_1001')?.state.address;
    expect(order(await client.world(address.seq - 1))).toBe('14 Marine Drive, Mumbai 400020');
    expect(order(await client.world(address.seq))).toBe('221B Baker Street, London NW1 6XE');
    expect(order(await client.world())).toBe('14 Marine Drive, Mumbai 400020');
    expect((await client.world(address.seq)).asOfSeq).toBe(address.seq);
  });
});
