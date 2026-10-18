/**
 * The mock must be a faithful stand-in for the engine: the panel is built and demoed against it,
 * so any difference is a screen that changes when NEXT_PUBLIC_MOCK flips. This drives the golden
 * demo (ops run with approval, billing run, plan, rehearse, execute, recall) through the mock and
 * through the real routes on FalkorDB, and compares what the panel reads, with ids replaced by
 * seq numbers (the only ids the two sides can agree on).
 */
import { closeDb, openTenant, type RunEvent } from '@backtrack/core';
import type { GraphSnapshot, UndoOutcome, WorldSnapshot } from '@backtrack/core/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as actions from '@/app/api/actions/route';
import * as agent from '@/app/api/agent/route';
import * as approval from '@/app/api/approval/route';
import * as explain from '@/app/api/explain/route';
import * as graph from '@/app/api/graph/route';
import * as plan from '@/app/api/plan/route';
import * as rehearse from '@/app/api/rehearse/route';
import * as reset from '@/app/api/reset/route';
import * as undoExecute from '@/app/api/undo/execute/route';
import * as undo from '@/app/api/undo/route';
import * as world from '@/app/api/world/route';
import { type ApiClient, HttpApiClient } from '@/lib/api';
import { MockApiClient } from '@/lib/mock';

const TENANT = `${process.env.BT_TEST_TENANT ?? 'test'}-parity`;
const TOKEN = 'test-reset-token';

type Handler = (req: Request) => Promise<Response>;
const ROUTES: Record<string, { GET?: Handler; POST?: Handler }> = {
  '/api/actions': actions,
  '/api/agent': agent,
  '/api/approval': approval,
  '/api/explain': explain,
  '/api/graph': graph,
  '/api/plan': plan,
  '/api/rehearse': rehearse,
  '/api/reset': reset,
  '/api/undo': undo,
  '/api/undo/execute': undoExecute,
  '/api/world': world,
};

const routerFetch: typeof fetch = async (input, init) => {
  const req = new Request(new URL(String(input), 'http://backtrack.test'), init);
  const handler = ROUTES[new URL(req.url).pathname]?.[req.method as 'GET' | 'POST'];
  if (!handler) return new Response('not found', { status: 404 });
  return handler(req);
};

/** Drains a stream, approving every gate the moment it asks. */
async function drain(client: ApiClient, stream: AsyncIterable<RunEvent>) {
  const events: RunEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === 'approval.requested') {
      await client.approval({ runId: e.runId, actionId: e.actionId, approved: true });
    }
  }
  return events;
}

/** Action ids → `#seq`, so two runs with different id schemes compare equal. */
function seqNames(snapshot: GraphSnapshot): (id: string) => string {
  const seqOf = new Map(
    snapshot.nodes.filter((n) => n.label === 'Action').map((n) => [n.id, `#${n.seq}`]),
  );
  return (id) => seqOf.get(id) ?? id;
}

/** What the graph view draws: actions, entities and the links between them. */
function graphView(snapshot: GraphSnapshot) {
  const name = seqNames(snapshot);
  const drawn = new Set(['Action', 'Entity']);
  const ids = new Set(snapshot.nodes.filter((n) => drawn.has(n.label)).map((n) => n.id));
  return {
    nodes: snapshot.nodes
      .filter((n) => drawn.has(n.label))
      .map((n) =>
        n.label === 'Action'
          ? `${name(n.id)} ${n.title} ${n.tool} ${n.kind} ${n.status} ${n.agentId} rev=${n.reversible}`
          : `${n.id} "${n.title}" ${n.status}`,
      )
      .sort(),
    links: snapshot.links
      .filter((l) => ids.has(l.source) && ids.has(l.target))
      .map((l) => `${name(l.source)} ${l.type} ${name(l.target)}`)
      .sort(),
  };
}

const worldView = (w: WorldSnapshot) =>
  w.entities
    .map((e) => ({ id: `${e.type}:${e.key}`, display: e.display, state: e.state }))
    .sort((a, b) => a.id.localeCompare(b.id));

function outcomeView(outcome: UndoOutcome, name: (id: string) => string) {
  if (outcome.kind === 'none') return { ...outcome, actionId: name(outcome.actionId) };
  if (outcome.kind === 'memory') {
    return {
      kind: outcome.kind,
      actionId: name(outcome.actionId),
      priorPlans: outcome.priorPlans.map((p) => `${p.status} ${p.summary}`),
    };
  }
  if (outcome.kind === 'unknown') {
    return { ...outcome, candidates: outcome.candidates.map((c) => `${c.seq} ${c.label}`) };
  }
  const { plan: p } = outcome;
  return {
    kind: p.status,
    root: name(p.rootActionId),
    depth: p.depth,
    summary: p.summary,
    blast: { ...p.blast, entities: [...p.blast.entities].sort() },
    crossAgent: p.crossAgent.map((c) => ({ ...c, actionId: name(c.actionId) })),
    steps: p.steps.map((s) => ({ ...s, actionId: name(s.actionId) })),
  };
}

/** The whole demo, as the panel would read it after each beat. */
async function demo(client: ApiClient) {
  const beats: Record<string, unknown> = {};
  const ops = await drain(client, client.runAgent({ agent: 'ops-agent', mode: 'replay' }));
  await drain(client, client.runAgent({ agent: 'billing-agent', mode: 'replay' }));
  const recorded = await client.graph();
  const name = seqNames(recorded);
  const gate = ops.find((e) => e.type === 'approval.requested');
  beats.gate = gate && { ...gate, actionId: name(gate.actionId), runId: '<run>' };
  beats.actions = (await client.actions()).actions.map((a) => `${a.seq} ${a.status} ${a.label}`);
  beats.recorded = graphView(recorded);
  beats.world = worldView(await client.world());
  beats.worldAt2 = worldView(await client.world(2));

  const post = recorded.nodes.find((n) => n.tool === 'post_message');
  const why = await client.explain(post?.id ?? '');
  beats.explain = {
    thought: why.thought,
    reads: why.reads.map((r) => ({ ...r, writtenBy: r.writtenBy && name(r.writtenBy) })),
    effects: why.effects.map((e) => ({ kind: e.kind, entity: e.entity, field: e.field })),
    dependsOn: why.dependsOn.map((d) => d.seq),
    dependedOnBy: why.dependedOnBy.map((d) => d.seq).sort(),
  };

  const idOf = (tool: string) => recorded.nodes.find((n) => n.tool === tool)?.id ?? '';
  const update = idOf('update_address');
  const unknown = await client.undo({ text: 'undo the weather' });
  beats.unknown = outcomeView(unknown, name);
  beats.readOnly = outcomeView(await client.undo({ actionId: idOf('lookup_order') }), name);
  beats.leaf = outcomeView(await client.undo({ actionId: idOf('apply_credit'), depth: 1 }), name);
  const atDepth = async (depth: number) => client.undo({ actionId: update, depth });
  const first = await atDepth(1);
  beats.depth1 = outcomeView(first, name);
  beats.depth3 = outcomeView(await atDepth(3), name);
  // Asking again for the same plan answers the same plan instead of recording another.
  const again = await atDepth(1);
  beats.sameIdTwice =
    first.kind === 'plan' && again.kind === 'plan' && first.plan.id === again.plan.id;

  const proposal = await client.undo({ text: 'undo the address change', depth: 5 });
  beats.text = outcomeView(proposal, name);
  if (proposal.kind !== 'plan') throw new Error(`expected a plan, got ${proposal.kind}`);
  const diff = await client.rehearse(proposal.plan.id);
  beats.rehearsal = diff.changes
    .map((c) => ({ ...c, entity: `${c.entity.type}:${c.entity.key}` }))
    .sort((a, b) => `${a.entity}.${a.field}`.localeCompare(`${b.entity}.${b.field}`));
  const ticks = await drain(client, client.executeUndo(proposal.plan.id));
  beats.ticks = ticks.map((e) =>
    e.type === 'undo.step' ? `${e.order} ${e.status} ${e.mode} ${e.entity}` : e.type,
  );
  beats.finished = ticks.at(-1)?.type === 'undo.finished' && ticks.at(-1);

  const undone = await client.graph();
  beats.undone = graphView(undone);
  beats.worldAfter = worldView(await client.world());
  beats.recall = outcomeView(await client.undo({ text: 'undo the address change' }), name);
  return JSON.parse(JSON.stringify(beats, (k, v) => (k === 'planId' ? '<plan>' : v)));
}

beforeAll(async () => {
  process.env.RESET_TOKEN = TOKEN;
});

afterAll(async () => {
  await openTenant(TENANT).drop();
  await closeDb();
});

describe('mock and real API parity', () => {
  it('the golden demo reads the same through the mock and through FalkorDB', async () => {
    const real = new HttpApiClient({ tenant: TENANT, fetch: routerFetch });
    await real.reset(TOKEN);
    const mock = new MockApiClient({ tenant: TENANT, stepDelayMs: 0, undoStepDelayMs: 0 });
    const [fromMock, fromReal] = [await demo(mock), await demo(real)];
    for (const beat of Object.keys(fromReal)) {
      expect.soft(fromMock[beat], beat).toEqual(fromReal[beat]);
    }
  }, 60_000);
});
