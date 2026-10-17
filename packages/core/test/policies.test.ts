import { beforeEach, describe, expect, it } from 'vitest';
import { loadRunFixture } from '../src/agents/fixtures.js';
import { replayRun } from '../src/agents/replay.js';
import { createToolRegistry } from '../src/agents/tools.js';
import type { RunEvent } from '../src/contracts/events.js';
import { q13Recall } from '../src/graph/queries.js';
import { PolicyError, setPolicy } from '../src/sdk/policies.js';
import { getEntity } from '../src/world/store.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const registry = createToolRegistry();
const order = { type: 'order', key: 'ord_1001' };

async function replayOps(approve = true) {
  const events: RunEvent[] = [];
  const result = await replayRun(g, loadRunFixture('ops-agent'), {
    registry,
    paceMs: 0,
    emit: (e) => void events.push(e),
    awaitApproval: async () => approve,
  });
  return { result, events };
}

const policyCount = async () =>
  (await g.read<{ n: number }>('MATCH (p:Policy) RETURN count(p) AS n')).rows[0]?.n;

describe('setPolicy', () => {
  beforeEach(async () => {
    await fresh(g);
  });

  it('a block policy set after an undo stops the agent on the next run, and the agent is told why', async () => {
    const policy = await setPolicy(g, {
      rule: 'ops-agent must not email customers',
      kind: 'block',
      tool: 'send_email',
      agentId: 'ops-agent',
      entity: null,
      createdFromPlanId: 'plan_prior',
    });
    expect(policy.id).toMatch(/^pol_/);

    const { result, events } = await replayOps();
    expect(result.status).toBe('done');
    expect(events.find((e) => e.type === 'action.blocked')).toMatchObject({
      tool: 'send_email',
      policyId: policy.id,
      rule: 'ops-agent must not email customers',
    });
    // Blocked before the gate: nobody was asked, nothing was sent, and the graph says why.
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
    expect(await getEntity(g, 'email', 'eml_1')).toBeNull();
    const { rows } = await g.read<{ tool: string; status: string }>(
      'MATCH (:Policy {id: $id})-[:BLOCKED]->(a:Action) RETURN a.tool AS tool, a.status AS status',
      { id: policy.id },
    );
    expect(rows).toEqual([{ tool: 'send_email', status: 'blocked' }]);
    const recall = await q13Recall(g, {
      actionId: null,
      tool: 'send_email',
      type: null,
      key: null,
    });
    expect(recall.rows).toEqual([expect.objectContaining({ kind: 'policy', id: policy.id })]);
  });

  it('a policy scoped to another agent does not touch this one', async () => {
    await setPolicy(g, {
      rule: 'billing-agent must not email',
      kind: 'block',
      tool: 'send_email',
      agentId: 'billing-agent',
      entity: null,
      createdFromPlanId: null,
    });
    const { events } = await replayOps();
    expect(events.some((e) => e.type === 'action.blocked')).toBe(false);
    expect(await getEntity(g, 'email', 'eml_1')).toMatchObject({ status: 'sent' });
  });

  it('an entity-only policy (no tool) asks before any tool changes that entity', async () => {
    await setPolicy(g, {
      rule: 'confirm every call that touches ord_1001',
      kind: 'confirm',
      tool: null,
      agentId: null,
      entity: order,
      createdFromPlanId: null,
    });
    const { events } = await replayOps(false);
    const asked = events.filter((e) => e.type === 'approval.requested').map((e) => e.tool);
    // lookup_order reads ord_1001 and update_address writes it; both touch it, both are asked.
    expect(asked.slice(0, 2)).toEqual(['lookup_order', 'update_address']);
    expect(events.find((e) => e.type === 'approval.requested')).toMatchObject({
      reason: 'A policy asks for confirmation: confirm every call that touches ord_1001',
    });
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe(
      '14 Marine Drive, Mumbai 400020',
    );
  });

  it('refuses a scope that does not exist instead of widening the rule to everything', async () => {
    const base = { rule: 'r', kind: 'block' as const, createdFromPlanId: null };
    await expect(
      setPolicy(g, { ...base, tool: 'send_email', agentId: 'ops-agnet', entity: null }),
    ).rejects.toThrow(new PolicyError('Unknown agent ops-agnet'));
    await expect(
      setPolicy(g, { ...base, tool: null, agentId: null, entity: { type: 'order', key: 'ord_9' } }),
    ).rejects.toThrow('Unknown entity order:ord_9');
    await expect(
      setPolicy(g, { ...base, tool: null, agentId: null, entity: null }),
    ).rejects.toThrow(/must name a tool, an entity, or both/);
    expect(await policyCount()).toBe(0);
  });
});
