import {
  api,
  BUDGET_TENANT,
  createLiveModel,
  LIVE_AGENTS,
  llmConfigFromEnv,
  loadRunFixture,
  openTenant,
  readBudget,
  replayRun,
  runLiveAgent,
} from '@backtrack/core';
import { parseBody, route, sse, tenantGraph, tools } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A replay takes ~5 s plus however long the human takes at the gate.
export const maxDuration = 300;

/**
 * POST /api/agent: run an agent and stream its RunEvents. Replay drives the real recorder and
 * gate from the golden fixture; live mode lets a model choose the tools through the same gate.
 * When the gate asks, the stream waits until /api/approval writes the decision to the graph
 * (another request, possibly another instance: the graph is the bus).
 */
export const POST = route(async (req) => {
  const { tenant, agent, mode, goal } = await parseBody(req, api.agent.body);
  const g = await tenantGraph(tenant);
  return sse(req, async (emit, signal) => {
    const fixture = loadRunFixture(agent);
    const replay = () => replayRun(g, fixture, { registry: tools(), emit, signal });
    if (mode === 'replay') {
      await replay();
      return;
    }

    // Live mode degrades to replay, and says why, when there is no key or no budget left.
    const config = llmConfigFromEnv();
    if (!config) {
      await emit({
        type: 'error',
        runId: null,
        message: 'Live mode is not configured (no OpenRouter key); showing the replay instead',
      });
      await replay();
      return;
    }
    const budget = await readBudget(openTenant(BUDGET_TENANT), config.dailyLimit);
    if (budget.left === 0) {
      await emit({
        type: 'error',
        runId: null,
        message: `Today's live-model budget (${budget.limit} requests) is used up; showing the replay instead`,
      });
      await replay();
      return;
    }
    await runLiveAgent(g, LIVE_AGENTS[agent], {
      model: createLiveModel(config),
      modelId: config.model,
      registry: tools(),
      goal: goal?.trim() || fixture.goal,
      emit,
      signal,
    });
  });
});
