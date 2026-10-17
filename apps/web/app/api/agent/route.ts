import { api, loadRunFixture, replayRun } from '@backtrack/core';
import { parseBody, route, sse, tenantGraph, tools } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A replay takes ~5 s plus however long the human takes at the gate.
export const maxDuration = 300;

/**
 * POST /api/agent: run an agent and stream its RunEvents. Replay drives the real recorder and
 * gate from the golden fixture; when the gate asks, the stream waits until /api/approval writes
 * the decision to the graph (another request, possibly another instance: the graph is the bus).
 */
export const POST = route(async (req) => {
  const { tenant, agent, mode } = await parseBody(req, api.agent.body);
  const g = await tenantGraph(tenant);
  return sse(req, async (emit, signal) => {
    if (mode === 'llm') {
      // Not wired yet (BT-035); say so instead of pretending with a replay.
      await emit({
        type: 'error',
        runId: null,
        message: 'Live LLM runs are not available yet; use replay',
      });
      return;
    }
    await replayRun(g, loadRunFixture(agent), { registry: tools(), emit, signal });
  });
});
