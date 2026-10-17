import { api, planUndo } from '@backtrack/core';
import { HttpError, json, parseBody, rateLimit, route, tenantGraph, tools } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/undo: propose (never execute) an undo for an action named by id or in words.
 * Answers one of the four outcomes: plan, memory (already undone), none, unknown (candidates).
 */
export const POST = route(async (req) => {
  rateLimit(req, 'undo');
  const { tenant, text, actionId, depth } = await parseBody(req, api.undo.body);
  if (!text?.trim() && !actionId) throw new HttpError(400, 'Say what to undo: text or actionId');
  const g = await tenantGraph(tenant);
  const { outcome } = await planUndo(
    g,
    { actionId: actionId ?? null, text: text ?? null, depth, userId: 'ayush' },
    { registry: tools() },
  );
  return json(api.undo.response, outcome);
});
