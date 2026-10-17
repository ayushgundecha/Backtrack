import { beforeEach, describe, expect, it } from 'vitest';
import billingJson from '../../../fixtures/billing-run.json' with { type: 'json' };
import opsJson from '../../../fixtures/ops-run.json' with { type: 'json' };
import { compensationTools } from '../src/agents/tools.js';
import { RunFixture } from '../src/contracts/fixtures.js';
import { q1Downstream, q4LockIn } from '../src/graph/queries.js';
import type { RecordedAction } from '../src/sdk/recorder.js';
import { actionFlags } from '../src/sdk/registry.js';
import { getEntity } from '../src/world/store.js';
import { BILLING_STEPS, OPS_STEPS, recordRun } from './golden.js';
import { fresh, testGraph } from './helpers.js';
import { keys, newRun, registry } from './tool-harness.js';

const g = testGraph();

/** The ops side of the handoff: a ticket for cust_42 on ord_1001. */
async function opsOpensTicket() {
  const ops = await newRun(g, 'ops-agent');
  return ops('create_ticket', {
    customerId: 'cust_42',
    subject: 'Address correction for ord_1001',
    body: 'Shipping address changed',
  });
}

describe('billing tools', () => {
  let call: Awaited<ReturnType<typeof newRun>>;
  beforeEach(async () => {
    await fresh(g);
    call = await newRun(g, 'billing-agent');
  });

  it('list_open_tickets finds the tickets another agent opened, and reads each of them', async () => {
    expect((await call('list_open_tickets', {})).out).toEqual({
      result: { tickets: [] },
      reads: [],
      writes: [],
    });
    const created = await opsOpensTicket();
    const { out, rec } = await call('list_open_tickets', {});
    expect(out.result).toEqual({
      tickets: [
        {
          id: 'tkt_1',
          customerId: 'cust_42',
          orderId: 'ord_1001',
          subject: 'Address correction for ord_1001',
        },
      ],
    });
    expect(keys(out.reads)).toEqual(['ticket:tkt_1']);
    expect(out.writes).toEqual([]);
    // The handoff is in the graph: billing's read depends on the ops action that wrote the ticket.
    expect(rec.dependsOn).toEqual([created.rec.action.id]);

    const ops = await newRun(g, 'ops-agent');
    await ops(
      'close_ticket',
      { actionId: created.rec.action.id },
      {
        kind: 'undo',
        undoes: created.rec.action.id,
      },
    );
    expect((await call('list_open_tickets', {})).out.result).toEqual({ tickets: [] });
  });

  it('lookup_ticket returns the ticket and reads only it', async () => {
    await opsOpensTicket();
    const { out } = await call('lookup_ticket', { ticketId: 'tkt_1' });
    expect(out.result).toMatchObject({
      id: 'tkt_1',
      customerId: 'cust_42',
      subject: 'Address correction for ord_1001',
      status: 'open',
    });
    expect(keys(out.reads)).toEqual(['ticket:tkt_1']);
    expect(out.writes).toEqual([]);
    await expect(call('lookup_ticket', { ticketId: 'tkt_9' })).rejects.toThrow(
      'Unknown ticket tkt_9',
    );
  });

  it('apply_credit reads the customer and their open ticket, creates cr_1; revoke_credit removes it', async () => {
    await expect(
      call('apply_credit', { customerId: 'cust_42', amount: 10, reason: 'Goodwill' }),
    ).rejects.toThrow('cust_42 has no open ticket');
    await opsOpensTicket();
    const { out, rec } = await call('apply_credit', {
      customerId: 'cust_42',
      amount: 10,
      reason: 'Address correction for ord_1001',
    });
    expect(out.result).toEqual({
      id: 'cr_1',
      customerId: 'cust_42',
      ticketId: 'tkt_1',
      amount: 10,
      reason: 'Address correction for ord_1001',
    });
    expect(keys(out.reads)).toEqual(['customer:cust_42', 'ticket:tkt_1']);
    expect(out.writes).toEqual([
      expect.objectContaining({
        kind: 'create',
        before: null,
        after: expect.objectContaining({ id: 'cr_1', ticketId: 'tkt_1', status: 'active' }),
      }),
    ]);
    expect(rec.action.inverseTool).toBe('revoke_credit');

    await call(
      'revoke_credit',
      { actionId: rec.action.id },
      {
        kind: 'undo',
        undoes: rec.action.id,
      },
    );
    expect(await getEntity(g, 'credit', 'cr_1')).toBeNull();
    await expect(
      call('apply_credit', {
        customerId: 'cust_41',
        amount: 5,
        reason: 'Wrong',
        ticketId: 'tkt_1',
      }),
    ).rejects.toThrow('tkt_1 is not an open ticket of cust_41');
    await expect(
      call('apply_credit', { customerId: 'cust_42', amount: -5, reason: 'Negative' }),
    ).rejects.toThrow();
  });
});

describe('tool registry', () => {
  it('resolves every inverse and mitigation an Action can name, all taking { actionId }', () => {
    for (const def of registry.list()) {
      const { inverseTool, mitigationTool } = actionFlags(def);
      for (const name of [inverseTool, mitigationTool]) {
        if (name) expect(registry.get(name).effect, `${def.name} → ${name}`).toBe('compensation');
      }
    }
    for (const def of compensationTools) {
      expect(def.input.parse({ actionId: 'act_1' })).toEqual({ actionId: 'act_1' });
    }
  });
});

/** Resolve `{ "$ref": "steps.N.result.path" }` args against earlier results (replay does this for real in BT-032). */
function resolveArgs(args: RunFixture['steps'][number]['args'], results: unknown[]) {
  const steps = results.map((result) => ({ result }));
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => {
      if (value === null || typeof value !== 'object') return [name, value];
      const found = value.$ref
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], { steps });
      if (found === undefined) throw new Error(`Unresolved ${value.$ref}`);
      return [name, found];
    }),
  );
}

async function replay(fixture: RunFixture): Promise<Record<string, RecordedAction>> {
  const call = await newRun(g, fixture.agentId);
  const results: unknown[] = [];
  const recorded: Record<string, RecordedAction> = {};
  for (const step of fixture.steps) {
    const { out, rec } = await call(step.tool, resolveArgs(step.args, results));
    results.push(out.result);
    recorded[step.tool] = rec;
  }
  return recorded;
}

/** DEPENDS_ON as `tool → [tools it depends on]`, as the recorder derived it. */
function dependencyGraph(recorded: Record<string, RecordedAction>) {
  const toolOf = new Map(Object.values(recorded).map((r) => [r.action.id, r.action.tool]));
  return Object.fromEntries(
    Object.values(recorded).map((r) => [
      r.action.tool,
      r.dependsOn.map((id) => toolOf.get(id)).sort(),
    ]),
  );
}

describe('the demo fixtures through the real tools', () => {
  it('derive exactly the golden DEPENDS_ON graph, cascade and gate', async () => {
    await fresh(g);
    const golden = dependencyGraph({
      ...(await recordRun(g, 'ops-agent', OPS_STEPS)),
      ...(await recordRun(g, 'billing-agent', BILLING_STEPS)),
    });

    await fresh(g);
    const ops = await replay(RunFixture.parse(opsJson));
    const billing = await replay(RunFixture.parse(billingJson));
    const recorded = { ...ops, ...billing };
    expect(dependencyGraph(recorded)).toEqual(golden);
    expect(golden.send_email).toEqual(['post_message', 'update_address']);

    const root = { actionId: ops.update_address?.action.id as string };
    const closure = await q1Downstream(g, root, { depth: 3 });
    expect(closure.rows.map((r) => r.tool)).toEqual([
      'apply_credit',
      'schedule_followup',
      'send_email',
      'post_message',
      'create_ticket',
    ]);
    expect(closure.rows.find((r) => r.tool === 'apply_credit')).toMatchObject({
      hops: 3,
      agentId: 'billing-agent',
      via: ['update_address', 'create_ticket', 'post_message', 'apply_credit'],
    });

    const lockIn = await q4LockIn(g, { actionId: ops.send_email?.action.id as string });
    expect(lockIn.rows.map((r) => r.tool)).toEqual([
      'update_address',
      'create_ticket',
      'post_message',
    ]);

    // The world the two runs left behind.
    expect(await getEntity(g, 'credit', 'cr_1')).toMatchObject({
      customerId: 'cust_42',
      ticketId: 'tkt_1',
      reason: 'Address correction for ord_1001',
    });
    expect(await getEntity(g, 'ticket', 'tkt_1')).toMatchObject({ thread: 'msg_1' });
    expect(await getEntity(g, 'email', 'eml_1')).toMatchObject({ status: 'sent' });
  });
});
