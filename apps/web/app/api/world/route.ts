import { api, worldSnapshot } from '@backtrack/core';
import { json, parseQuery, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/world: every entity's state now, or folded back to just after `asOfSeq`. */
export const GET = route(async (req) => {
  const { tenant, asOfSeq } = parseQuery(req, api.world.query);
  const { traces: _, ...world } = await worldSnapshot(await tenantGraph(tenant), asOfSeq ?? null);
  return json(api.world.response, world);
});
