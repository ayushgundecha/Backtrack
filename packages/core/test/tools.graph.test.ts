import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type GraphToolContext, graphTools, runGraphTool } from '../src/agents/tools.graph.js';
import { createToolRegistry } from '../src/agents/tools.js';
import { buildGolden } from './golden.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const ctx: GraphToolContext = { g, registry: createToolRegistry() };
let id: Record<string, string>;

/** Run a tool and return its result, failing the test with the tool's own message if it erred. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const out = await runGraphTool(ctx, name, args);
  if (!out.ok) throw new Error(out.error);
  return out.result as Record<string, unknown>;
}

describe('graph tools', () => {
  beforeAll(async () => {
    await fresh(g);
    id = await buildGolden(g);
  });

  it('expose the catalogue from PLAN §6 with flat, stable schemas', () => {
    const schemas = graphTools.map((t) => ({
      name: t.name,
      description: t.description,
      input: z.toJSONSchema(t.input, { io: 'input' }),
    }));
    // Flat: every argument is a primitive or an enum, never an object or an array.
    for (const { name, input } of schemas) {
      for (const [arg, prop] of Object.entries(input.properties ?? {})) {
        const type = (prop as { type?: string }).type;
        expect(['string', 'number', 'integer', 'boolean'], `${name}.${arg}`).toContain(type);
      }
    }
    expect(schemas).toMatchSnapshot();
  });

  it('resolve_action finds the action a request means, and lists candidates when it cannot', async () => {
    const hit = await call('resolve_action', { text: 'undo the address change' });
    expect(hit.action).toMatchObject({ id: id.update_address, tool: 'update_address' });

    const miss = await call('resolve_action', { actionId: 'act_nope0000' });
    expect(miss.action).toBeNull();
    expect(miss.candidates).toHaveLength(3);
  });

  it('plan_undo on an id the graph does not know is the unknown outcome, with candidates', async () => {
    const outcome = await call('plan_undo', { actionId: 'act_nope0000' });
    expect(outcome).toMatchObject({ kind: 'unknown', query: 'act_nope0000' });
    // The three latest original actions, so the person can pick the one they meant.
    expect((outcome.candidates as Array<{ tool: string }>).map((c) => c.tool)).toEqual([
      'apply_credit',
      'lookup_ticket',
      'list_open_tickets',
    ]);
  });

  it('turns bad arguments and unknown ids into messages the model can act on', async () => {
    expect(await runGraphTool(ctx, 'execute_undo', { planId: 'plan_x' })).toEqual({
      ok: false,
      error: expect.stringMatching(/^Invalid arguments for execute_undo: confirmed:/),
    });
    expect(await runGraphTool(ctx, 'explain_action', { actionId: 'act_nope0000' })).toEqual({
      ok: false,
      error: 'No action act_nope0000; call list_actions for valid ids',
    });
    expect(await runGraphTool(ctx, 'rehearse_undo', { planId: 'plan_nope' })).toMatchObject({
      ok: false,
      error: 'No undo plan plan_nope; call plan_undo first',
    });
    expect(await runGraphTool(ctx, 'drop_graph', {})).toEqual({
      ok: false,
      error: 'Unknown tool drop_graph',
    });
  });

  it('answers with evidence: the named queries behind each result', async () => {
    const out = await runGraphTool(ctx, 'path_between', {
      fromActionId: id.update_address,
      toActionId: id.apply_credit,
    });
    if (!out.ok) throw new Error(out.error);
    expect(out.result).toMatchObject({
      path: { tools: ['update_address', 'create_ticket', 'post_message', 'apply_credit'] },
    });
    expect(out.traces.map((t) => t.query)).toEqual(['Q11']);
    expect(out.traces[0]?.cypher).toContain('algo.SPpaths');
  });

  it('plan → rehearse → execute (only when confirmed) → recall, end to end', async () => {
    const outcome = await call('plan_undo', { text: 'undo the address change', depth: 3 });
    expect(outcome.kind).toBe('plan');
    const plan = outcome.plan as { id: string; steps: unknown[] };
    expect(plan.steps).toHaveLength(6);

    const diff = await call('rehearse_undo', { planId: plan.id });
    expect((diff.changes as unknown[]).length).toBeGreaterThan(0);

    const done = await call('execute_undo', { planId: plan.id, confirmed: true });
    expect(done).toMatchObject({ planId: plan.id, status: 'executed' });
    expect(done.steps).toHaveLength(6);

    const memory = await call('recall', { actionId: id.update_address });
    expect(memory.memories).toEqual([
      expect.objectContaining({ kind: 'plan', id: plan.id, status: 'executed' }),
    ]);
    expect(await call('plan_undo', { actionId: id.update_address })).toMatchObject({
      kind: 'memory',
    });
  });

  it('set_policy needs a whole entity reference, then records the rule', async () => {
    expect(
      await runGraphTool(ctx, 'set_policy', { rule: 'r', kind: 'block', entityType: 'order' }),
    ).toEqual({ ok: false, error: 'Give both entityType and entityKey, or neither' });
    const policy = await call('set_policy', {
      rule: 'never re-route ord_1001 again',
      kind: 'block',
      tool: 'update_address',
      entityType: 'order',
      entityKey: 'ord_1001',
    });
    expect(policy).toMatchObject({ kind: 'block', entity: { type: 'order', key: 'ord_1001' } });
  });
});
