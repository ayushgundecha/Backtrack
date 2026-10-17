import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunEvent } from '../src/contracts/events.js';
import { createPolicy } from '../src/graph/queries.js';
import { startRun, startStep } from '../src/sdk/recorder.js';
import { defineTool } from '../src/sdk/registry.js';
import { runTool } from '../src/sdk/run.js';
import { getEntity } from '../src/world/store.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const order = { type: 'order', key: 'ord_1001' };

const setAddress = defineTool({
  name: 'update_address',
  description: 'Set the address.',
  input: z.object({ address: z.string() }),
  effect: 'reversible',
  inverse: 'restore_address',
  undoMode: 'restore',
  run: async (ctx, { address }) => {
    const before = (await getEntity(ctx.g, 'order', 'ord_1001'))?.address ?? null;
    return {
      result: { address },
      reads: [order],
      writes: [{ kind: 'update', entity: order, field: 'address', before, after: address }],
    };
  },
});
const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send.',
  input: z.object({}),
  effect: 'irreversible',
  mitigation: 'draft_correction_email',
  run: async () => ({
    result: { id: 'eml_1' },
    reads: [order],
    writes: [
      {
        kind: 'external',
        entity: { type: 'email', key: 'eml_1' },
        field: null,
        before: null,
        after: { id: 'eml_1', status: 'sent' },
      },
    ],
  }),
});

async function harness(decide: boolean) {
  const events: RunEvent[] = [];
  const { runId } = await startRun(g, {
    agentId: 'ops-agent',
    kind: 'agent',
    goal: 't',
    mode: 'replay',
  });
  let index = 0;
  const call = async (def: typeof setAddress | typeof sendEmail, args: Record<string, unknown>) => {
    const { stepId } = await startStep(g, { runId, index: index++, thought: def.name });
    return runTool(
      {
        g,
        runId,
        stepId,
        agentId: 'ops-agent',
        emit: (e) => void events.push(e),
        awaitApproval: async () => decide,
      },
      def,
      args,
    );
  };
  return { call, events };
}

describe('runTool', () => {
  beforeEach(async () => {
    await fresh(g);
  });

  it('records a reversible call as done in one go', async () => {
    const { call, events } = await harness(true);
    const out = await call(setAddress, { address: 'B' });
    expect(out.status).toBe('done');
    expect(events.map((e) => e.type)).toEqual(['action.recorded']);
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe('B');
  });

  it('pauses an irreversible call that would lock in work, then commits on approval', async () => {
    const { call, events } = await harness(true);
    await call(setAddress, { address: 'B' });
    const out = await call(sendEmail, {});
    expect(out.status).toBe('done');
    expect(events.map((e) => e.type)).toEqual([
      'action.recorded',
      'approval.requested',
      'approval.resolved',
      'action.recorded',
    ]);
    const asked = events[1];
    if (asked?.type !== 'approval.requested') throw new Error('expected approval.requested');
    expect(asked.reason).toBe('would lock in 1 reversible change: update_address');
    expect(await getEntity(g, 'email', 'eml_1')).toMatchObject({ status: 'sent' });
    const { rows } = await g.read<{ n: number }>(
      "MATCH (:User)-[r:APPROVED]->(:Action {tool: 'send_email'}) WHERE ID(r) >= 0 RETURN count(r) AS n",
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('a denial records DENIED and nothing is sent', async () => {
    const { call, events } = await harness(false);
    await call(setAddress, { address: 'B' });
    const out = await call(sendEmail, {});
    expect(out.status).toBe('denied');
    const last = events.at(-1);
    expect(last?.type === 'action.recorded' && last.action.status).toBe('denied');
    expect(await getEntity(g, 'email', 'eml_1')).toBeNull();
  });

  it('a block policy stops the call, records it as blocked and tells the agent why', async () => {
    await createPolicy(g, {
      policyId: 'pol_b',
      userId: 'ayush',
      rule: 'never re-route ord_1001 again',
      kind: 'block',
      tool: 'update_address',
      agentId: 'ops-agent',
      entityType: 'order',
      entityKey: 'ord_1001',
      createdFromPlanId: null,
      ts: Date.now(),
    });
    const { call, events } = await harness(true);
    const out = await call(setAddress, { address: 'B' });
    expect(out).toMatchObject({ status: 'blocked', policyId: 'pol_b' });
    expect(events.map((e) => e.type)).toEqual(['action.recorded', 'action.blocked']);
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe(
      '14 Marine Drive, Mumbai 400020',
    );
    const { rows } = await g.read<{ status: string }>(
      'MATCH (:Policy {id: $p})-[:BLOCKED]->(a:Action) RETURN a.status AS status',
      { p: 'pol_b' },
    );
    expect(rows).toEqual([{ status: 'blocked' }]);
  });

  it('validates arguments against the tool schema before anything runs', async () => {
    const { call } = await harness(true);
    await expect(call(setAddress, { address: 42 })).rejects.toThrow();
  });
});
