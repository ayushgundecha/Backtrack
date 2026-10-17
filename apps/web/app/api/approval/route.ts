import { api, queries, recordDecision } from '@backtrack/core';
import { HttpError, json, parseBody, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/approval: record a human's decision on a paused action as a User edge. The run that
 * is waiting polls the graph for it (R8), so this request only writes; it never touches the run.
 */
export const POST = route(async (req) => {
  const { tenant, runId, actionId, approved } = await parseBody(req, api.approval.body);
  const g = await tenantGraph(tenant);
  const [action] = (await queries.getActions(g, { ids: [actionId] })).rows;
  if (!action || action.runId !== runId) {
    throw new HttpError(404, `No action ${actionId} in run ${runId}`);
  }
  if (action.status !== 'pending') {
    throw new HttpError(409, `${action.tool} is not waiting for approval (it is ${action.status})`);
  }
  await recordDecision(g, { actionId, approved });
  return json(api.approval.response, { ok: true });
});
