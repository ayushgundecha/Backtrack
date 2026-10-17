import { beforeEach, describe, expect, it } from 'vitest';
import { createPolicy } from '../src/graph/queries.js';
import {
  checkPolicies,
  lockInDecision,
  readDecision,
  recordDecision,
  waitForDecision,
} from '../src/sdk/gate.js';
import { commitPending, record, startRun, startStep } from '../src/sdk/recorder.js';
import { getEntity } from '../src/world/store.js';
import { OPS_STEPS, recordRun } from './golden.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();

/** Record the ops run up to post_message, then send_email as a pending action. */
async function pendingEmail() {
  await recordRun(g, 'ops-agent', OPS_STEPS.slice(0, 4));
  const email = OPS_STEPS[4];
  if (!email) throw new Error('fixture');
  const { runId } = await startRun(g, {
    agentId: 'ops-agent',
    kind: 'agent',
    goal: 'mail',
    mode: 'replay',
  });
  const { stepId } = await startStep(g, { runId, index: 0, thought: 'Confirm by email' });
  return record(g, {
    runId,
    stepId,
    agentId: 'ops-agent',
    tool: 'send_email',
    args: {},
    kind: 'do',
    status: 'pending',
    ...email.flags,
    outcome: { result: null, reads: email.reads, writes: email.writes },
  });
}

describe('gate', () => {
  beforeEach(async () => {
    await fresh(g);
  });

  it('asks for approval when an irreversible action would lock in 3 reversible changes', async () => {
    const pending = await pendingEmail();
    const { decision, traces } = await lockInDecision(g, pending.action.id, 'send_email');
    expect(decision).toEqual({
      decision: 'user-approval',
      reason: 'would lock in 3 reversible changes: update_address, create_ticket, post_message',
      wouldLock: 3,
      lockedTools: ['update_address', 'create_ticket', 'post_message'],
      policyId: null,
    });
    expect(traces[0]).toMatchObject({ query: 'Q4', rows: 3 });
  });

  it('approves an irreversible action that builds on nothing reversible', async () => {
    const { runId } = await startRun(g, {
      agentId: 'ops-agent',
      kind: 'agent',
      goal: 'x',
      mode: 'replay',
    });
    const { stepId } = await startStep(g, { runId, index: 0, thought: 'mail first' });
    const lonely = await record(g, {
      runId,
      stepId,
      agentId: 'ops-agent',
      tool: 'send_email',
      args: {},
      kind: 'do',
      status: 'pending',
      reversible: false,
      inverseTool: null,
      mitigationTool: 'draft_correction_email',
      outcome: { result: null, reads: [{ type: 'customer', key: 'cust_42' }], writes: [] },
    });
    expect((await lockInDecision(g, lonely.action.id, 'send_email')).decision.decision).toBe(
      'approved',
    );
  });

  it('a block policy denies before anything else; confirm asks; warn passes with a note', async () => {
    const base = { userId: 'ayush', createdFromPlanId: null, ts: Date.now(), agentId: null };
    const input = {
      tool: 'update_address',
      agentId: 'ops-agent',
      entities: ['order:ord_1001'],
      reversible: true,
    };
    expect((await checkPolicies(g, input)).decision.decision).toBe('approved');
    await createPolicy(g, {
      ...base,
      policyId: 'pol_w',
      rule: 'address changes are audited',
      kind: 'warn',
      tool: 'update_address',
      entityType: null,
      entityKey: null,
    });
    const warned = await checkPolicies(g, input);
    expect(warned.decision).toMatchObject({
      decision: 'approved',
      reason: expect.stringContaining('audited'),
    });
    await createPolicy(g, {
      ...base,
      policyId: 'pol_c',
      rule: 'ask before re-routing',
      kind: 'confirm',
      tool: 'update_address',
      entityType: null,
      entityKey: null,
    });
    expect((await checkPolicies(g, input)).decision).toMatchObject({
      decision: 'user-approval',
      policyId: 'pol_c',
    });
    await createPolicy(g, {
      ...base,
      policyId: 'pol_b',
      rule: 'never re-route ord_1001 again',
      kind: 'block',
      tool: 'update_address',
      entityType: 'order',
      entityKey: 'ord_1001',
    });
    expect((await checkPolicies(g, input)).decision).toMatchObject({
      decision: 'denied',
      reason: 'Blocked by policy: never re-route ord_1001 again',
      policyId: 'pol_b',
    });
  });

  it('records APPROVED and DENIED as User edges; denial marks the action and keeps the world', async () => {
    const pending = await pendingEmail();
    expect(await readDecision(g, pending.action.id)).toBeNull();
    await recordDecision(g, { actionId: pending.action.id, approved: false });
    expect(await waitForDecision(g, pending.action.id, { pollMs: 10 })).toEqual({
      approved: false,
      by: 'ayush',
    });
    expect(await getEntity(g, 'email', 'eml_1')).toBeNull();
    await expect(commitPending(g, pending)).rejects.toThrow(/no longer pending/);
    const { rows } = await g.read<{ t: string; status: string }>(
      'MATCH (:User {id: $u})-[r]->(a:Action {id: $id}) RETURN type(r) AS t, a.status AS status',
      { u: 'ayush', id: pending.action.id },
    );
    expect(rows).toEqual([{ t: 'DENIED', status: 'denied' }]);
  });

  it('an approval arriving from elsewhere releases a waiting run', async () => {
    const pending = await pendingEmail();
    const waiting = waitForDecision(g, pending.action.id, { pollMs: 20, timeoutMs: 2_000 });
    setTimeout(() => void recordDecision(g, { actionId: pending.action.id, approved: true }), 60);
    expect(await waiting).toEqual({ approved: true, by: 'ayush' });
    await commitPending(g, pending);
    expect(await getEntity(g, 'email', 'eml_1')).toMatchObject({ status: 'sent' });
  });
});
