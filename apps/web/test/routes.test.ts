/**
 * The API routes against a real FalkorDB, driven through the same HttpApiClient the panel uses:
 * every request and response goes through the contract schemas on both sides.
 */
import { closeDb, openTenant, type RunEvent } from '@backtrack/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as actions from '@/app/api/actions/route';
import * as agent from '@/app/api/agent/route';
import * as algo from '@/app/api/algo/route';
import * as approval from '@/app/api/approval/route';
import * as explain from '@/app/api/explain/route';
import * as graph from '@/app/api/graph/route';
import * as plan from '@/app/api/plan/route';
import * as policy from '@/app/api/policy/route';
import * as rehearse from '@/app/api/rehearse/route';
import * as reset from '@/app/api/reset/route';
import * as undoExecute from '@/app/api/undo/execute/route';
import * as undo from '@/app/api/undo/route';
import * as world from '@/app/api/world/route';
import { ApiError, HttpApiClient } from '@/lib/api';

const TENANT = `${process.env.BT_TEST_TENANT ?? 'test'}-routes`;
const TOKEN = 'test-reset-token';

type Handler = (req: Request) => Promise<Response>;
const ROUTES: Record<string, { GET?: Handler; POST?: Handler }> = {
  '/api/actions': actions,
  '/api/agent': agent,
  '/api/algo': algo,
  '/api/approval': approval,
  '/api/explain': explain,
  '/api/graph': graph,
  '/api/plan': plan,
  '/api/policy': policy,
  '/api/rehearse': rehearse,
  '/api/reset': reset,
  '/api/undo': undo,
  '/api/undo/execute': undoExecute,
  '/api/world': world,
};

/** A fetch that dispatches to the route modules, the way Next would. */
const routerFetch: typeof fetch = async (input, init) => {
  const req = new Request(new URL(String(input), 'http://backtrack.test'), init);
  const handler = ROUTES[new URL(req.url).pathname]?.[req.method as 'GET' | 'POST'];
  if (!handler) return new Response('not found', { status: 404 });
  return handler(req);
};

const client = new HttpApiClient({ tenant: TENANT, fetch: routerFetch });

async function collect(stream: AsyncIterable<RunEvent>, onEvent?: (e: RunEvent) => Promise<void>) {
  const events: RunEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    await onEvent?.(e);
  }
  return events;
}

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof ApiError ? { status: e.status, message: e.message } : e),
  );

beforeAll(async () => {
  process.env.RESET_TOKEN = TOKEN;
  await client.reset(TOKEN);
});

afterAll(async () => {
  await openTenant(TENANT).drop();
  await closeDb();
});

describe('API routes', () => {
  it('reset needs the configured token', async () => {
    expect(await errorOf(client.reset('nope'))).toEqual({
      status: 401,
      message: 'Wrong reset token',
    });
  });

  it('streams the ops replay, pauses at the gate and resumes when /api/approval writes the decision', async () => {
    const decided: Array<{ runId: string; actionId: string }> = [];
    const events = await collect(
      client.runAgent({ agent: 'ops-agent', mode: 'replay' }),
      async (e) => {
        if (e.type === 'approval.requested') {
          const pending = { runId: e.runId, actionId: e.actionId };
          decided.push(pending);
          // While this run waits at the gate, nobody can start another one on the tenant.
          expect(
            await errorOf(collect(client.runAgent({ agent: 'billing-agent', mode: 'replay' }))),
          ).toEqual({
            status: 409,
            message: 'A run by ops-agent is still paused on this tenant; wait for it to finish',
          });
          expect(await client.approval({ ...pending, approved: true })).toEqual({ ok: true });
        }
      },
    );
    const gate = events.find((e) => e.type === 'approval.requested');
    expect(gate).toMatchObject({
      tool: 'send_email',
      reason: 'would lock in 3 reversible changes: update_address, create_ticket, post_message',
    });
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'done' });
    // A second decision on the same action is refused rather than silently ignored.
    const [first] = decided;
    if (!first) throw new Error('the run never asked for approval');
    expect(await errorOf(client.approval({ ...first, approved: false }))).toMatchObject({
      status: 409,
    });

    const billing = await collect(client.runAgent({ agent: 'billing-agent', mode: 'replay' }));
    expect(billing.at(-1)).toMatchObject({ type: 'run.finished', status: 'done' });
  }, 30_000);

  it('serves the graph, the action list and explanations from the recorded history', async () => {
    const snapshot = await client.graph();
    expect(snapshot.links.filter((l) => l.type === 'DEPENDS_ON')).toHaveLength(8);
    const { actions: list } = await client.actions();
    expect(list.map((a) => a.tool)).toEqual([
      'lookup_order',
      'update_address',
      'create_ticket',
      'post_message',
      'send_email',
      'schedule_followup',
      'list_open_tickets',
      'lookup_ticket',
      'apply_credit',
    ]);

    const post = list.find((a) => a.tool === 'post_message');
    if (!post) throw new Error('post_message was not recorded');
    const why = await client.explain(post.id);
    expect(why.dependsOn.map((d) => d.tool)).toEqual(['create_ticket']);
    expect(why.dependedOnBy.map((d) => d.tool).sort()).toEqual(
      [
        'apply_credit',
        'list_open_tickets',
        'lookup_ticket',
        'schedule_followup',
        'send_email',
      ].sort(),
    );
    // It read the ticket create_ticket had just opened and saw it as it was then: no thread yet
    // (post_message itself started the thread, so today's state would say otherwise).
    expect(why.reads).toContainEqual(
      expect.objectContaining({
        entity: 'ticket:tkt_1',
        writtenAtSeq: 3,
        saw: expect.objectContaining({ status: 'open', thread: null }),
      }),
    );
    expect(await errorOf(client.explain('act_missing'))).toMatchObject({ status: 404 });
  });

  it('folds the world back in time with asOfSeq', async () => {
    const address = (w: Awaited<ReturnType<typeof client.world>>) =>
      w.entities.find((e) => e.key === 'ord_1001')?.state.address;
    expect(address(await client.world(1))).toBe('14 Marine Drive, Mumbai 400020');
    expect(address(await client.world())).toBe('221B Baker Street, London NW1 6XE');
  });

  it('runs FalkorDB algorithms and rejects a path query without endpoints', async () => {
    const top = await client.algo({ name: 'load_bearing' });
    expect(top.rows[0]).toMatchObject({ tool: 'update_address' });
    expect(top.cypher).toContain('algo.pageRank');
    expect(await errorOf(client.algo({ name: 'path_between' }))).toEqual({
      status: 400,
      message: 'path_between needs from and to action ids',
    });
  });

  it('plans, rehearses on a fork, executes with streamed ticks, then remembers', async () => {
    expect(await errorOf(client.undo({}))).toMatchObject({ status: 400 });
    expect(await client.undo({ text: 'undo the weather' })).toMatchObject({ kind: 'unknown' });

    const outcome = await client.undo({ text: 'undo the address change', depth: 3 });
    if (outcome.kind !== 'plan') throw new Error(`expected a plan, got ${outcome.kind}`);
    const planId = outcome.plan.id;
    expect(outcome.plan.steps.map((s) => s.tool)).toEqual([
      'apply_credit',
      'schedule_followup',
      'send_email',
      'post_message',
      'create_ticket',
      'update_address',
    ]);

    const diff = await client.rehearse(planId);
    expect(diff.changes.length).toBeGreaterThan(0);
    expect((await client.plan(planId)).status).toBe('rehearsed');
    // Rehearsal ran on a copy: the live world still has the new address.
    expect((await client.world()).entities.find((e) => e.key === 'ord_1001')?.state.address).toBe(
      '221B Baker Street, London NW1 6XE',
    );

    const ticks = await collect(client.executeUndo(planId));
    expect(ticks.filter((e) => e.type === 'undo.step' && e.status === 'done')).toHaveLength(6);
    expect(ticks.at(-1)).toEqual({ type: 'undo.finished', planId, status: 'executed' });
    expect((await client.world()).entities.find((e) => e.key === 'ord_1001')?.state.address).toBe(
      '14 Marine Drive, Mumbai 400020',
    );
    expect(await client.undo({ text: 'undo the address change' })).toMatchObject({
      kind: 'memory',
    });
    expect(await errorOf(client.plan('plan_missing'))).toMatchObject({ status: 404 });
  }, 30_000);

  it('records a policy, and refuses one whose scope does not exist', async () => {
    const created = await client.policy({
      rule: 'never re-route ord_1001 again',
      kind: 'block',
      tool: 'update_address',
      agentId: 'ops-agent',
      entity: { type: 'order', key: 'ord_1001' },
      createdFromPlanId: null,
    });
    expect(created.id).toMatch(/^pol_/);
    expect(
      await errorOf(
        client.policy({
          rule: 'r',
          kind: 'block',
          tool: 'send_email',
          agentId: null,
          entity: { type: 'order', key: 'ord_9999' },
          createdFromPlanId: null,
        }),
      ),
    ).toEqual({ status: 400, message: 'Unknown entity order:ord_9999' });
  });

  it('rejects a tenant name that is not a plain slug', async () => {
    const bad = new HttpApiClient({ tenant: 'demo}:x', fetch: routerFetch });
    expect(await errorOf(bad.graph())).toMatchObject({ status: 400 });
  });

  // Last: it adds another ops run to the tenant.
  it('live mode without an OpenRouter key says so and shows the replay instead', async () => {
    const key = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const events = await collect(
        client.runAgent({ agent: 'ops-agent', mode: 'llm' }),
        async (e) => {
          if (e.type === 'approval.requested') {
            await client.approval({ runId: e.runId, actionId: e.actionId, approved: false });
          }
        },
      );
      expect(events[0]).toEqual({
        type: 'error',
        runId: null,
        message: 'Live mode is not configured (no OpenRouter key); showing the replay instead',
      });
      expect(events[1]).toMatchObject({ type: 'run.started', mode: 'replay' });
      // The policy recorded above now stops the re-route, and the replay ends there honestly.
      expect(events.find((e) => e.type === 'action.blocked')).toMatchObject({
        tool: 'update_address',
        rule: 'never re-route ord_1001 again',
      });
      expect(events.at(-1)).toMatchObject({ type: 'run.finished' });
    } finally {
      if (key !== undefined) process.env.OPENROUTER_API_KEY = key;
    }
  }, 30_000);

  it('rejects oversized bodies and fields, and rate-limits per client', async () => {
    const post = (path: string, body: string) =>
      routerFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const big = await post('/api/undo', JSON.stringify({ tenant: TENANT, text: 'x'.repeat(9000) }));
    expect(big.status).toBe(413);
    const long = await post('/api/undo', JSON.stringify({ tenant: TENANT, text: 'x'.repeat(301) }));
    expect(await long.json()).toEqual({ error: 'text is longer than 300 characters' });

    // Reset allows 3 a minute; this file already used 2 (setup and the wrong-token test).
    const resetWith = (token: string) =>
      post('/api/reset', JSON.stringify({ tenant: TENANT, token }));
    expect((await resetWith('nope')).status).toBe(401);
    const limited = await resetWith('nope');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
