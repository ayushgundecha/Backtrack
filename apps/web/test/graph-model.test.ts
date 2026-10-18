import type { GraphSnapshot } from '@backtrack/core/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  closureFromOutcome,
  linkKey,
  normalizePath,
  stepSelection,
  toViewGraph,
} from '../lib/graph-model';
import { MockApiClient } from '../lib/mock';

/** Both golden runs, the email approved: the graph the demo shows before any undo. */
async function goldenClient() {
  const client = new MockApiClient({ stepDelayMs: 0, undoStepDelayMs: 0 });
  for await (const e of client.runAgent({ agent: 'ops-agent', mode: 'replay' })) {
    if (e.type === 'approval.requested') {
      void client.approval({ runId: e.runId, actionId: e.actionId, approved: true });
    }
  }
  for await (const _ of client.runAgent({ agent: 'billing-agent', mode: 'replay' })) {
    // drain
  }
  return client;
}

let client: MockApiClient;
let graph: GraphSnapshot;
const idOf = (tool: string) => graph.nodes.find((n) => n.tool === tool)?.id as string;

beforeAll(async () => {
  client = await goldenClient();
  graph = await client.graph();
});

describe('toViewGraph', () => {
  it('draws actions and entities only, with the links between them', () => {
    const view = toViewGraph(graph);
    expect(new Set(view.nodes.map((n) => n.kind))).toEqual(new Set(['action', 'entity']));
    expect(view.nodes.filter((n) => n.kind === 'action')).toHaveLength(9);
    expect(
      view.links.every((l) => ['DEPENDS_ON', 'CAUSED', 'READ', 'UNDOES'].includes(l.type)),
    ).toBe(true);
    expect(view.links.filter((l) => l.type === 'DEPENDS_ON')).toHaveLength(8);
  });

  it('keeps the structure key when only a status changes, so the layout is not re-heated', () => {
    const before = toViewGraph(graph).structureKey;
    const restyled: GraphSnapshot = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.label === 'Action' ? { ...n, status: 'undone' } : n)),
    };
    expect(toViewGraph(restyled).structureKey).toBe(before);
    const grown: GraphSnapshot = {
      ...graph,
      nodes: [...graph.nodes, { id: 'act_new', label: 'Action', title: 'lookup_order' }],
    };
    expect(toViewGraph(grown).structureKey).not.toBe(before);
  });
});

describe('closureFromOutcome', () => {
  it('lights the root, its dependents at depth 1 and the entities in the blast radius', async () => {
    const root = idOf('update_address');
    const outcome = await client.undo({ actionId: root, depth: 1 });
    const closure = closureFromOutcome(outcome, root, 1, graph);

    expect(closure.members.map((m) => m.tool).sort()).toEqual(['create_ticket', 'send_email']);
    expect(closure.members.every((m) => m.hops === 1)).toBe(true);
    expect(closure.lit.has(root)).toBe(true);
    expect(closure.lit.has(idOf('post_message'))).toBe(false);
    expect(closure.blast).toMatchObject({ actions: 3, irreversible: 1, depth: 1 });
    for (const entity of closure.blast?.entities ?? []) expect(closure.lit.has(entity)).toBe(true);
    expect(closure.litLinks.has(linkKey(idOf('create_ticket'), root, 'DEPENDS_ON'))).toBe(true);
    expect(
      closure.litLinks.has(linkKey(idOf('post_message'), idOf('create_ticket'), 'DEPENDS_ON')),
    ).toBe(false);
  });

  it('grows with depth and reaches the billing agent at depth 3', async () => {
    const root = idOf('update_address');
    const closure = closureFromOutcome(
      await client.undo({ actionId: root, depth: 3 }),
      root,
      3,
      graph,
    );
    expect(closure.members.map((m) => m.tool)).toContain('apply_credit');
    expect(closure.crossAgents).toEqual(['billing-agent']);
    const credit = closure.members.find((m) => m.tool === 'apply_credit');
    expect(credit?.hops).toBe(3);
    // The path reads root → dependent, every hop a real action.
    expect(credit?.path.map((h) => (h.kind === 'action' ? h.tool : h.text))).toEqual([
      'update_address',
      'create_ticket',
      'post_message',
      'apply_credit',
    ]);
    expect(
      closure.litLinks.has(linkKey(idOf('apply_credit'), idOf('post_message'), 'DEPENDS_ON')),
    ).toBe(true);
  });

  it('lights only the root and carries the reason when there is nothing to undo', async () => {
    const root = idOf('lookup_order');
    const outcome = await client.undo({ actionId: root, depth: 2 });
    expect(outcome.kind).toBe('none');
    const closure = closureFromOutcome(outcome, root, 2, graph);
    expect([...closure.lit]).toEqual([root]);
    expect(closure.blast).toBeNull();
    expect(closure.note).toMatch(/lookup_order \(seq 1\) only read/);
  });
});

describe('normalizePath', () => {
  it('resolves tool names sent root → dependent (the real /api/undo) to the actions on the path', () => {
    const path = normalizePath(['update_address', 'create_ticket', 'post_message'], graph, {
      rootId: idOf('update_address'),
      memberId: idOf('post_message'),
    });
    expect(path).toEqual([
      { kind: 'action', id: idOf('update_address'), tool: 'update_address', seq: 2 },
      { kind: 'action', id: idOf('create_ticket'), tool: 'create_ticket', seq: 3 },
      { kind: 'action', id: idOf('post_message'), tool: 'post_message', seq: 4 },
    ]);
  });

  it('orders action ids root → dependent whichever way they were sent', () => {
    const ids = [idOf('post_message'), idOf('create_ticket'), idOf('update_address')];
    expect(normalizePath(ids, graph).map((h) => (h.kind === 'action' ? h.seq : 0))).toEqual([
      2, 3, 4,
    ]);
  });

  it('shows the strings as sent when they match no path in the graph', () => {
    expect(
      normalizePath(['update_address', 'apply_credit'], graph, {
        rootId: idOf('update_address'),
        memberId: idOf('apply_credit'),
      }),
    ).toEqual([
      { kind: 'text', text: 'update_address' },
      { kind: 'text', text: 'apply_credit' },
    ]);
  });
});

describe('stepSelection', () => {
  it('walks actions in seq order and wraps at both ends', () => {
    expect(stepSelection(graph, null, 1)).toBe(idOf('lookup_order'));
    expect(stepSelection(graph, null, -1)).toBe(idOf('apply_credit'));
    expect(stepSelection(graph, idOf('lookup_order'), 1)).toBe(idOf('update_address'));
    expect(stepSelection(graph, idOf('apply_credit'), 1)).toBe(idOf('lookup_order'));
  });
});
