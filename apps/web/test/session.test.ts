import type { RunEvent } from '@backtrack/core/contracts';
import { describe, expect, it } from 'vitest';
import { MockApiClient } from '../lib/mock';
import { initialSession, pendingApproval, type SessionState, sessionReducer } from '../lib/session';

const fold = (events: RunEvent[], from: SessionState = initialSession) =>
  events.reduce(sessionReducer, from);

/** Collects a run's events up to (and including) the first approval request. */
async function untilApproval(stream: AsyncIterator<RunEvent>) {
  const events: RunEvent[] = [];
  while (true) {
    const { value, done } = await stream.next();
    if (done) return events;
    events.push(value);
    if (value.type === 'approval.requested') return events;
  }
}

describe('sessionReducer', () => {
  it('pauses on the approval, then attaches it and the recorded action to the same step', async () => {
    const client = new MockApiClient({ stepDelayMs: 0 });
    const stream = client.runAgent({ agent: 'ops-agent', mode: 'replay' })[Symbol.asyncIterator]();

    const paused = fold(await untilApproval(stream));
    expect(paused.runs[0]?.status).toBe('paused');
    expect(paused.steps).toHaveLength(5);
    const approval = pendingApproval(paused);
    expect(approval).toMatchObject({ tool: 'send_email', wouldLock: 3, state: 'pending' });
    if (!approval) throw new Error('expected a pending approval');

    await client.approval({ runId: approval.runId, actionId: approval.actionId, approved: true });
    const rest: RunEvent[] = [];
    for (let r = await stream.next(); !r.done; r = await stream.next()) rest.push(r.value);
    const done = fold(rest, paused);

    expect(done.runs[0]?.status).toBe('done');
    expect(pendingApproval(done)).toBeNull();
    const emailStep = done.steps[4];
    expect(emailStep?.approval?.state).toBe('approved');
    expect(emailStep?.action).toMatchObject({ tool: 'send_email', status: 'done' });
    expect(done.steps.map((s) => s.action?.tool)).toEqual([
      'lookup_order',
      'update_address',
      'create_ticket',
      'post_message',
      'send_email',
      'schedule_followup',
    ]);
  });

  it('tracks undo execution per step and its final status', () => {
    const step = (order: number, status: 'started' | 'done'): RunEvent => ({
      type: 'undo.step',
      planId: 'plan_1',
      order,
      actionId: `act_${order}`,
      mode: 'restore',
      status,
      label: `restore ${order}`,
      entity: null,
    });
    const state = fold([
      step(1, 'started'),
      step(1, 'done'),
      step(2, 'started'),
      { type: 'undo.finished', planId: 'plan_1', status: 'partial' },
    ]);
    expect(state.undo?.status).toBe('partial');
    expect(state.undo?.steps[1]?.status).toBe('done');
    expect(state.undo?.steps[2]?.status).toBe('started');
  });
});
