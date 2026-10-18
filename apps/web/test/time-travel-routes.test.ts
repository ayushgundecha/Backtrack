/**
 * BT-047 acceptance: a scrubber frame is the Effects fold. The same history (both golden runs,
 * then an executed undo) is recorded on a real FalkorDB tenant through the routes and in the
 * mock; GET /api/world?asOfSeq=N must agree with the mock's world(N) at every stop, and each
 * frame must equal the world as it stood live right after action N. The undo's own steps come
 * later than the runs, so the early frames also prove that later reverts are rolled back too.
 */
import { closeDb, openTenant, type RunEvent, type WorldSnapshot } from '@backtrack/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as actions from '@/app/api/actions/route';
import * as agent from '@/app/api/agent/route';
import * as approval from '@/app/api/approval/route';
import * as reset from '@/app/api/reset/route';
import * as undoExecute from '@/app/api/undo/execute/route';
import * as undo from '@/app/api/undo/route';
import * as world from '@/app/api/world/route';
import { type ApiClient, HttpApiClient } from '@/lib/api';
import { MockApiClient } from '@/lib/mock';

const TENANT = `${process.env.BT_TEST_TENANT ?? 'test'}-scrub`;
const TOKEN = 'test-reset-token';

type Handler = (req: Request) => Promise<Response>;
const ROUTES: Record<string, { GET?: Handler; POST?: Handler }> = {
  '/api/actions': actions,
  '/api/agent': agent,
  '/api/approval': approval,
  '/api/reset': reset,
  '/api/undo': undo,
  '/api/undo/execute': undoExecute,
  '/api/world': world,
};

const routerFetch: typeof fetch = async (input, init) => {
  const req = new Request(new URL(String(input), 'http://backtrack.test'), init);
  const handler = ROUTES[new URL(req.url).pathname]?.[req.method as 'GET' | 'POST'];
  if (!handler) return new Response('not found', { status: 404 });
  return handler(req);
};

const real = new HttpApiClient({ tenant: TENANT, fetch: routerFetch });
const mock = new MockApiClient({ tenant: TENANT, stepDelayMs: 0, undoStepDelayMs: 0 });

const stateOf = (w: WorldSnapshot) =>
  Object.fromEntries(
    w.entities
      .map((e) => [`${e.type}:${e.key}`, e.state] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/**
 * Records the golden history and keeps the live world after every action, by seq. The live read
 * after an action.recorded event is what the panel showed at that moment.
 */
async function record(client: ApiClient) {
  const liveAfter = new Map<number, ReturnType<typeof stateOf>>();
  const drain = async (stream: AsyncIterable<RunEvent>) => {
    for await (const e of stream) {
      if (e.type === 'approval.requested') {
        await client.approval({ runId: e.runId, actionId: e.actionId, approved: true });
      }
      if (e.type === 'action.recorded' && e.action.status === 'done') {
        liveAfter.set(e.action.seq, stateOf(await client.world()));
      }
    }
  };
  await drain(client.runAgent({ agent: 'ops-agent', mode: 'replay' }));
  await drain(client.runAgent({ agent: 'billing-agent', mode: 'replay' }));
  const outcome = await client.undo({ text: 'undo the address change', depth: 3 });
  if (outcome.kind !== 'plan') throw new Error(`expected a plan, got ${outcome.kind}`);
  await drain(client.executeUndo(outcome.plan.id));
  const { actions: list } = await client.actions();
  return { liveAfter, seqs: list.map((a) => a.seq).sort((a, b) => a - b) };
}

beforeAll(async () => {
  process.env.RESET_TOKEN = TOKEN;
  await real.reset(TOKEN);
});

afterAll(async () => {
  await openTenant(TENANT).drop();
  await closeDb();
});

describe('time scrubber frames', () => {
  it('equal the Effects fold on FalkorDB and in the mock, at every stop', async () => {
    const [onGraph, inMock] = [await record(real), await record(mock)];
    expect(onGraph.seqs).toEqual(inMock.seqs);
    const last = onGraph.seqs.at(-1) ?? 0;
    expect(last).toBeGreaterThan(9);

    for (let seq = 0; seq <= last; seq++) {
      const frame = await real.world(seq);
      expect(frame.asOfSeq).toBe(seq);
      const mockFrame = await mock.world(seq);
      expect(stateOf(frame), `asOfSeq=${seq}`).toEqual(stateOf(mockFrame));
      // A done action's frame is the world exactly as it was live right after it, in both.
      const live = onGraph.liveAfter.get(seq);
      if (live) expect(stateOf(frame), `FalkorDB live after seq ${seq}`).toEqual(live);
      const mockLive = inMock.liveAfter.get(seq);
      if (mockLive) expect(stateOf(mockFrame), `mock live after seq ${seq}`).toEqual(mockLive);
    }
    expect(stateOf(await real.world())).toEqual(stateOf(await mock.world()));
  }, 60_000);
});
