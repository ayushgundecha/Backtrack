import type { GraphSnapshot } from '@backtrack/core/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { brief, pathView, writerOf } from '../lib/explain-view';
import { closureFromOutcome } from '../lib/graph-model';
import { MockApiClient } from '../lib/mock';

let client: MockApiClient;
let graph: GraphSnapshot;
const idOf = (tool: string) => graph.nodes.find((n) => n.tool === tool)?.id as string;

beforeAll(async () => {
  client = new MockApiClient({ stepDelayMs: 0, undoStepDelayMs: 0 });
  for await (const e of client.runAgent({ agent: 'ops-agent', mode: 'replay' })) {
    if (e.type === 'approval.requested') {
      void client.approval({ runId: e.runId, actionId: e.actionId, approved: true });
    }
  }
  for await (const _ of client.runAgent({ agent: 'billing-agent', mode: 'replay' })) {
    // drain
  }
  graph = await client.graph();
});

describe('writerOf', () => {
  it('names who wrote what the action read, from its own DEPENDS_ON list', async () => {
    const explain = await client.explain(idOf('post_message'));
    const read = explain.reads.find((r) => r.entity === 'ticket:tkt_1');
    if (!read) throw new Error('post_message should have read the ticket');
    expect(writerOf(read, explain, graph)).toEqual({
      actionId: idOf('create_ticket'),
      tool: 'create_ticket',
      seq: 3,
    });
  });

  it('claims no writer when Q6 found none', async () => {
    const explain = await client.explain(idOf('lookup_order'));
    expect(explain.reads.length).toBeGreaterThan(0);
    for (const read of explain.reads) expect(writerOf(read, explain, graph)).toBeNull();
  });

  it('shows the id rather than guessing a tool it cannot find', async () => {
    const explain = await client.explain(idOf('post_message'));
    const read = { entity: 'ticket:tkt_1', saw: null, writtenBy: 'act_gone', writtenAtSeq: 7 };
    expect(writerOf(read, explain, { nodes: [], links: [] })).toEqual({
      actionId: 'act_gone',
      tool: null,
      seq: 7,
    });
  });
});

describe('pathView', () => {
  it('shows paths only when the graph view asked Q1 about a related action', async () => {
    const root = idOf('update_address');
    expect(pathView(root, null)).toEqual({ kind: 'no-selection' });

    const closure = closureFromOutcome(
      await client.undo({ actionId: root, depth: 3 }),
      root,
      3,
      graph,
    );
    const asRoot = pathView(root, closure);
    expect(asRoot.kind).toBe('root');
    if (asRoot.kind === 'root') {
      expect(asRoot.members.map((m) => m.tool)).toContain('apply_credit');
    }

    const credit = pathView(idOf('apply_credit'), closure);
    expect(credit).toMatchObject({ kind: 'member', depth: 3, rootId: root });
    if (credit.kind === 'member') {
      expect(credit.member.path.map((h) => (h.kind === 'action' ? h.seq : -1))).toEqual([
        2, 3, 4, 9,
      ]);
    }

    // lookup_order (seq 1) is upstream of the root: nothing on Q1's side connects them.
    expect(pathView(idOf('lookup_order'), closure)).toEqual({
      kind: 'outside',
      depth: 3,
      rootId: root,
    });
  });
});

describe('brief', () => {
  it('reads null as empty and shortens long values', () => {
    expect(brief(null)).toBe('empty');
    expect(brief('msg_1')).toBe('msg_1');
    expect(brief({ a: 1 })).toBe('{"a":1}');
    expect(brief('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
