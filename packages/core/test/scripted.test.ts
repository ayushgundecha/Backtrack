/** Live mode and replay must build the same graph from the same choices (BT-039). */
import { beforeEach, describe, expect, it } from 'vitest';
import { BILLING_AGENT } from '../src/agents/billing.js';
import { loadRunFixture } from '../src/agents/fixtures.js';
import { runLiveAgent } from '../src/agents/live.js';
import { OPS_AGENT } from '../src/agents/ops.js';
import { replayRun } from '../src/agents/replay.js';
import { scriptedModel } from '../src/agents/scripted.js';
import { createToolRegistry } from '../src/agents/tools.js';
import type { RunEvent } from '../src/contracts/events.js';
import { worldSnapshot } from '../src/world/store.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const registry = createToolRegistry();

/** What should match across modes: the dependency edges, the gate's words and the world. */
async function fingerprint(events: RunEvent[]) {
  const { rows } = await g.read<{ from: string; to: string }>(
    `MATCH (a:Action)-[:DEPENDS_ON]->(b:Action)
     RETURN a.tool + '@' + toString(a.seq) AS from, b.tool + '@' + toString(b.seq) AS to
     ORDER BY from, to`,
  );
  const world = await worldSnapshot(g);
  return {
    dependsOn: rows.map((r) => `${r.from} -> ${r.to}`),
    gate: events.flatMap((e) => (e.type === 'approval.requested' ? [e.reason] : [])),
    world: world.entities.map((e) => ({ type: e.type, key: e.key, state: e.state })),
  };
}

describe('scripted model through the live tool loop', () => {
  beforeEach(async () => {
    await fresh(g);
  });

  it('records the same graph as replay for both golden runs', async () => {
    const replayEvents: RunEvent[] = [];
    for (const agent of ['ops-agent', 'billing-agent'] as const) {
      await replayRun(g, loadRunFixture(agent), {
        registry,
        paceMs: 0,
        emit: (e) => void replayEvents.push(e),
        awaitApproval: async () => true,
      });
    }
    const replayed = await fingerprint(replayEvents);

    await fresh(g);
    const liveEvents: RunEvent[] = [];
    for (const spec of [OPS_AGENT, BILLING_AGENT]) {
      const fixture = loadRunFixture(spec.agentId);
      const res = await runLiveAgent(g, spec, {
        model: scriptedModel(fixture),
        modelId: `scripted:${spec.agentId}`,
        registry,
        goal: fixture.goal,
        emit: (e) => void liveEvents.push(e),
        awaitApproval: async () => true,
      });
      expect(res.status).toBe('done');
    }
    const live = await fingerprint(liveEvents);

    expect(replayed.dependsOn).toHaveLength(8);
    expect(live).toEqual(replayed);
  });
});
