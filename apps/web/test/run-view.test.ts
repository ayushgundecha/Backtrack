/**
 * What a step card shows at each point of the stream: the call is known from the gate before it is
 * recorded, a denied call keeps its tool, and dependencies are named by tool and seq.
 */
import type { GraphSnapshot, RunEvent } from '@backtrack/core/contracts';
import { describe, expect, it } from 'vitest';
import { MockApiClient } from '../lib/mock';
import { approverOf, recordedActions, stepCall, stepPhase } from '../lib/run-view';
import { initialSession, pendingApproval, type SessionState, sessionReducer } from '../lib/session';

/** Streams the ops run, folding every event, and answers the gate with `approved`. */
async function opsRun(approved: boolean) {
  const client = new MockApiClient({ stepDelayMs: 0 });
  const snapshots: { event: RunEvent; state: SessionState }[] = [];
  let state = initialSession;
  for await (const event of client.runAgent({ agent: 'ops-agent', mode: 'replay' })) {
    state = sessionReducer(state, event);
    snapshots.push({ event, state });
    if (event.type === 'approval.requested') {
      await client.approval({ runId: event.runId, actionId: event.actionId, approved });
    }
  }
  return { state, snapshots };
}

describe('run view', () => {
  it('shows a step as waiting for its call until the action is recorded', async () => {
    const { snapshots } = await opsRun(true);
    const firstStep = snapshots.find((s) => s.event.type === 'step')?.state.steps[0];
    if (!firstStep) throw new Error('expected a step');
    expect(stepPhase(firstStep)).toBe('calling');
    expect(stepCall(firstStep)).toBeNull();
  });

  it('knows the gated call from approval.requested, then the answer and who gave it', async () => {
    const { snapshots, state } = await opsRun(true);
    const paused = snapshots.find((s) => s.event.type === 'approval.requested')?.state;
    if (!paused) throw new Error('expected the gate');
    const gated = paused.steps.at(-1);
    if (!gated) throw new Error('expected a gated step');
    expect(stepPhase(gated)).toBe('awaiting-approval');
    expect(stepCall(gated)).toMatchObject({
      tool: 'send_email',
      actionId: gated.approval?.actionId,
    });
    expect(pendingApproval(paused)?.reason).toBe(
      'would lock in 3 reversible changes: update_address, create_ticket, post_message',
    );

    const email = state.steps[4];
    expect(email?.approval).toMatchObject({ state: 'approved', by: 'ayush' });
    expect(email && stepPhase(email)).toBe('recorded');
  });

  it('keeps a denied call on screen with its tool and no recorded action', async () => {
    const { state } = await opsRun(false);
    const email = state.steps[4];
    if (!email) throw new Error('expected the email step');
    expect(email.action).toBeNull();
    expect(stepPhase(email)).toBe('denied');
    expect(stepCall(email)?.tool).toBe('send_email');
    expect(email.approval?.by).toBe('ayush');
    expect(state.runs[0]?.status).toBe('done');
  });

  it('names each dependency by the tool and seq that recorded it', async () => {
    const { state } = await opsRun(true);
    const refs = recordedActions(state);
    const email = state.steps[4];
    const named = email?.dependsOn.map((id) => refs.get(id));
    expect(named).toEqual([
      { tool: 'update_address', seq: 2 },
      { tool: 'post_message', seq: 4 },
    ]);
  });

  it('carries the tool of a policy-blocked call', () => {
    const state = [
      { type: 'step', runId: 'run_1', stepId: 'stp_1', index: 0, thought: 'Email them.', ts: 1 },
      {
        type: 'action.blocked',
        runId: 'run_1',
        actionId: 'act_9',
        tool: 'send_email',
        policyId: 'pol_1',
        rule: 'never email from ops-agent',
      },
    ].reduce((s, e) => sessionReducer(s, e as RunEvent), initialSession);
    const step = state.steps[0];
    if (!step) throw new Error('expected a step');
    expect(stepPhase(step)).toBe('blocked');
    expect(stepCall(step)).toEqual({ tool: 'send_email', args: {}, actionId: 'act_9' });
  });
});

describe('approverOf', () => {
  const graph: GraphSnapshot = {
    nodes: [
      { id: 'ayush', label: 'User', title: 'Ayush' },
      { id: 'act_5', label: 'Action', title: 'send_email', tool: 'send_email', seq: 5 },
    ],
    links: [{ source: 'ayush', target: 'act_5', type: 'APPROVED' }],
  };

  it("names the approver from the graph's User node and sees the APPROVED edge", () => {
    expect(approverOf(graph, 'ayush', 'act_5', true)).toEqual({
      userId: 'ayush',
      name: 'Ayush',
      recorded: true,
    });
    // A denial is a different edge; the APPROVED one does not count for it.
    expect(approverOf(graph, 'ayush', 'act_5', false).recorded).toBe(false);
  });

  it('claims no name the graph does not hold', () => {
    expect(approverOf(null, 'ayush', 'act_5', true)).toEqual({
      userId: 'ayush',
      name: null,
      recorded: false,
    });
    const unnamed: GraphSnapshot = {
      nodes: [{ id: 'ayush', label: 'User', title: 'ayush' }],
      links: [],
    };
    expect(approverOf(unnamed, 'ayush', 'act_5', true).name).toBeNull();
  });
});
