/**
 * Live mode dry-run: a scripted mock model drives the real ToolLoopAgent, tools, gate and recorder.
 * Only the model is fake; everything it touches is the same code a real model would reach.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BILLING_AGENT } from '../src/agents/billing.js';
import { loadRunFixture } from '../src/agents/fixtures.js';
import { runLiveAgent } from '../src/agents/live.js';
import { OPS_AGENT } from '../src/agents/ops.js';
import { replayRun } from '../src/agents/replay.js';
import { createToolRegistry } from '../src/agents/tools.js';
import { RunEvent } from '../src/contracts/events.js';
import { listActions, q7CrossAgent } from '../src/graph/queries.js';
import { getEntity } from '../src/world/store.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const call = (n: number, toolName: string, input: object) => ({
  content: [
    { type: 'tool-call' as const, toolCallId: `c${n}`, toolName, input: JSON.stringify(input) },
  ],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage,
  warnings: [],
});
const say = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});

/** A model that recalls, looks up, re-routes the order, then tries to email (and is denied). */
const scriptedModel = () =>
  new MockLanguageModelV4({
    modelId: 'mock-ops',
    doGenerate: [
      call(1, 'recall', { entityType: 'order', entityKey: 'ord_1001' }),
      call(2, 'lookup_order', { orderId: 'ord_1001', why: 'See the order before changing it.' }),
      call(3, 'update_address', {
        orderId: 'ord_1001',
        address: '221B Baker Street, London NW1 6XE',
        why: 'The customer asked for the new flat.',
      }),
      call(4, 'send_email', {
        to: 'cust_42',
        subject: 'Your order ord_1001 has a new address',
        body: 'We updated the address.',
        why: 'Tell the customer what changed.',
      }),
      say(
        'I re-routed ord_1001. The confirmation email was denied, so the customer was not emailed.',
      ),
    ],
  });

describe('live ops agent (mock model)', () => {
  beforeEach(async () => {
    await fresh(g);
  });

  it('records each world call with its why, gates the email, and tells the model it was denied', async () => {
    const model = scriptedModel();
    const events: RunEvent[] = [];
    const res = await runLiveAgent(g, OPS_AGENT, {
      model,
      modelId: 'mock-ops',
      registry: createToolRegistry(),
      goal: 'Customer cust_42 says order ord_1001 is going to the wrong address.',
      emit: (e) => void events.push(RunEvent.parse(e)),
      awaitApproval: async () => false,
    });

    expect(res.status).toBe('done');
    expect(res.text).toMatch(/denied/);
    expect(events[0]).toMatchObject({ type: 'run.started', mode: 'llm', model: 'mock-ops' });
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'done' });

    // Only world tools are actions; recall read the graph and left no trace in the history.
    const { rows } = await listActions(g, {});
    expect(rows.map((r) => [r.tool, r.status])).toEqual([
      ['lookup_order', 'done'],
      ['update_address', 'done'],
      ['send_email', 'denied'],
    ]);
    const thoughts = events.flatMap((e) => (e.type === 'step' ? [e.thought] : []));
    expect(thoughts).toEqual([
      'See the order before changing it.',
      'The customer asked for the new flat.',
      'Tell the customer what changed.',
    ]);
    expect(events.find((e) => e.type === 'approval.requested')).toMatchObject({
      tool: 'send_email',
      reason: 'would lock in 1 reversible change: update_address',
    });
    expect(await getEntity(g, 'email', 'eml_1')).toBeNull();

    // The model's last turn saw the denial as the tool's result, with the reason.
    const lastPrompt = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt);
    expect(lastPrompt).toContain('denied');
    expect(lastPrompt).toContain('Denied by a human in the approval card');

    // The conversation is kept on the Run.
    const run = await g.read<{ messages: string }>(
      'MATCH (r:Run {id: $id}) RETURN r.messages AS messages',
      { id: res.runId },
    );
    const kept = run.rows[0]?.messages ?? '';
    // Each tool call appears once: the steps' messages are appended, not repeated.
    expect(kept.split('Tell the customer what changed.')).toHaveLength(2);
    expect(kept).toContain('I re-routed ord_1001.');
  });

  it('a call without a why is rejected by the schema and never reaches the world', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        call(1, 'update_address', { orderId: 'ord_1001', address: '221B Baker Street, London' }),
        say('Done.'),
      ],
    });
    const res = await runLiveAgent(g, OPS_AGENT, {
      model,
      modelId: 'mock',
      registry: createToolRegistry(),
      goal: 'Fix the address.',
      emit: () => {},
    });
    expect(res.status).toBe('done');
    expect((await listActions(g, {})).rows).toEqual([]);
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe(
      '14 Marine Drive, Mumbai 400020',
    );
  });

  it('a live billing run builds on the replayed ops run, so the dependency crosses agents', async () => {
    const registry = createToolRegistry();
    await replayRun(g, loadRunFixture('ops-agent'), {
      registry,
      paceMs: 0,
      emit: () => {},
      awaitApproval: async () => true,
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        call(1, 'list_open_tickets', { why: 'See which tickets are open.' }),
        call(2, 'recall', { entityType: 'ticket', entityKey: 'tkt_1' }),
        call(3, 'apply_credit', {
          customerId: 'cust_42',
          amount: 10,
          reason: 'Delivery address mix-up',
          ticketId: 'tkt_1',
          why: 'The order was disrupted, so a small credit is fair.',
        }),
        say('Credited cust_42 with 10 for the address mix-up on tkt_1.'),
      ],
    });
    const res = await runLiveAgent(g, BILLING_AGENT, {
      model,
      modelId: 'mock-billing',
      registry,
      goal: 'Review open support tickets and apply goodwill credits where an order was disrupted.',
      emit: () => {},
    });
    expect(res.status).toBe('done');
    expect(await getEntity(g, 'credit', 'cr_1')).toMatchObject({ amount: 10, status: 'active' });

    // Undoing the ops agent's address change now reaches the live billing agent's credit.
    const { rows } = await listActions(g, {});
    const root = rows.find((r) => r.tool === 'update_address');
    const cross = await q7CrossAgent(g, { actionId: root?.id ?? '' }, { depth: 5 });
    expect(cross.rows).toContainEqual(
      expect.objectContaining({ agentId: 'billing-agent', tool: 'apply_credit' }),
    );
  });
});
