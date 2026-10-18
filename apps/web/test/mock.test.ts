/**
 * The mock client must behave like the engine in the design notes, because the panel is built
 * against it before the real routes exist. These tests pin the golden demo: event order, the gate
 * reason, the DEPENDS_ON edges, the depth-dependent undo plan and its execution.
 */
import type { RunEvent, UndoOutcome } from '@backtrack/core/contracts';
import { describe, expect, it } from 'vitest';
import { MockApiClient } from '../lib/mock';

/** Drains a run, answering the approval as soon as it is requested. */
async function drain(stream: AsyncIterable<RunEvent>, client: MockApiClient, approve = true) {
  const events: RunEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === 'approval.requested') {
      expect(
        await client.approval({ runId: e.runId, actionId: e.actionId, approved: approve }),
      ).toEqual({ ok: true });
    }
  }
  return events;
}

const newClient = () => new MockApiClient({ stepDelayMs: 0, undoStepDelayMs: 0 });

async function goldenWorld() {
  const client = newClient();
  const ops = await drain(client.runAgent({ agent: 'ops-agent', mode: 'replay' }), client);
  const billing = await drain(client.runAgent({ agent: 'billing-agent', mode: 'replay' }), client);
  const { actions } = await client.actions();
  const idOf = (tool: string) => actions.find((a) => a.tool === tool)?.id as string;
  return { client, ops, billing, idOf };
}

const planTools = (outcome: UndoOutcome) =>
  outcome.kind === 'plan' ? outcome.plan.steps.map((s) => s.tool) : outcome.kind;

describe('mock client: golden ops and billing runs', () => {
  it('emits the engine event order and pauses send_email with the lock-in reason', async () => {
    const { ops } = await goldenWorld();
    expect(
      ops.map((e) => (e.type === 'action.recorded' ? `recorded:${e.action.tool}` : e.type)),
    ).toEqual([
      'run.started',
      'step',
      'recorded:lookup_order',
      'step',
      'recorded:update_address',
      'step',
      'recorded:create_ticket',
      'step',
      'recorded:post_message',
      'step',
      'approval.requested',
      'approval.resolved',
      'recorded:send_email',
      'step',
      'recorded:schedule_followup',
      'run.finished',
    ]);
    const approval = ops.find((e) => e.type === 'approval.requested');
    expect(approval).toMatchObject({
      tool: 'send_email',
      reason: 'would lock in 3 reversible changes: update_address, create_ticket, post_message',
      wouldLock: 3,
    });
  });

  it('derives DEPENDS_ON exactly as the golden graph table', async () => {
    const { client } = await goldenWorld();
    const graph = await client.graph();
    const tool = new Map(graph.nodes.map((n) => [n.id, n.tool]));
    const edges = graph.links
      .filter((l) => l.type === 'DEPENDS_ON')
      .map((l) => `${tool.get(l.source)}->${tool.get(l.target)}`);
    expect(edges).toEqual([
      'create_ticket->update_address',
      'post_message->create_ticket',
      'send_email->update_address',
      'send_email->post_message',
      'schedule_followup->post_message',
      'list_open_tickets->post_message',
      'lookup_ticket->post_message',
      'apply_credit->post_message',
    ]);
    const world = await client.world();
    const order = world.entities.find((e) => e.key === 'ord_1001');
    expect(order?.state.address).toBe('221B Baker Street, London NW1 6XE');
    expect(world.entities.filter((e) => e.type === 'credit').map((e) => e.key)).toEqual(['cr_1']);
  });

  it('plans the undo of update_address by depth, cross-agent at depth 3', async () => {
    const { client, idOf } = await goldenWorld();
    const actionId = idOf('update_address');
    expect(planTools(await client.undo({ actionId, depth: 1 }))).toEqual([
      'send_email',
      'create_ticket',
      'update_address',
    ]);
    expect(planTools(await client.undo({ actionId, depth: 2 }))).toEqual([
      'send_email',
      'post_message',
      'create_ticket',
      'update_address',
    ]);
    const deep = await client.undo({ text: 'undo the address change', depth: 3 });
    if (deep.kind !== 'plan') throw new Error(`expected a plan, got ${deep.kind}`);
    expect(deep.plan.steps.map((s) => s.label)).toEqual([
      'revoke_credit cr_1 (apply_credit)',
      'cancel_event evt_1 (schedule_followup)',
      'draft_correction_email eml_1 (send_email)',
      'delete_message msg_1 (post_message)',
      'close_ticket tkt_1 (create_ticket)',
      'restore_address ord_1001 (update_address)',
    ]);
    expect(deep.plan.crossAgent).toEqual([
      { agentId: 'billing-agent', actionId: idOf('apply_credit'), tool: 'apply_credit', hops: 3 },
    ]);
    const credit = deep.plan.steps[0];
    // Tool names from the root to the dependent, both included (the engine's Q1 `via`).
    expect(credit?.via).toEqual([
      'update_address',
      'create_ticket',
      'post_message',
      'apply_credit',
    ]);
    expect(deep.plan.steps.at(-1)?.via).toEqual(['update_address']);
    expect(deep.plan.blast).toMatchObject({ actions: 6, irreversible: 1 });
  });

  it('answers unknown, none and memory honestly', async () => {
    const { client, idOf } = await goldenWorld();
    const unknown = await client.undo({ text: 'undo the weather' });
    expect(unknown.kind === 'unknown' && unknown.candidates.map((c) => c.tool)).toEqual([
      'apply_credit',
      'lookup_ticket',
      'list_open_tickets',
    ]);
    // A lookup changed nothing; a leaf change is still a (one-step) plan, as in the engine.
    const none = await client.undo({ actionId: idOf('lookup_order') });
    expect(none.kind === 'none' && none.reason).toBe(
      'lookup_order (seq 1) only read; it changed nothing, so there is nothing to undo',
    );
    const leaf = await client.undo({ actionId: idOf('schedule_followup') });
    expect(planTools(leaf)).toEqual(['schedule_followup']);

    const outcome = await client.undo({ actionId: idOf('update_address'), depth: 3 });
    if (outcome.kind !== 'plan') throw new Error('expected a plan');
    const rehearsal = await client.rehearse(outcome.plan.id);
    expect(rehearsal.changes).toContainEqual(
      expect.objectContaining({ field: 'address', to: '14 Marine Drive, Mumbai 400020' }),
    );
    const events: RunEvent[] = [];
    for await (const e of client.executeUndo(outcome.plan.id)) events.push(e);
    expect(events.filter((e) => e.type === 'undo.step' && e.status === 'done')).toHaveLength(6);
    expect(events.at(-1)).toEqual({
      type: 'undo.finished',
      planId: outcome.plan.id,
      status: 'executed',
    });

    const world = await client.world();
    expect(world.entities.find((e) => e.key === 'ord_1001')?.state.address).toBe(
      '14 Marine Drive, Mumbai 400020',
    );
    expect(world.entities.filter((e) => e.type === 'email').map((e) => e.state.status)).toEqual([
      'sent',
      'draft',
    ]);
    expect((await client.undo({ text: 'undo the address change' })).kind).toBe('memory');
  });

  it('is deterministic across instances', async () => {
    const [a, b] = await Promise.all([goldenWorld(), goldenWorld()]);
    expect(a.ops).toEqual(b.ops);
    expect(await a.client.graph()).toEqual(await b.client.graph());
  });
});
