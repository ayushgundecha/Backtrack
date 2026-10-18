/**
 * BT-04B against FalkorDB: every algorithm the buttons call returns rows the panel can read
 * (the contract types them as open records, so this pins the real shapes), and the path query
 * reads earlier → later.
 */
import { closeDb, openTenant, type RunEvent } from '@backtrack/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as actions from '@/app/api/actions/route';
import * as agent from '@/app/api/agent/route';
import * as algo from '@/app/api/algo/route';
import * as approval from '@/app/api/approval/route';
import * as graph from '@/app/api/graph/route';
import * as reset from '@/app/api/reset/route';
import { overlayOf, parseAlgo } from '@/lib/algo-view';
import { ApiError, HttpApiClient } from '@/lib/api';

const TENANT = `${process.env.BT_TEST_TENANT ?? 'test'}-algo`;
const TOKEN = 'test-reset-token';

type Handler = (req: Request) => Promise<Response>;
const ROUTES: Record<string, { GET?: Handler; POST?: Handler }> = {
  '/api/actions': actions,
  '/api/agent': agent,
  '/api/algo': algo,
  '/api/approval': approval,
  '/api/graph': graph,
  '/api/reset': reset,
};

const routerFetch: typeof fetch = async (input, init) => {
  const req = new Request(new URL(String(input), 'http://backtrack.test'), init);
  const handler = ROUTES[new URL(req.url).pathname]?.[req.method as 'GET' | 'POST'];
  if (!handler) return new Response('not found', { status: 404 });
  return handler(req);
};

const client = new HttpApiClient({ tenant: TENANT, fetch: routerFetch });

async function drain(stream: AsyncIterable<RunEvent>) {
  for await (const e of stream) {
    if (e.type === 'approval.requested') {
      await client.approval({ runId: e.runId, actionId: e.actionId, approved: true });
    }
  }
}

beforeAll(async () => {
  process.env.RESET_TOKEN = TOKEN;
  await client.reset(TOKEN);
  await drain(client.runAgent({ agent: 'ops-agent', mode: 'replay' }));
  await drain(client.runAgent({ agent: 'billing-agent', mode: 'replay' }));
}, 30_000);

afterAll(async () => {
  await openTenant(TENANT).drop();
  await closeDb();
});

describe('algorithm buttons on FalkorDB', () => {
  it('reads Q8–Q11 rows and maps them onto the graph snapshot', async () => {
    const snapshot = await client.graph();
    const { actions: list } = await client.actions();
    const of = (tool: string) => list.find((a) => a.tool === tool)?.id as string;

    const load = parseAlgo(
      'load_bearing',
      (await client.algo({ name: 'load_bearing' })).rows,
      snapshot,
    );
    if (load.name !== 'load_bearing') throw new Error('wrong view');
    expect(load.rows.find((r) => r.rank === 1)?.tool).toBe('update_address');

    const hinges = parseAlgo(
      'hinge_actions',
      (await client.algo({ name: 'hinge_actions' })).rows,
      snapshot,
    );
    expect(Object.fromEntries(overlayOf(hinges, snapshot).badges)).toEqual({
      [of('post_message')]: '#1',
      [of('create_ticket')]: '#2',
    });

    const clusters = parseAlgo(
      'independent_clusters',
      (await client.algo({ name: 'independent_clusters' })).rows,
      snapshot,
    );
    if (clusters.name !== 'independent_clusters') throw new Error('wrong view');
    expect(clusters.clusters.flatMap((c) => c.actions).length).toBe(list.length);

    const path = await client.algo({
      name: 'path_between',
      from: of('update_address'),
      to: of('apply_credit'),
    });
    const route = parseAlgo('path_between', path.rows, snapshot);
    expect(route).toMatchObject({
      path: [{ tool: 'update_address', seq: 2 }, {}, {}, { tool: 'apply_credit' }],
    });
    // Every lit link is a real DEPENDS_ON edge of the snapshot.
    const edges = new Set(
      snapshot.links
        .filter((l) => l.type === 'DEPENDS_ON')
        .map((l) => `${l.source}>DEPENDS_ON>${l.target}`),
    );
    for (const key of overlayOf(route, snapshot).litLinks) expect(edges.has(key)).toBe(true);
  });

  it('answers a path with one end missing with a 400 whose message the panel shows', async () => {
    const error = await client.algo({ name: 'path_between', from: 'act_x' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      message: 'path_between needs from and to action ids',
    });
  });
});
