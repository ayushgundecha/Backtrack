import { api, queries } from '@backtrack/core';
import { HttpError, json, parseQuery, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOP = 10;

/** GET /api/algo: FalkorDB's graph algorithms over DEPENDS_ON (Q8–Q11), with their Cypher. */
export const GET = route(async (req) => {
  const { tenant, name, from, to } = parseQuery(req, api.algo.query);
  const g = await tenantGraph(tenant);
  let res: { rows: object[]; cypher: string; ms: number };
  switch (name) {
    case 'load_bearing':
      res = await queries.q8LoadBearing(g, { limit: TOP });
      break;
    case 'hinge_actions':
      res = await queries.q9Hinges(g, { limit: TOP });
      break;
    case 'independent_clusters':
      res = await queries.q10Clusters(g, {});
      break;
    case 'path_between':
      if (!from || !to) throw new HttpError(400, 'path_between needs from and to action ids');
      res = await queries.q11PathBetween(g, { from, to });
      break;
  }
  // Row shapes differ per algorithm; the contract's record schema checks them on the way out.
  const rows = res.rows as Array<Record<string, unknown>>;
  return json(api.algo.response, { rows, cypher: res.cypher, ms: res.ms });
});
