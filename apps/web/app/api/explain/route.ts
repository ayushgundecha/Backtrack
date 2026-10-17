import { api, explainAction } from '@backtrack/core';
import { HttpError, json, parseQuery, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/explain: why an action happened, what it read and changed, what depends on it (Q6). */
export const GET = route(async (req) => {
  const { tenant, actionId } = parseQuery(req, api.explain.query);
  const explain = await explainAction(await tenantGraph(tenant), actionId);
  if (!explain) throw new HttpError(404, `No action ${actionId} in this graph`);
  return json(api.explain.response, explain);
});
