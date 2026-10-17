import { actionsView, api } from '@backtrack/core';
import { json, parseQuery, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/actions: every recorded action in order (V1). */
export const GET = route(async (req) => {
  const { tenant } = parseQuery(req, api.actions.query);
  return json(api.actions.response, await actionsView(await tenantGraph(tenant)));
});
