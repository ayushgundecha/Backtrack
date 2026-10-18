import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPlan,
  createPolicy,
  q1Downstream,
  q2UndoOrder,
  q3BlastRadius,
  q4LockIn,
  q5Policies,
  q6Explain,
  q7CrossAgent,
  q12EntityHistory,
  q13Recall,
  q14Conflicts,
  registry,
} from '../src/graph/queries.js';
import { setEntity } from '../src/world/store.js';
import { buildGolden } from './golden.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
let id: Record<string, string>;
const tools = (rows: Array<{ tool: string }>) => rows.map((r) => r.tool);

describe('query catalogue on the golden demo graph', () => {
  beforeAll(async () => {
    await fresh(g);
    id = await buildGolden(g);
  });

  it('every definition has an id, a title and an answers: line, and ids are unique', () => {
    for (const def of registry) {
      expect(def.answers.length, def.id).toBeGreaterThan(10);
      expect(def.title.length, def.id).toBeGreaterThan(3);
    }
    expect(new Set(registry.map((d) => d.id)).size).toBe(registry.length);
  });

  it('Q1: depth 1 → 2 → 3 reveals the distant billing credit with its path', async () => {
    const root = { actionId: id.update_address as string };
    const d1 = await q1Downstream(g, root, { depth: 1 });
    expect(tools(d1.rows)).toEqual(['send_email', 'create_ticket']);
    expect(d1.cypher).toContain('DEPENDS_ON*1..1]');
    const d2 = await q1Downstream(g, root, { depth: 2 });
    expect(tools(d2.rows)).toEqual(['send_email', 'post_message', 'create_ticket']);
    const d3 = await q1Downstream(g, root, { depth: 3 });
    expect(tools(d3.rows)).toEqual([
      'apply_credit',
      'schedule_followup',
      'send_email',
      'post_message',
      'create_ticket',
    ]);
    const credit = d3.rows.find((r) => r.tool === 'apply_credit');
    expect(credit).toMatchObject({ hops: 3, agentId: 'billing-agent' });
    expect(credit?.via).toEqual([
      'update_address',
      'create_ticket',
      'post_message',
      'apply_credit',
    ]);
    // send_email is reachable in 1 hop (order) and in 3 (ticket); the shortest wins.
    expect(d3.rows.find((r) => r.tool === 'send_email')?.hops).toBe(1);
    // Read-only dependents (list_open_tickets, lookup_ticket) changed nothing: not in the closure.
    expect(tools(d3.rows)).not.toContain('lookup_ticket');
  });

  it('Q1 clamps a hostile depth to the 1..10 literal range', async () => {
    const res = await q1Downstream(g, { actionId: id.update_address as string }, { depth: 1e9 });
    expect(res.cypher).toContain('*1..10]');
  });

  it('Q2: orders the plan by seq DESC with what each action changed', async () => {
    const ids = [
      'update_address',
      'create_ticket',
      'post_message',
      'send_email',
      'schedule_followup',
      'apply_credit',
    ].map((t) => id[t] as string);
    const { rows } = await q2UndoOrder(g, { actionIds: ids });
    expect(tools(rows)).toEqual([
      'apply_credit',
      'schedule_followup',
      'send_email',
      'post_message',
      'create_ticket',
      'update_address',
    ]);
    const post = rows.find((r) => r.tool === 'post_message');
    expect(post?.entities.map((e) => `${e.type}:${e.key}`).sort()).toEqual([
      'message:msg_1',
      'ticket:tkt_1',
    ]);
    expect(rows.find((r) => r.tool === 'send_email')).toMatchObject({
      reversible: false,
      mitigationTool: 'draft_correction_email',
    });
  });

  it('Q3: blast radius counts the root plus live dependents, irreversible ones and entities', async () => {
    const root = { actionId: id.update_address as string };
    const d1 = (await q3BlastRadius(g, root, { depth: 1 })).rows[0];
    expect(d1).toMatchObject({ actions: 3, irreversible: 1 });
    expect(d1?.entities.sort()).toEqual(['email:eml_1', 'order:ord_1001', 'ticket:tkt_1']);
    const d3 = (await q3BlastRadius(g, root, { depth: 3 })).rows[0];
    expect(d3).toMatchObject({ actions: 6, irreversible: 1 });
    expect(d3?.entities).toHaveLength(6);
    const leaf = (await q3BlastRadius(g, { actionId: id.apply_credit as string })).rows[0];
    expect(leaf).toMatchObject({ actions: 1, irreversible: 0, entities: ['credit:cr_1'] });
  });

  it('Q4: the email would lock in exactly the three reversible upstream changes', async () => {
    const { rows } = await q4LockIn(g, { actionId: id.send_email as string });
    expect(tools(rows)).toEqual(['update_address', 'create_ticket', 'post_message']);
    // lookup_order is upstream too but read-only, so there is nothing to lock in.
    expect(tools(rows)).not.toContain('lookup_order');
  });

  it('Q5: policies match by tool, then optional agent and entity scope; block ranks first', async () => {
    const base = { userId: 'ayush', createdFromPlanId: null, ts: Date.now() };
    await createPolicy(g, {
      ...base,
      policyId: 'pol_warn',
      rule: 'warn on emails',
      kind: 'warn',
      tool: 'send_email',
      agentId: null,
      entityType: null,
      entityKey: null,
    });
    await createPolicy(g, {
      ...base,
      policyId: 'pol_block',
      rule: 'never re-route ord_1001',
      kind: 'block',
      tool: 'update_address',
      agentId: 'ops-agent',
      entityType: 'order',
      entityKey: 'ord_1001',
    });
    await createPolicy(g, {
      ...base,
      policyId: 'pol_other',
      rule: 'billing only',
      kind: 'block',
      tool: 'update_address',
      agentId: 'billing-agent',
      entityType: null,
      entityKey: null,
    });
    const hit = await q5Policies(g, {
      tool: 'update_address',
      agentId: 'ops-agent',
      entities: ['order:ord_1001'],
    });
    expect(hit.rows.map((r) => r.id)).toEqual(['pol_block']);
    const otherOrder = await q5Policies(g, {
      tool: 'update_address',
      agentId: 'ops-agent',
      entities: ['order:ord_1002'],
    });
    expect(otherOrder.rows).toEqual([]);
    const email = await q5Policies(g, { tool: 'send_email', agentId: 'ops-agent', entities: [] });
    expect(email.rows.map((r) => r.kind)).toEqual(['warn']);
  });

  it('Q6: explains thought, reads with their writers, effects and both dependency directions', async () => {
    const { rows } = await q6Explain(g, { actionId: id.post_message as string });
    const x = rows[0];
    expect(x).toMatchObject({
      tool: 'post_message',
      agentId: 'ops-agent',
      thought: 'Run post_message',
    });
    expect(x?.reads).toEqual([
      expect.objectContaining({
        entity: 'ticket:tkt_1',
        writerTool: 'create_ticket',
        writerSeq: 3,
      }),
    ]);
    expect(x?.effects.map((e) => `${e.kind}:${e.type}:${e.key}:${e.field}`)).toEqual([
      'create:message:msg_1:null',
      'update:ticket:tkt_1:thread',
    ]);
    expect(x?.dependsOn.map((d) => d.tool)).toEqual(['create_ticket']);
    expect(x?.dependedOnBy.map((d) => d.tool).sort()).toEqual([
      'apply_credit',
      'list_open_tickets',
      'lookup_ticket',
      'schedule_followup',
      'send_email',
    ]);
    const seedRead = (await q6Explain(g, { actionId: id.lookup_order as string })).rows[0];
    expect(seedRead?.reads.every((r) => r.writerId === null)).toBe(true);
  });

  it('Q7: finds the billing agent behind the ops action, only at sufficient depth', async () => {
    const root = { actionId: id.update_address as string };
    expect((await q7CrossAgent(g, root, { depth: 2 })).rows).toEqual([]);
    const d3 = await q7CrossAgent(g, root, { depth: 3 });
    expect(d3.rows).toEqual([
      { agentId: 'billing-agent', actionId: id.apply_credit, tool: 'apply_credit', hops: 3 },
    ]);
  });

  it('Q12: entity history lists every change with run and agent', async () => {
    const { rows } = await q12EntityHistory(g, { type: 'ticket', key: 'tkt_1' });
    expect(tools(rows)).toEqual(['create_ticket', 'post_message']);
    expect(rows[1]).toMatchObject({
      field: 'thread',
      before: 'null',
      after: '"msg_1"',
      agentId: 'ops-agent',
    });
  });

  it('Q13: recall finds prior plans by action, tool or entity, and policies, with dates', async () => {
    const ts = Date.now();
    await createPlan(g, {
      planId: 'plan_recall',
      rootId: id.update_address as string,
      userId: 'ayush',
      ts,
      depth: 1,
      summary: 'undo address',
      stepIds: [id.update_address as string],
      stepModes: ['restore'],
      stepLabels: ['restore_address ord_1001 (update_address)'],
      stepHops: [0],
      stepVia: ['[]'],
      stepEntities: ['order:ord_1001'],
      stepMitigations: [null],
    });
    const byEntity = await q13Recall(g, {
      actionId: null,
      tool: null,
      type: 'order',
      key: 'ord_1001',
    });
    expect(byEntity.rows.map((r) => `${r.kind}:${r.id}`).sort()).toEqual([
      'plan:plan_recall',
      'policy:pol_block',
    ]);
    expect(byEntity.rows.find((r) => r.kind === 'plan')?.ts).toBe(ts);
    const byAction = await q13Recall(g, {
      actionId: id.update_address as string,
      tool: null,
      type: null,
      key: null,
    });
    expect(byAction.rows.map((r) => r.id)).toEqual(['plan_recall']);
    const nothing = await q13Recall(g, {
      actionId: null,
      tool: 'apply_credit',
      type: 'credit',
      key: 'cr_1',
    });
    expect(nothing.rows).toEqual([]);
  });

  it('Q14: reports current state against what the action left, and later live writers', async () => {
    const clean = await q14Conflicts(g, { actionId: id.update_address as string });
    expect(clean.rows).toEqual([
      expect.objectContaining({
        field: 'address',
        after: JSON.stringify('221B Baker Street, London NW1 6XE'),
        laterWriters: [],
      }),
    ]);
    const ticket = await q14Conflicts(g, { actionId: id.create_ticket as string });
    expect(ticket.rows[0]?.laterWriters.map((w) => w.tool)).toEqual(['post_message']);
    // A human edit outside any action leaves no writer, but the state no longer matches.
    await setEntity(g, { type: 'credit', key: 'cr_1' }, { id: 'cr_1', amount: 99 });
    const edited = await q14Conflicts(g, { actionId: id.apply_credit as string });
    expect(edited.rows[0]?.laterWriters).toEqual([]);
    expect(edited.rows[0]?.state).not.toBe(edited.rows[0]?.after);
  });
});

describe('graph/queries.cypher', () => {
  it('is generated from queries.ts and up to date (run pnpm gen:queries)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { renderCatalogue } = await import('../src/graph/catalogue.js');
    const committed = readFileSync(
      resolve(import.meta.dirname, '../../../graph/queries.cypher'),
      'utf8',
    );
    expect(committed).toBe(renderCatalogue());
  });

  it("README's query blocks are generated too and up to date", async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { spliceReadme } = await import('../src/graph/catalogue.js');
    const readme = readFileSync(resolve(import.meta.dirname, '../../../README.md'), 'utf8');
    expect(spliceReadme(readme)).toBe(readme);
  });
});
