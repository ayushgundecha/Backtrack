import { api, graphSnapshot } from '@backtrack/core';
import { json, parseQuery, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/graph: actions, touched entities, agents, runs, plans and policies (V3 + V4). */
export const GET = route(async (req) => {
  const { tenant } = parseQuery(req, api.graph.query);
  return json(api.graph.response, await graphSnapshot(await tenantGraph(tenant)));
});
