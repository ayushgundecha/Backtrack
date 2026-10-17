import { beforeEach, describe, expect, it } from 'vitest';
import { RunEvent } from '../src/contracts/events.js';
import type { EffectDraft, EntityRef } from '../src/contracts/types.js';
import {
  actionRecordedEvent,
  commitPending,
  type RecordedAction,
  record,
  startRun,
  startStep,
} from '../src/sdk/recorder.js';
import { getEntity } from '../src/world/store.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const order: EntityRef = { type: 'order', key: 'ord_1001' };
const ticket: EntityRef = { type: 'ticket', key: 'tkt_1' };

async function newRun(agentId = 'ops-agent') {
  const { runId } = await startRun(g, { agentId, kind: 'agent', goal: 'test', mode: 'replay' });
  let index = 0;
  return async (
    tool: string,
    reads: EntityRef[],
    writes: EffectDraft[],
    status: 'done' | 'pending' = 'done',
  ): Promise<RecordedAction> => {
    const { stepId } = await startStep(g, { runId, index: index++, thought: `do ${tool}` });
    return record(g, {
      runId,
      stepId,
      agentId,
      tool,
      args: { probe: tool },
      kind: 'do',
      status,
      reversible: true,
      inverseTool: null,
      mitigationTool: null,
      outcome: { result: { ok: true }, reads, writes },
    });
  };
}

const setAddress = (before: string, after: string): EffectDraft => ({
  kind: 'update',
  entity: order,
  field: 'address',
  before,
  after,
});

const edges = async (from: string) =>
  (
    await g.read<{ to: string; via: string; weight: number }>(
      `MATCH (:Action {id: $from})-[d:DEPENDS_ON]->(w:Action) RETURN w.id AS to, d.via AS via, d.weight AS weight ORDER BY to`,
      { from },
    )
  ).rows;

describe('recorder', () => {
  beforeEach(async () => {
    await fresh(g);
  });

  it('read-after-write: a reader depends on the writer, via read', async () => {
    const act = await newRun();
    const w = await act(
      'update_address',
      [order],
      [setAddress('14 Marine Drive, Mumbai 400020', 'A')],
    );
    const r = await act('lookup_order', [order], []);
    expect(r.dependsOn).toEqual([w.action.id]);
    expect(await edges(r.action.id)).toEqual([{ to: w.action.id, via: 'read', weight: 1 }]);
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe('A');
  });

  it('write-after-write: a blind overwrite depends on the previous writer, via write', async () => {
    const act = await newRun();
    const w1 = await act('update_address', [], [setAddress('14 Marine Drive, Mumbai 400020', 'A')]);
    const w2 = await act('update_address', [], [setAddress('A', 'B')]);
    expect(await edges(w2.action.id)).toEqual([{ to: w1.action.id, via: 'write', weight: 1 }]);
  });

  it('links only to the latest earlier writer; transitivity covers the rest', async () => {
    const act = await newRun();
    const w1 = await act(
      'update_address',
      [order],
      [setAddress('14 Marine Drive, Mumbai 400020', 'A')],
    );
    const w2 = await act('update_address', [order], [setAddress('A', 'B')]);
    const r = await act('lookup_order', [order], []);
    expect(await edges(r.action.id)).toEqual(
      [{ to: w2.action.id, via: 'read' }].map((e) => ({ ...e, weight: 1 })),
    );
    expect(await edges(w2.action.id)).toEqual([{ to: w1.action.id, via: 'read', weight: 1 }]);
    // Reading and writing the same entity still yields exactly one edge (no parallel edges).
    const { rows } = await g.read<{ n: number }>(
      'MATCH (:Action {id: $id})-[d:DEPENDS_ON]->() WHERE ID(d) >= 0 RETURN count(d) AS n',
      { id: w2.action.id },
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('links across runs and agents through the shared entity', async () => {
    const ops = await newRun('ops-agent');
    const created = await ops(
      'create_ticket',
      [order],
      [
        {
          kind: 'create',
          entity: ticket,
          field: null,
          before: null,
          after: { id: 'tkt_1', status: 'open' },
        },
      ],
    );
    const billing = await newRun('billing-agent');
    const read = await billing('lookup_ticket', [ticket], []);
    expect(read.dependsOn).toEqual([created.action.id]);
    expect(read.action.agentId).toBe('billing-agent');
    expect(read.action.runId).not.toBe(created.action.runId);
  });

  it('gives every action a strictly increasing seq and DEPENDS_ON always points backwards', async () => {
    const act = await newRun();
    const seqs: number[] = [];
    let prev = '14 Marine Drive, Mumbai 400020';
    for (const next of ['A', 'B', 'C', 'D']) {
      seqs.push((await act('update_address', [order], [setAddress(prev, next)])).action.seq);
      prev = next;
    }
    expect(seqs).toEqual([1, 2, 3, 4]);
    const { rows } = await g.read<{ bad: number }>(
      'MATCH (a:Action)-[d:DEPENDS_ON]->(b:Action) WHERE ID(d) >= 0 AND a.seq <= b.seq RETURN count(d) AS bad',
    );
    expect(rows[0]?.bad).toBe(0);
  });

  it('records in a single statement and emits action.recorded with its trace', async () => {
    const act = await newRun();
    const w = await act(
      'update_address',
      [order],
      [setAddress('14 Marine Drive, Mumbai 400020', 'A')],
    );
    expect(w.trace.cypher).toContain("MATCH (c:Counter {id: 'seq'})");
    expect(w.trace.cypher).toContain('DEPENDS_ON');
    expect(w.trace.cypher.split(';')).toHaveLength(1);
    const event = RunEvent.parse(actionRecordedEvent(w));
    expect(event.type).toBe('action.recorded');
    if (event.type !== 'action.recorded') return;
    expect(event.effects).toHaveLength(1);
    expect(event.effects[0]).toMatchObject({
      field: 'address',
      before: '14 Marine Drive, Mumbai 400020',
      after: 'A',
    });
    expect(event.reads).toEqual(['order:ord_1001']);
  });

  it('pending actions record dependencies now and apply writes only on commit', async () => {
    const act = await newRun();
    const w = await act(
      'update_address',
      [order],
      [setAddress('14 Marine Drive, Mumbai 400020', 'A')],
    );
    const p = await act('update_address', [order], [setAddress('A', 'B')], 'pending');
    expect(p.dependsOn).toEqual([w.action.id]);
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe('A');
    const done = await commitPending(g, p);
    expect(done.action.status).toBe('done');
    expect(done.effects).toHaveLength(1);
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe('B');
    await expect(commitPending(g, p)).rejects.toThrow(/no longer pending/);
  });

  it('chains steps with NEXT inside a run', async () => {
    const act = await newRun();
    await act('lookup_order', [order], []);
    await act('lookup_order', [order], []);
    await act('lookup_order', [order], []);
    const { rows } = await g.read<{ n: number }>(
      'MATCH (:Step)-[n:NEXT]->(:Step) WHERE ID(n) >= 0 RETURN count(n) AS n',
    );
    expect(rows[0]?.n).toBe(2);
  });
});
