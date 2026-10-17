import { api, loadPlan, rehearseUndo } from '@backtrack/core';
import { HttpError, json, parseBody, route, tenantGraph, tools } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** POST /api/rehearse: execute the plan on a GRAPH.COPY fork, diff it with live, drop the fork. */
export const POST = route(async (req) => {
  const { tenant, planId } = await parseBody(req, api.rehearse.body);
  const g = await tenantGraph(tenant);
  if (!(await loadPlan(g, planId)))
    throw new HttpError(404, `No undo plan ${planId} in this graph`);
  const { status: _, traces: __, ...diff } = await rehearseUndo(g, planId, { registry: tools() });
  return json(api.rehearse.response, diff);
});
