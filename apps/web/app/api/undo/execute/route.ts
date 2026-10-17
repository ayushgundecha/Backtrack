import { api, executeUndo, loadPlan } from '@backtrack/core';
import { HttpError, parseBody, route, sse, tenantGraph, tools } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Paced so the plan's steps visibly tick in the panel as they happen.
const UNDO_PACE_MS = 500;

/** POST /api/undo/execute: run a confirmed plan and stream undo.step / undo.finished events. */
export const POST = route(async (req) => {
  const { tenant, planId } = await parseBody(req, api.undoExecute.body);
  const g = await tenantGraph(tenant);
  if (!(await loadPlan(g, planId)))
    throw new HttpError(404, `No undo plan ${planId} in this graph`);
  return sse(req, async (emit) => {
    await executeUndo(g, planId, { registry: tools(), paceMs: UNDO_PACE_MS, onEvent: emit });
  });
});
