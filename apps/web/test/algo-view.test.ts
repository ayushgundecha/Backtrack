/**
 * BT-04B: reading /api/algo rows (Q8–Q11) and mapping them onto the graph. The ranked and
 * cluster rows below are what the real route returned for the golden runs on FalkorDB
 * (tenant webd, ids shortened); the mock must answer in the same shape.
 */
import type { GraphSnapshot, RunEvent } from '@backtrack/core/contracts';
import { describe, expect, it } from 'vitest';
import { orderPicks, overlayOf, parseAlgo } from '../lib/algo-view';
import { linkKey } from '../lib/graph-model';
import { MockApiClient } from '../lib/mock';

const TOOLS = [
  'lookup_order',
  'update_address',
  'create_ticket',
  'post_message',
  'send_email',
  'schedule_followup',
  'list_open_tickets',
  'lookup_ticket',
  'apply_credit',
];
const id = (seq: number) => `a${seq}`;

// DEPENDS_ON edges (dependent → dependency) consistent with the real Q10 and Q11 rows below.
const EDGES: [number, number][] = [
  [3, 2],
  [4, 3],
  [5, 2],
  [5, 4],
  [6, 4],
  [7, 4],
  [8, 4],
  [9, 4],
];
const snapshot: GraphSnapshot = {
  nodes: [
    ...TOOLS.map((tool, i) => ({
      id: id(i + 1),
      label: 'Action' as const,
      title: tool,
      tool,
      seq: i + 1,
      kind: 'do',
      status: 'done',
    })),
    { id: 'order:ord_1001', label: 'Entity', title: 'ord_1001' },
  ],
  links: EDGES.map(([s, t]) => ({
    source: id(s),
    target: id(t),
    type: 'DEPENDS_ON' as const,
  })),
};

const row = (seq: number, score: number) => ({
  id: id(seq),
  tool: TOOLS[seq - 1],
  seq,
  status: 'done',
  agentId: seq > 6 ? 'billing-agent' : 'ops-agent',
  score,
});

describe('ranked answers (Q8 PageRank, Q9 betweenness)', () => {
  it('ranks the rows above the lowest score and leaves the tied bottom unranked', () => {
    const pagerank = [
      row(2, 0.0714252889156342),
      row(3, 0.0632238611578941),
      row(4, 0.0597955919802189),
      ...[1, 5, 6, 7, 8, 9].map((s) => row(s, 0.0123931644484401)),
    ];
    const view = parseAlgo('load_bearing', pagerank, snapshot);
    if (view.name !== 'load_bearing') throw new Error('wrong view');
    expect(view.rows.map((r) => r.rank)).toEqual([1, 2, 3, null, null, null, null, null, null]);
    const overlay = overlayOf(view, snapshot);
    expect([...(overlay.lit ?? [])]).toEqual(['a2', 'a3', 'a4']);
    expect(Object.fromEntries(overlay.badges)).toEqual({ a2: '#1', a3: '#2', a4: '#3' });
    expect([...overlay.litLinks].sort()).toEqual(
      [linkKey('a3', 'a2', 'DEPENDS_ON'), linkKey('a4', 'a3', 'DEPENDS_ON')].sort(),
    );
  });

  it('gives tied scores the same rank and an all-equal answer no ranks at all', () => {
    const hinges = parseAlgo(
      'hinge_actions',
      [row(4, 12), row(3, 6), row(5, 6), row(1, 0)],
      snapshot,
    );
    if (hinges.name !== 'hinge_actions') throw new Error('wrong view');
    expect(hinges.rows.map((r) => r.rank)).toEqual([1, 2, 2, null]);
    const flat = parseAlgo('hinge_actions', [row(1, 0), row(2, 0)], snapshot);
    expect(overlayOf(flat, snapshot).lit?.size).toBe(0);
  });

  it('refuses rows that are not the Q8/Q9 shape instead of guessing', () => {
    expect(() => parseAlgo('load_bearing', [{ actionId: 'a1', score: 1 }], snapshot)).toThrow();
  });
});

describe('clusters (Q10 WCC)', () => {
  const rows = [
    {
      componentId: 40,
      size: 8,
      actions: [2, 3, 4, 5, 6, 7, 8, 9].map((s) => ({ id: id(s), tool: TOOLS[s - 1], seq: s })),
    },
    { componentId: 38, size: 1, actions: [{ id: 'a1', tool: 'lookup_order', seq: 1 }] },
  ];

  it('numbers clusters largest first and badges every action without dimming', () => {
    const view = parseAlgo('independent_clusters', rows, snapshot);
    const overlay = overlayOf(view, snapshot);
    expect(overlay.lit).toBeNull();
    expect(overlay.badges.get('a1')).toBe('C2');
    expect(overlay.badges.get('a9')).toBe('C1');
  });

  it('lights one cluster alone when focused', () => {
    const overlay = overlayOf(parseAlgo('independent_clusters', rows, snapshot), snapshot, 2);
    expect([...(overlay.lit ?? [])]).toEqual(['a1']);
  });
});

describe('path between two actions (Q11 SPpaths)', () => {
  it('lights the route and the DEPENDS_ON edge between each pair of steps', () => {
    const view = parseAlgo(
      'path_between',
      [
        {
          ids: ['a2', 'a3', 'a4', 'a9'],
          tools: ['update_address', 'create_ticket', 'post_message', 'apply_credit'],
          pathWeight: 3,
        },
      ],
      snapshot,
    );
    expect(view).toMatchObject({ hops: 3, path: [{ id: 'a2', seq: 2 }, {}, {}, { seq: 9 }] });
    const overlay = overlayOf(view, snapshot);
    expect(Object.fromEntries(overlay.badges)).toEqual({ a2: '1', a3: '2', a4: '3', a9: '4' });
    expect([...overlay.litLinks]).toEqual([
      linkKey('a3', 'a2', 'DEPENDS_ON'),
      linkKey('a4', 'a3', 'DEPENDS_ON'),
      linkKey('a9', 'a4', 'DEPENDS_ON'),
    ]);
  });

  it('says there is no route when Q11 returns no rows', () => {
    const view = parseAlgo('path_between', [], snapshot);
    expect(view).toEqual({ name: 'path_between', path: null, hops: null });
    expect(overlayOf(view, snapshot).lit?.size).toBe(0);
  });

  it('puts the two picks in seq order, earlier first', () => {
    expect(orderPicks('a9', 'a2', snapshot)).toEqual({ from: 'a2', to: 'a9' });
    expect(orderPicks('a2', null, snapshot)).toEqual({ from: 'a2', to: null });
  });
});

async function drain(stream: AsyncIterable<RunEvent>, client: MockApiClient) {
  for await (const e of stream) {
    if (e.type === 'approval.requested') {
      await client.approval({ runId: e.runId, actionId: e.actionId, approved: true });
    }
  }
}

describe('mock /api/algo', () => {
  it('answers in the real row shapes with the catalogue Cypher, and 400s a path without ends', async () => {
    const client = new MockApiClient({ stepDelayMs: 0, undoStepDelayMs: 0 });
    await drain(client.runAgent({ agent: 'ops-agent', mode: 'replay' }), client);
    await drain(client.runAgent({ agent: 'billing-agent', mode: 'replay' }), client);
    const graph = await client.graph();
    const { actions } = await client.actions();
    const of = (tool: string) => actions.find((a) => a.tool === tool)?.id as string;

    const load = await client.algo({ name: 'load_bearing' });
    expect(load.cypher).toContain("algo.pageRank('Action', 'DEPENDS_ON')");
    const ranked = parseAlgo('load_bearing', load.rows, graph);
    if (ranked.name !== 'load_bearing') throw new Error('wrong view');
    expect(ranked.rows[0]?.tool).toBe('update_address');

    const clusters = parseAlgo(
      'independent_clusters',
      (await client.algo({ name: 'independent_clusters' })).rows,
      graph,
    );
    if (clusters.name !== 'independent_clusters') throw new Error('wrong view');
    expect(clusters.clusters.reduce((n, c) => n + c.actions.length, 0)).toBe(actions.length);

    const path = await client.algo({
      name: 'path_between',
      from: of('update_address'),
      to: of('apply_credit'),
    });
    expect(path.cypher).toContain("relDirection: 'incoming'");
    expect(parseAlgo('path_between', path.rows, graph)).toMatchObject({
      path: [{ tool: 'update_address' }, {}, {}, { tool: 'apply_credit' }],
    });
    // Reversed, there is no route: a dependency never depends on its dependent.
    const back = await client.algo({
      name: 'path_between',
      from: of('apply_credit'),
      to: of('update_address'),
    });
    expect(back.rows).toEqual([]);
    await expect(
      client.algo({ name: 'path_between', from: of('send_email') }),
    ).rejects.toMatchObject({ status: 400, message: 'path_between needs from and to action ids' });
  });
});
