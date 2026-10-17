import { api, loadPlan } from '@backtrack/core';
import { HttpError, json, parseQuery, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/plan: a stored undo plan with its steps in execution order (P2). */
export const GET = route(async (req) => {
  const { tenant, planId } = parseQuery(req, api.plan.query);
  const plan = await loadPlan(await tenantGraph(tenant), planId);
  if (!plan) throw new HttpError(404, `No undo plan ${planId} in this graph`);
  return json(api.plan.response, plan);
});
