import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UndoOutcome } from '../src/contracts/types.js';
import { setPlanStatus } from '../src/graph/queries.js';
import { defineTool, ToolRegistry } from '../src/sdk/registry.js';
import { executeUndo, loadPlan, planUndo } from '../src/sdk/undo.js';
import { getEntity, setEntity } from '../src/world/store.js';
import { buildGolden } from './golden.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
let id: Record<string, string>;

// A stand-in for the ops agent's mitigation so the engine can be tested on its own.
const draftCorrection = defineTool({
  name: 'draft_correction_email',
  description: 'Draft a correction for a sent email.',
  input: z.object({ actionId: z.string() }),
  effect: 'compensation',
  run: async () => ({
    result: { id: 'eml_2' },
    reads: [],
    writes: [
      {
        kind: 'create',
        entity: { type: 'email', key: 'eml_2' },
        field: null,
        before: null,
        after: { id: 'eml_2', status: 'draft', subject: 'Correction' },
      },
    ],
  }),
});
const registry = new ToolRegistry([draftCorrection]);

async function plan(text: string, depth = 5) {
  const { outcome } = await planUndo(g, { text, depth }, { registry });
  return UndoOutcome.parse(outcome);
}

describe('planUndo: the four honest outcomes', () => {
  beforeEach(async () => {
    await fresh(g);
    id = await buildGolden(g);
  });

  it('plan: resolves "undo the address change" and orders every live dependent seq DESC', async () => {
    const o = await plan('undo the address change', 3);
    if (o.kind !== 'plan') throw new Error(`expected a plan, got ${o.kind}`);
    const p = o.plan;
    expect(p.rootActionId).toBe(id.update_address);
    expect(p.steps.map((s) => s.label)).toEqual([
      'revoke_credit cr_1 (apply_credit)',
      'cancel_event evt_1 (schedule_followup)',
      'draft_correction_email eml_1 (send_email)',
      'delete_message msg_1 (post_message)',
      'close_ticket tkt_1 (create_ticket)',
      'restore_address ord_1001 (update_address)',
    ]);
    expect(p.steps.find((s) => s.tool === 'send_email')?.mode).toBe('mitigation');
    expect(p.blast).toEqual({ actions: 6, irreversible: 1, entities: expect.any(Array), depth: 3 });
    expect(p.crossAgent).toEqual([
      { agentId: 'billing-agent', actionId: id.apply_credit, tool: 'apply_credit', hops: 3 },
    ]);
    expect(p.summary).toContain('billing-agent apply_credit (3 hops)');
    // The plan is persisted and reloads identically from the graph.
    const loaded = await loadPlan(g, p.id);
    expect(loaded?.steps).toEqual(p.steps);
    expect(loaded?.status).toBe('proposed');
  });

  it('plan at depth 1 leaves the distant dependents out', async () => {
    const o = await plan('undo the address change', 1);
    if (o.kind !== 'plan') throw new Error('expected a plan');
    expect(o.plan.steps.map((s) => s.tool)).toEqual([
      'send_email',
      'create_ticket',
      'update_address',
    ]);
    expect(o.plan.crossAgent).toEqual([]);
  });

  it('asking again for the same plan reuses it instead of recording a copy', async () => {
    const planIds = async () =>
      (await g.read<{ id: string }>('MATCH (p:UndoPlan) RETURN p.id AS id ORDER BY id')).rows;
    const first = await plan('undo the address change', 3);
    const again = await plan('undo the address change', 3);
    const deeper = await plan('undo the address change', 1);
    if (first.kind !== 'plan' || again.kind !== 'plan' || deeper.kind !== 'plan') {
      throw new Error('expected plans');
    }
    expect(again.plan).toEqual(first.plan);
    // A different depth is a different plan (different steps), so it is recorded.
    expect(deeper.plan.id).not.toBe(first.plan.id);
    expect(await planIds()).toHaveLength(2);
    // Once a plan has been acted on (here: rehearsed), asking again proposes a fresh one.
    await setPlanStatus(g, { planId: first.plan.id, status: 'rehearsed' });
    const later = await plan('undo the address change', 3);
    if (later.kind !== 'plan') throw new Error('expected a plan');
    expect(later.plan.id).not.toBe(first.plan.id);
  });

  it('none: a read-only action changed nothing', async () => {
    const o = await planUndo(g, { actionId: id.lookup_order }, { registry });
    expect(o.outcome).toMatchObject({ kind: 'none', actionId: id.lookup_order });
    if (o.outcome.kind === 'none') expect(o.outcome.reason).toMatch(/changed nothing/);
  });

  it('unknown: text that matches nothing returns the three closest candidates', async () => {
    const o = await plan('undo the refund to the warehouse');
    expect(o.kind).toBe('unknown');
    if (o.kind === 'unknown') expect(o.candidates).toHaveLength(3);
    const ambiguous = await plan('undo it');
    expect(ambiguous.kind).toBe('unknown');
  });

  it('memory: an action already undone returns the prior plan with its date', async () => {
    const first = await plan('undo the credit');
    if (first.kind !== 'plan') throw new Error('expected a plan');
    await executeUndo(g, first.plan.id, { registry });
    const again = await plan('undo the credit');
    expect(again.kind).toBe('memory');
    if (again.kind === 'memory') {
      expect(again.priorPlans.map((p) => p.id)).toEqual([first.plan.id]);
      expect(again.priorPlans[0]?.status).toBe('executed');
      expect(again.priorPlans[0]?.ts).toBe(first.plan.ts);
    }
  });
});

describe('executeUndo', () => {
  beforeEach(async () => {
    await fresh(g);
    id = await buildGolden(g);
  });

  it('reverts in plan order, mitigates the email, and restores the world', async () => {
    const o = await plan('undo the address change', 3);
    if (o.kind !== 'plan') throw new Error('expected a plan');
    const res = await executeUndo(g, o.plan.id, { registry });
    expect(res.status).toBe('executed');
    const done = res.events.filter((e) => e.type === 'undo.step' && e.status === 'done');
    expect(done.map((e) => (e.type === 'undo.step' ? e.label : ''))).toEqual(
      o.plan.steps.map((s) => s.label),
    );
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe(
      '14 Marine Drive, Mumbai 400020',
    );
    expect(await getEntity(g, 'ticket', 'tkt_1')).toBeNull();
    expect(await getEntity(g, 'message', 'msg_1')).toBeNull();
    expect(await getEntity(g, 'credit', 'cr_1')).toBeNull();
    expect(await getEntity(g, 'email', 'eml_1')).toMatchObject({ status: 'sent' });
    expect(await getEntity(g, 'email', 'eml_2')).toMatchObject({ status: 'draft' });
    const { rows } = await g.read<{ tool: string; status: string }>(
      "MATCH (a:Action {kind: 'do'}) RETURN a.tool AS tool, a.status AS status ORDER BY a.seq",
    );
    expect(rows.filter((r) => r.status === 'undone').map((r) => r.tool)).toEqual([
      'update_address',
      'create_ticket',
      'post_message',
      'schedule_followup',
      'apply_credit',
    ]);
    // Edges the README promises: UNDOES per compensation, COULD_NOT_REVERT on the email.
    const edges = await g.read<{ t: string; n: number }>(
      'MATCH ()-[r:UNDOES|COULD_NOT_REVERT|REVERTS]->() WHERE ID(r) >= 0 RETURN type(r) AS t, count(r) AS n ORDER BY t',
    );
    expect(edges.rows).toEqual([
      { t: 'COULD_NOT_REVERT', n: 1 },
      { t: 'REVERTS', n: 5 },
      { t: 'UNDOES', n: 6 },
    ]);
  });

  it('a human edit since the run is a conflict: the step is skipped with a CONFLICT edge and the plan is partial', async () => {
    const o = await plan('undo the address change', 3);
    if (o.kind !== 'plan') throw new Error('expected a plan');
    const order = await getEntity(g, 'order', 'ord_1001');
    await setEntity(
      g,
      { type: 'order', key: 'ord_1001' },
      { ...order, address: 'Edited by a human' },
    );
    const res = await executeUndo(g, o.plan.id, { registry });
    expect(res.status).toBe('partial');
    const conflict = res.events.find((e) => e.type === 'undo.step' && e.status === 'conflict');
    expect(conflict).toMatchObject({ actionId: id.update_address });
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe('Edited by a human');
    const { rows } = await g.read<{ reason: string }>(
      'MATCH (:UndoPlan {id: $planId})-[c:CONFLICT]->(:Action) RETURN c.reason AS reason',
      { planId: o.plan.id },
    );
    expect(rows[0]?.reason).toMatch(/changed outside Backtrack/);
  });

  it('a too-shallow plan is honest: a later live writer outside the plan makes its step a conflict', async () => {
    const o = await plan('undo the address change', 1);
    if (o.kind !== 'plan') throw new Error('expected a plan');
    const res = await executeUndo(g, o.plan.id, { registry });
    expect(res.status).toBe('partial');
    const conflict = res.events.find((e) => e.type === 'undo.step' && e.status === 'conflict');
    expect(conflict).toMatchObject({ actionId: id.create_ticket });
  });

  it('refuses to undo an undo', async () => {
    const o = await plan('undo the credit');
    if (o.kind !== 'plan') throw new Error('expected a plan');
    const res = await executeUndo(g, o.plan.id, { registry });
    const { rows } = await g.read<{ id: string }>(
      "MATCH (u:Action {kind: 'undo'}) RETURN u.id AS id",
    );
    expect(rows).toHaveLength(1);
    const refused = await planUndo(g, { actionId: rows[0]?.id }, { registry });
    expect(refused.outcome.kind).toBe('none');
    if (refused.outcome.kind === 'none')
      expect(refused.outcome.reason).toMatch(/undoing an undo is refused/);
    expect(res.status).toBe('executed');
  });

  it('is idempotent: re-running an executed plan changes nothing', async () => {
    const o = await plan('undo the address change', 3);
    if (o.kind !== 'plan') throw new Error('expected a plan');
    await executeUndo(g, o.plan.id, { registry });
    const count = async () =>
      (await g.read<{ n: number }>('MATCH (a:Action) RETURN count(a) AS n')).rows[0]?.n;
    const before = await count();
    const again = await executeUndo(g, o.plan.id, { registry });
    expect(again.status).toBe('executed');
    expect(
      again.events
        .filter((e) => e.type === 'undo.step')
        .every((e) => e.type === 'undo.step' && e.status === 'skipped'),
    ).toBe(true);
    expect(await count()).toBe(before);
  });
});
