/**
 * MOCK ONLY: a fixture-backed, in-memory ApiClient for NEXT_PUBLIC_MOCK=1.
 *
 * It lets the panel be built and demoed without FalkorDB by imitating the real engine described
 * in the engine design notes: the golden runs replay through a tiny recorder that derives
 * DEPENDS_ON from reads and writes, the gate pauses send_email with the lock-in reason, undo plans
 * walk the dependents in reverse seq order, and execution restores each Effect's `before`.
 * Nothing here runs Cypher. Trace strings mirror the query catalogue (PLAN §5) so the UI has
 * realistic text to show, and the UI labels every screen fed by this client as mock data.
 * Everything is deterministic: ids are counters and timestamps come from a logical clock.
 */
import {
  type ActionKind,
  type ActionRecord,
  type ActionStatus,
  type AgentId,
  api,
  type EffectDraft,
  type EffectRecord,
  type EntityRef,
  type Explain,
  type GraphSnapshot,
  type Policy,
  type RehearsalDiff,
  RunEvent,
  type RunFixture,
  type UndoOutcome,
  type UndoPlan,
  type UndoStep,
  type WorldSnapshot,
} from '@backtrack/core/contracts';
import {
  type AgentRequest,
  type AlgoRequest,
  type AlgoResponse,
  type ApiClient,
  ApiError,
  type ApprovalRequest,
  type PolicyRequest,
  type UndoRequest,
} from './api';
import { runFixtures, worldSeed } from './fixtures';
import {
  correctionDraft,
  displayOf,
  type EntityState,
  keyPrefix,
  ToolError,
  type ToolOutput,
  tools,
  type WorldReader,
} from './mock-tools';

/** 2026-10-17 09:30 IST. Mock timestamps are BASE_TS + n ticks so every run renders identically. */
const BASE_TS = Date.UTC(2026, 9, 17, 4, 0, 0);
const TICK_MS = 400;
const HUMAN = 'ayush';
const UNDO_AGENT = 'backtrack';

/** Query text shown in trace strips. Mirrors the real catalogue; the mock never executes it. */
const CYPHER = {
  record: `// answers: record one tool call with its effects, reads and DEPENDS_ON edges
MATCH (c:Counter {id: 'seq'}) SET c.n = c.n + 1
CREATE (s:Step {id: $stepId, thought: $thought})-[:DID]->(a:Action {id: $actionId, seq: c.n, tool: $tool})
WITH a UNWIND $reads AS r
MATCH (e:Entity {type: r.type, key: r.key}) CREATE (a)-[:READ]->(e)
WITH a, e MATCH (w:Action {status: 'done'})-[:CAUSED]->(:Effect)-[:ON]->(e) WHERE w.seq < a.seq
WITH a, e, w ORDER BY w.seq DESC WITH a, e, collect(w)[0] AS latest
MERGE (a)-[:DEPENDS_ON {weight: 1, via: 'read'}]->(latest)
RETURN a.seq AS seq`,
  gate: `// answers: which reversible, done changes would this irreversible action lock in? (Q4)
MATCH (p:Action {id: $actionId})-[:DEPENDS_ON*1..10]->(u:Action)
WHERE u.status = 'done' AND u.reversible AND u.kind = 'do' AND (u)-[:CAUSED]->(:Effect)
RETURN DISTINCT u.id AS id, u.tool AS tool, u.seq AS seq ORDER BY seq`,
  explain: `// answers: why did this action happen, what did it read and who wrote that? (Q6)
MATCH (s:Step)-[:DID]->(a:Action {id: $actionId})
OPTIONAL MATCH (a)-[:READ]->(e:Entity)<-[:ON]-(:Effect)<-[:CAUSED]-(w:Action)
WHERE w.seq < a.seq AND w.status = 'done'
WITH a, s, e, w ORDER BY w.seq DESC
RETURN a, s.thought AS thought, e.type + ':' + e.key AS entity, collect(w)[0] AS writtenBy`,
  pageRank: `// answers: which actions does the most work depend on? (Q8)
CALL algo.pageRank('Action', 'DEPENDS_ON') YIELD node, score
RETURN node.id AS actionId, node.tool AS tool, node.seq AS seq, score ORDER BY score DESC`,
  betweenness: `// answers: which actions sit on the most dependency paths? (Q9)
CALL algo.betweenness({nodeLabels: ['Action'], relationshipTypes: ['DEPENDS_ON']}) YIELD node, score
RETURN node.id AS actionId, node.tool AS tool, node.seq AS seq, score ORDER BY score DESC`,
  wcc: `// answers: which groups of actions are independent of each other? (Q10)
CALL algo.wcc({nodeLabels: ['Action'], relationshipTypes: ['DEPENDS_ON']}) YIELD node, componentId
RETURN node.id AS actionId, node.tool AS tool, node.seq AS seq, componentId ORDER BY componentId, seq`,
  path: `// answers: how does one action depend on another? (Q11)
MATCH (a:Action {id: $from}), (b:Action {id: $to})
CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: ['DEPENDS_ON'], weightProp: 'weight',
  relDirection: 'outgoing', pathCount: 1, maxLen: 10}) YIELD path, pathWeight
RETURN [n IN nodes(path) | n.id] AS path, pathWeight AS hops`,
} as const;

// ---------- State ----------

interface WorldEntity {
  type: string;
  key: string;
  display: string;
  /** null once deleted (or undone after a create); hidden from the world panel. */
  state: EntityState | null;
}

interface ActionEntry {
  record: ActionRecord;
  thought: string | null;
  /** Entity ids (`type:key`) the tool implementation read. */
  reads: string[];
  dependsOn: { actionId: string; via: 'read' | 'write' }[];
  evidence: Explain['reads'];
}

interface RunEntry {
  id: string;
  agentId: string;
  goal: string;
  status: 'running' | 'paused' | 'done' | 'failed';
}

type PlanLinkType = 'REVERTS' | 'COULD_NOT_REVERT' | 'CONFLICT';

interface MockState {
  tick: number;
  seq: number;
  /** Next number per id prefix (act, run, stp, eff, plan, pol). */
  ids: Record<string, number>;
  /** Highest entity key number per entity type (tkt_1 → 1); keys are never reused. */
  keys: Record<string, number>;
  entities: Record<string, WorldEntity>;
  actions: ActionEntry[];
  effects: EffectRecord[];
  runs: RunEntry[];
  plans: UndoPlan[];
  policies: Policy[];
  undoes: { undoId: string; originalId: string }[];
  approvals: { actionId: string; approved: boolean }[];
  blocked: { policyId: string; actionId: string }[];
  planLinks: { planId: string; actionId: string; type: PlanLinkType; order: number }[];
}

const entityId = (type: string, key: string) => `${type}:${key}`;
const refId = (ref: EntityRef) => entityId(ref.type, ref.key);

/** Canonical JSON (sorted keys), the same comparison the engine uses for `state == after`. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function seedEntities(): Record<string, WorldEntity> {
  const entities: Record<string, WorldEntity> = {};
  for (const c of worldSeed.customers) {
    entities[entityId('customer', c.id)] = {
      type: 'customer',
      key: c.id,
      display: c.name,
      state: { ...c },
    };
  }
  for (const o of worldSeed.orders) {
    entities[entityId('order', o.id)] = {
      type: 'order',
      key: o.id,
      display: o.id,
      state: { ...o, items: [...o.items] },
    };
  }
  return entities;
}

/** Applies one change to a world. Shared by the live recorder and the time-scrubber fold. */
function applyChange(entities: Record<string, WorldEntity>, change: EffectDraft): void {
  const id = refId(change.entity);
  const current = entities[id];
  if (change.kind === 'update' && change.field) {
    if (!current?.state) throw new ToolError(`Cannot update ${id}: it does not exist`);
    current.state = { ...current.state, [change.field]: structuredClone(change.after) };
    current.display = displayOf(current.type, current.state);
    return;
  }
  const state = change.after === null ? null : (structuredClone(change.after) as EntityState);
  entities[id] = {
    type: change.entity.type,
    key: change.entity.key,
    display: state ? displayOf(change.entity.type, state) : (current?.display ?? change.entity.key),
    state,
  };
}

const TYPE_ORDER = ['order', 'customer', 'ticket', 'message', 'event', 'email', 'credit'];
const byTypeThenKey = (a: WorldEntity, b: WorldEntity) =>
  TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
  a.key.localeCompare(b.key, 'en', { numeric: true });

/** Deterministic, plausible query timings for mock traces (1–5 ms). */
const mockMs = (n: number) => 1 + ((n * 7) % 5);

// ---------- Engine ----------

interface RecordInput {
  runId: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  thought: string | null;
  kind: ActionKind;
  status: ActionStatus;
  reversible: boolean;
  inverseTool: string | null;
  mitigationTool: string | null;
  output: ToolOutput | null;
  stepId?: string;
}

/** The in-memory "graph". `fork()` is the mock's GRAPH.COPY, used by rehearsal. */
class MockEngine {
  constructor(readonly state: MockState = MockEngine.initialState()) {}

  static initialState(): MockState {
    return {
      tick: 0,
      seq: 0,
      ids: {},
      keys: {},
      entities: seedEntities(),
      actions: [],
      effects: [],
      runs: [],
      plans: [],
      policies: [],
      undoes: [],
      approvals: [],
      blocked: [],
      planLinks: [],
    };
  }

  fork(): MockEngine {
    return new MockEngine(structuredClone(this.state));
  }

  now(): number {
    return BASE_TS + this.state.tick++ * TICK_MS;
  }

  /** Mock ids keep the real shape (`act_` + 8 chars) and say what they are: act_mock0001. */
  id(prefix: string): string {
    const n = (this.state.ids[prefix] ?? 0) + 1;
    this.state.ids[prefix] = n;
    return `${prefix}_mock${String(n).padStart(4, '0')}`;
  }

  reader(): WorldReader {
    const { entities, keys } = this.state;
    return {
      get: (type, key) => structuredClone(entities[entityId(type, key)]?.state ?? null),
      all: (type) =>
        Object.values(entities)
          .filter((e) => e.type === type && e.state)
          .sort(byTypeThenKey)
          .map((e) => structuredClone(e.state as EntityState)),
      nextKey: (type) => `${keyPrefix[type] ?? type}_${(keys[type] ?? 0) + 1}`,
    };
  }

  action(id: string): ActionEntry | undefined {
    return this.state.actions.find((a) => a.record.id === id);
  }

  effectsOf(actionId: string): EffectRecord[] {
    return this.state.effects.filter((e) => e.actionId === actionId);
  }

  startRun(agentId: string, goal: string): RunEntry {
    const run: RunEntry = { id: this.id('run'), agentId, goal, status: 'running' };
    this.state.runs.push(run);
    return run;
  }

  run(id: string): RunEntry | undefined {
    return this.state.runs.find((r) => r.id === id);
  }

  /** Latest prior `done` writer of an entity: the only action a new read or write depends on. */
  private latestWriter(entity: string): ActionEntry | undefined {
    for (let i = this.state.effects.length - 1; i >= 0; i--) {
      const effect = this.state.effects[i];
      if (!effect || refId(effect.entity) !== entity) continue;
      const writer = this.action(effect.actionId);
      if (writer?.record.status === 'done') return writer;
    }
    return undefined;
  }

  /** Records an action (one recorder statement in the real engine). Done actions apply their writes. */
  record(input: RecordInput): { entry: ActionEntry; effects: EffectRecord[] } {
    const reads = (input.output?.reads ?? []).map(refId);
    const writes = (input.output?.writes ?? []).map((w) => refId(w.entity));
    // One DEPENDS_ON per prior writer, via 'read' if this action read the entity, else 'write'.
    const dependsOn = new Map<string, 'read' | 'write'>();
    for (const entity of [...reads, ...writes]) {
      const writer = this.latestWriter(entity);
      if (writer && !dependsOn.has(writer.record.id)) {
        dependsOn.set(writer.record.id, reads.includes(entity) ? 'read' : 'write');
      }
    }
    const evidence = reads.map((entity) => {
      const writer = this.latestWriter(entity);
      return {
        entity,
        saw: structuredClone(this.state.entities[entity]?.state ?? null),
        writtenBy: writer?.record.id ?? null,
        writtenAtSeq: writer?.record.seq ?? null,
      };
    });
    const record: ActionRecord = {
      id: this.id('act'),
      seq: ++this.state.seq,
      tool: input.tool,
      args: input.args,
      result: null,
      ts: this.now(),
      kind: input.kind,
      reversible: input.reversible,
      inverseTool: input.inverseTool,
      mitigationTool: input.mitigationTool,
      status: input.status,
      runId: input.runId,
      stepId: input.stepId ?? this.id('stp'),
      agentId: input.agentId,
    };
    const entry: ActionEntry = {
      record,
      thought: input.thought,
      reads,
      dependsOn: [...dependsOn].map(([actionId, via]) => ({ actionId, via })),
      evidence,
    };
    this.state.actions.push(entry);
    const effects = input.status === 'done' && input.output ? this.commit(entry, input.output) : [];
    return { entry, effects };
  }

  /** Applies a recorded action's writes (immediately, or after its approval) and marks it done. */
  commit(entry: ActionEntry, output: ToolOutput): EffectRecord[] {
    entry.record.status = 'done';
    entry.record.result = output.result;
    return output.writes.map((write) => {
      applyChange(this.state.entities, write);
      const prefix = keyPrefix[write.entity.type];
      const n = prefix ? Number(write.entity.key.slice(prefix.length + 1)) : Number.NaN;
      if (write.before === null && Number.isFinite(n)) {
        this.state.keys[write.entity.type] = Math.max(this.state.keys[write.entity.type] ?? 0, n);
      }
      const effect: EffectRecord = {
        ...structuredClone(write),
        id: this.id('eff'),
        actionId: entry.record.id,
        seq: entry.record.seq,
        ts: entry.record.ts,
      };
      this.state.effects.push(effect);
      return effect;
    });
  }

  /** Actions that depend directly on `id`, excluding undone ones and undo/mitigation actions. */
  private dependentsOf(id: string): ActionEntry[] {
    return this.state.actions.filter(
      (a) =>
        a.record.kind === 'do' &&
        a.record.status !== 'undone' &&
        a.dependsOn.some((d) => d.actionId === id),
    );
  }

  /** Q1: downstream closure within `depth` hops; `via` is the path from the dependent to the root. */
  downstream(rootId: string, depth: number): Map<string, { hops: number; via: string[] }> {
    const reached = new Map<string, { hops: number; via: string[] }>();
    let frontier = [{ id: rootId, via: [rootId] }];
    for (let hops = 1; hops <= depth && frontier.length > 0; hops++) {
      const next: typeof frontier = [];
      for (const { id, via } of frontier) {
        for (const dependent of this.dependentsOf(id)) {
          const dependentId = dependent.record.id;
          if (dependentId === rootId || reached.has(dependentId)) continue;
          const path = [dependentId, ...via];
          reached.set(dependentId, { hops, via: path });
          next.push({ id: dependentId, via: path });
        }
      }
      frontier = next;
    }
    return reached;
  }

  /** Q4: reversible, done changes upstream of a pending action that it would lock in. */
  lockIn(actionId: string): ActionEntry[] {
    const seen = new Set<string>();
    const stack = [actionId];
    while (stack.length > 0) {
      const entry = this.action(stack.pop() as string);
      for (const dep of entry?.dependsOn ?? []) {
        if (!seen.has(dep.actionId)) {
          seen.add(dep.actionId);
          stack.push(dep.actionId);
        }
      }
    }
    return [...seen]
      .map((id) => this.action(id))
      .filter(
        (a): a is ActionEntry =>
          !!a &&
          a.record.status === 'done' &&
          a.record.reversible &&
          a.record.kind === 'do' &&
          this.effectsOf(a.record.id).length > 0,
      )
      .sort((a, b) => a.record.seq - b.record.seq);
  }

  blockingPolicy(tool: string, agentId: string): Policy | undefined {
    return this.state.policies.find(
      (p) => p.kind === 'block' && p.tool === tool && (p.agentId === null || p.agentId === agentId),
    );
  }

  /** The entity an undo step names: what the action created, else what it changed, else read. */
  primaryEntity(entry: ActionEntry): EntityRef | null {
    const effects = this.effectsOf(entry.record.id);
    const effect = effects.find((e) => e.before === null) ?? effects[0];
    if (effect) return effect.entity;
    const read = entry.reads[0] ? this.state.entities[entry.reads[0]] : undefined;
    return read ? { type: read.type, key: read.key, display: read.display } : null;
  }

  label(entry: ActionEntry): string {
    const entity = this.primaryEntity(entry);
    return entity ? `${entry.record.tool} ${entity.key}` : entry.record.tool;
  }

  /** Q2 + Q3 + Q7: the undo plan for a root at a depth, in reverse dependency order (seq DESC). */
  proposeUndo(root: ActionEntry, depth: number): UndoPlan {
    const closure = this.downstream(root.record.id, depth);
    // Read-only dependents are leaves with nothing to undo, so the plan lists only changes.
    const members = [root, ...[...closure.keys()].map((id) => this.action(id) as ActionEntry)]
      .filter(
        (a) => a === root || (a.record.status === 'done' && this.effectsOf(a.record.id).length > 0),
      )
      .sort((a, b) => b.record.seq - a.record.seq);

    const steps: UndoStep[] = members.map((a, i) => {
      const spec = tools[a.record.tool];
      const entity = this.primaryEntity(a);
      const reach = closure.get(a.record.id);
      const undoTool = a.record.reversible ? a.record.inverseTool : a.record.mitigationTool;
      return {
        order: i + 1,
        actionId: a.record.id,
        tool: a.record.tool,
        seq: a.record.seq,
        agentId: a.record.agentId,
        mode: spec?.undoMode ?? 'skip',
        label: `${undoTool ?? 'skip'}${entity ? ` ${entity.key}` : ''} (${a.record.tool})`,
        entity,
        hops: reach?.hops ?? 0,
        // Same shape as the engine's Q1 row: tool names from the root to this dependent, both
        // included; the root's own step is just its tool.
        via: reach
          ? [...reach.via].reverse().map((id) => this.action(id)?.record.tool ?? id)
          : [a.record.tool],
      };
    });

    const irreversible = steps.filter((s) => s.mode === 'mitigation');
    const crossAgent = steps
      .filter((s) => s.agentId !== root.record.agentId)
      .map(({ agentId, actionId, tool, hops }) => ({ agentId, actionId, tool, hops }));
    const entities = [
      ...new Set(members.flatMap((a) => this.effectsOf(a.record.id).map((e) => refId(e.entity)))),
    ];

    const parts = [`${steps.length} steps in reverse dependency order`];
    if (irreversible.length > 0) {
      parts.push(
        `${irreversible.length} irreversible (${irreversible.map((s) => s.tool).join(', ')}) gets a mitigation`,
      );
    }
    if (crossAgent.length > 0) {
      parts.push(`reaches ${[...new Set(crossAgent.map((c) => c.agentId))].join(', ')}`);
    }
    const plan: UndoPlan = {
      id: this.id('plan'),
      rootActionId: root.record.id,
      depth,
      status: 'proposed',
      steps,
      blast: { actions: steps.length, irreversible: irreversible.length, entities, depth },
      crossAgent,
      summary: `Undo ${root.record.tool} (seq ${root.record.seq}) at depth ${depth}: ${parts.join('; ')}.`,
      ts: this.now(),
    };
    this.state.plans.push(plan);
    return plan;
  }

  plan(planId: string): UndoPlan | undefined {
    return this.state.plans.find((p) => p.id === planId);
  }

  /** Q14: an effect can be restored only if the world still holds what the effect wrote. */
  private stillAsWritten(effect: EffectRecord): boolean {
    const current = this.state.entities[refId(effect.entity)]?.state ?? null;
    if (effect.kind === 'update' && effect.field) {
      return canonical(current?.[effect.field] ?? null) === canonical(effect.after);
    }
    return canonical(current) === canonical(effect.after);
  }

  /** The change that puts an effect's `before` back (a create is restored to "does not exist"). */
  private restoreOf(effect: EffectRecord): EffectDraft {
    const current = this.state.entities[refId(effect.entity)]?.state ?? null;
    if (effect.kind === 'update' && effect.field) {
      const before = current?.[effect.field] ?? null;
      return {
        kind: 'update',
        entity: effect.entity,
        field: effect.field,
        before,
        after: effect.before,
      };
    }
    return {
      kind: effect.before === null ? 'delete' : 'create',
      entity: effect.entity,
      field: null,
      before: current,
      after: effect.before,
    };
  }

  /** Executes one plan step and records it as an undo (or mitigation) action in an undo run. */
  revert(plan: UndoPlan, step: UndoStep, runId: string): 'done' | 'conflict' | 'skipped' {
    const original = this.action(step.actionId);
    if (!original || original.record.status === 'undone') return 'skipped';
    const link = (type: PlanLinkType) =>
      this.state.planLinks.push({
        planId: plan.id,
        actionId: step.actionId,
        type,
        order: step.order,
      });
    const base = {
      runId,
      agentId: UNDO_AGENT,
      thought: `Step ${step.order} of ${plan.id}: ${step.label}`,
      status: 'done' as const,
      reversible: false,
      inverseTool: null,
      mitigationTool: null,
    };

    if (step.mode === 'mitigation') {
      // An email cannot be unsent: record a correction draft and leave the original as done.
      const sent = this.effectsOf(original.record.id)[0]?.after as EntityState | undefined;
      if (!sent) return 'skipped';
      const draft = correctionDraft(this.reader(), sent);
      this.record({
        ...base,
        tool: original.record.mitigationTool ?? 'mitigation',
        args: { actionId: original.record.id },
        kind: 'mitigation',
        output: { result: { draft: draft.entity.key }, reads: [], writes: [draft] },
      });
      link('COULD_NOT_REVERT');
      return 'done';
    }

    const effects = this.effectsOf(original.record.id);
    if (!effects.every((e) => this.stillAsWritten(e))) {
      link('CONFLICT');
      return 'conflict';
    }
    const { entry } = this.record({
      ...base,
      tool: original.record.inverseTool ?? 'restore',
      args: { actionId: original.record.id },
      kind: 'undo',
      output: {
        result: { undoes: original.record.id },
        reads: [],
        writes: [...effects].reverse().map((e) => this.restoreOf(e)),
      },
    });
    this.state.undoes.push({ undoId: entry.record.id, originalId: original.record.id });
    original.record.status = 'undone';
    link('REVERTS');
    return 'done';
  }

  /** The world now, or folded from the seed through every Effect with seq <= asOfSeq. */
  world(asOfSeq?: number): WorldEntity[] {
    let entities = this.state.entities;
    if (asOfSeq !== undefined) {
      entities = seedEntities();
      for (const effect of this.state.effects)
        if (effect.seq <= asOfSeq) applyChange(entities, effect);
    }
    return Object.values(entities)
      .filter((e) => e.state !== null)
      .sort(byTypeThenKey);
  }

  graph(): GraphSnapshot {
    const { state } = this;
    const nodes: GraphSnapshot['nodes'] = [];
    const links: GraphSnapshot['links'] = [];
    const agents = [...new Set(state.runs.map((r) => r.agentId))];
    const usesHuman =
      state.approvals.length > 0 || state.plans.length > 0 || state.policies.length > 0;
    if (usesHuman) nodes.push({ id: HUMAN, label: 'User', title: HUMAN });
    for (const agent of agents) nodes.push({ id: agent, label: 'Agent', title: agent });
    for (const run of state.runs) {
      nodes.push({
        id: run.id,
        label: 'Run',
        title: run.goal,
        status: run.status,
        agentId: run.agentId,
      });
      links.push({ source: run.agentId, target: run.id, type: 'RAN' });
    }

    const touched = new Set<string>();
    for (const a of state.actions) {
      const { record } = a;
      nodes.push({
        id: record.id,
        label: 'Action',
        title: record.tool,
        status: record.status,
        tool: record.tool,
        kind: record.kind,
        seq: record.seq,
        agentId: record.agentId,
        runId: record.runId,
        reversible: record.reversible,
      });
      // The snapshot has no Step or Effect nodes: Run-[:DID]->Action stands for Run-HAS-Step-DID,
      // and Action-[:CAUSED]->Entity for Action-CAUSED-Effect-ON-Entity.
      links.push({ source: record.runId, target: record.id, type: 'DID' });
      for (const entity of a.reads) {
        touched.add(entity);
        links.push({ source: record.id, target: entity, type: 'READ' });
      }
      for (const entity of new Set(this.effectsOf(record.id).map((e) => refId(e.entity)))) {
        touched.add(entity);
        links.push({ source: record.id, target: entity, type: 'CAUSED' });
      }
      for (const dep of a.dependsOn)
        links.push({ source: record.id, target: dep.actionId, type: 'DEPENDS_ON' });
    }
    for (const id of touched) {
      const entity = state.entities[id];
      if (entity)
        nodes.push({
          id,
          label: 'Entity',
          title: entity.display,
          status: entity.state ? 'present' : 'deleted',
        });
    }
    for (const { undoId, originalId } of state.undoes)
      links.push({ source: undoId, target: originalId, type: 'UNDOES' });
    for (const { actionId, approved } of state.approvals) {
      links.push({ source: HUMAN, target: actionId, type: approved ? 'APPROVED' : 'DENIED' });
    }
    for (const plan of state.plans) {
      nodes.push({ id: plan.id, label: 'UndoPlan', title: plan.summary, status: plan.status });
      links.push({ source: HUMAN, target: plan.id, type: 'REQUESTED' });
      links.push({ source: plan.id, target: plan.rootActionId, type: 'ROOT' });
    }
    for (const { planId, actionId, type, order } of state.planLinks) {
      links.push({ source: planId, target: actionId, type, order });
    }
    for (const policy of state.policies) {
      nodes.push({ id: policy.id, label: 'Policy', title: policy.rule, kind: policy.kind });
      links.push({ source: HUMAN, target: policy.id, type: 'SET' });
    }
    for (const { policyId, actionId } of state.blocked)
      links.push({ source: policyId, target: actionId, type: 'BLOCKED' });
    return { nodes, links };
  }

  explain(entry: ActionEntry): Explain {
    const ref = (a: ActionEntry) => ({
      actionId: a.record.id,
      tool: a.record.tool,
      seq: a.record.seq,
    });
    const effects = this.effectsOf(entry.record.id);
    const dependsOn = entry.dependsOn.map((d) => ref(this.action(d.actionId) as ActionEntry));
    const dependedOnBy = this.state.actions
      .filter((a) => a.dependsOn.some((d) => d.actionId === entry.record.id))
      .map(ref);
    return {
      action: entry.record,
      thought: entry.thought,
      reads: entry.evidence,
      effects,
      dependsOn,
      dependedOnBy,
      trace: {
        cypher: CYPHER.explain,
        params: { actionId: entry.record.id },
        ms: mockMs(entry.record.seq),
        rows: Math.max(1, entry.evidence.length),
      },
    };
  }

  /** Text → action, the way resolve_action does it: keyword hits, ties go to the latest action. */
  resolveText(text: string): ActionEntry | undefined {
    const words: string[] = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    const direct = this.state.actions.find((a) => words.includes(a.record.id));
    if (direct) return direct;
    let best: { entry: ActionEntry; score: number } | undefined;
    for (const entry of this.state.actions) {
      if (entry.record.kind !== 'do') continue;
      const keywords = tools[entry.record.tool]?.keywords ?? [];
      const score = words.filter((w) => keywords.includes(w)).length;
      if (score > 0 && (!best || score >= best.score)) best = { entry, score };
    }
    return best?.entry;
  }

  /** The three most recent changes an undo request could have meant. */
  candidates(): { id: string; tool: string; seq: number; label: string }[] {
    return this.state.actions
      .filter(
        (a) =>
          a.record.kind === 'do' &&
          a.record.status === 'done' &&
          this.effectsOf(a.record.id).length > 0,
      )
      .sort((a, b) => b.record.seq - a.record.seq)
      .slice(0, 3)
      .map((a) => ({
        id: a.record.id,
        tool: a.record.tool,
        seq: a.record.seq,
        label: this.label(a),
      }));
  }

  /** Live, done `do` actions and their DEPENDS_ON edges: the subgraph the algorithms run on. */
  private algoGraph(): { ids: string[]; edges: [string, string][] } {
    const live = this.state.actions.filter(
      (a) => a.record.kind === 'do' && a.record.status === 'done',
    );
    const ids = live.map((a) => a.record.id);
    const edges = live.flatMap((a) =>
      a.dependsOn
        .filter((d) => ids.includes(d.actionId))
        .map((d): [string, string] => [a.record.id, d.actionId]),
    );
    return { ids, edges };
  }

  algo(name: AlgoRequest['name'], from?: string, to?: string): AlgoResponse {
    const { ids, edges } = this.algoGraph();
    const row = (id: string) => {
      const a = this.action(id) as ActionEntry;
      return { actionId: id, tool: a.record.tool, seq: a.record.seq };
    };
    const ms = mockMs(ids.length);
    switch (name) {
      case 'load_bearing': {
        const scores = pageRank(ids, edges);
        const rows = ids.map((id) => ({ ...row(id), score: round(scores.get(id) ?? 0) }));
        return { rows: rows.sort((a, b) => b.score - a.score), cypher: CYPHER.pageRank, ms };
      }
      case 'hinge_actions': {
        const scores = betweenness(ids, edges);
        const rows = ids.map((id) => ({ ...row(id), score: round(scores.get(id) ?? 0) }));
        return { rows: rows.sort((a, b) => b.score - a.score), cypher: CYPHER.betweenness, ms };
      }
      case 'independent_clusters': {
        const component = components(ids, edges);
        const rows = ids.map((id) => ({ ...row(id), componentId: component.get(id) ?? 0 }));
        return { rows, cypher: CYPHER.wcc, ms };
      }
      case 'path_between': {
        if (!from || !to)
          throw new ApiError('path_between needs both "from" and "to"', 400, '/api/algo');
        const path = shortestPath(edges, from, to);
        const rows = path
          ? [{ path, tools: path.map((id) => row(id).tool), hops: path.length - 1 }]
          : [];
        return { rows, cypher: CYPHER.path, ms };
      }
    }
  }
}

// ---------- Graph algorithms (mock stand-ins for FalkorDB's algo.* procedures) ----------

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** PageRank where rank flows from a dependent to what it depends on. */
function pageRank(ids: string[], edges: [string, string][], damping = 0.85, iterations = 20) {
  const n = ids.length;
  let rank = new Map(ids.map((id) => [id, 1 / n]));
  const out = new Map(ids.map((id) => [id, edges.filter(([s]) => s === id).map(([, t]) => t)]));
  for (let i = 0; i < iterations; i++) {
    const next = new Map(ids.map((id) => [id, (1 - damping) / n]));
    for (const id of ids) {
      const targets = out.get(id) ?? [];
      const share = (rank.get(id) ?? 0) * damping;
      // A node with no dependencies spreads its rank evenly (standard dangling-node handling).
      const spread = targets.length > 0 ? targets : ids;
      for (const t of spread) next.set(t, (next.get(t) ?? 0) + share / spread.length);
    }
    rank = next;
  }
  return rank;
}

/** Brandes betweenness centrality on the directed DEPENDS_ON graph. */
function betweenness(ids: string[], edges: [string, string][]) {
  const score = new Map(ids.map((id) => [id, 0]));
  const out = new Map(ids.map((id) => [id, edges.filter(([s]) => s === id).map(([, t]) => t)]));
  for (const source of ids) {
    const stack: string[] = [];
    const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
    const paths = new Map(ids.map((id) => [id, 0]));
    const dist = new Map(ids.map((id) => [id, -1]));
    paths.set(source, 1);
    dist.set(source, 0);
    const queue = [source];
    while (queue.length > 0) {
      const v = queue.shift() as string;
      stack.push(v);
      for (const w of out.get(v) ?? []) {
        if (dist.get(w) === -1) {
          dist.set(w, (dist.get(v) ?? 0) + 1);
          queue.push(w);
        }
        if (dist.get(w) === (dist.get(v) ?? 0) + 1) {
          paths.set(w, (paths.get(w) ?? 0) + (paths.get(v) ?? 0));
          preds.get(w)?.push(v);
        }
      }
    }
    const delta = new Map(ids.map((id) => [id, 0]));
    while (stack.length > 0) {
      const w = stack.pop() as string;
      for (const v of preds.get(w) ?? []) {
        const share = ((paths.get(v) ?? 0) / (paths.get(w) ?? 1)) * (1 + (delta.get(w) ?? 0));
        delta.set(v, (delta.get(v) ?? 0) + share);
      }
      if (w !== source) score.set(w, (score.get(w) ?? 0) + (delta.get(w) ?? 0));
    }
  }
  return score;
}

/** Weakly connected components, numbered in seq order of their first action. */
function components(ids: string[], edges: [string, string][]) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    return p === id ? id : find(p);
  };
  for (const [a, b] of edges) parent.set(find(a), find(b));
  const numbers = new Map<string, number>();
  return new Map(
    ids.map((id) => {
      const root = find(id);
      if (!numbers.has(root)) numbers.set(root, numbers.size);
      return [id, numbers.get(root) ?? 0];
    }),
  );
}

/** Shortest path following DEPENDS_ON from `from` to `to` (outgoing), as action ids. */
function shortestPath(edges: [string, string][], from: string, to: string): string[] | null {
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const last = path[path.length - 1];
    if (last === to) return path;
    for (const [s, t] of edges) {
      if (s === last && !seen.has(t)) {
        seen.add(t);
        queue.push([...path, t]);
      }
    }
  }
  return null;
}

// ---------- Client ----------

/** Resolves `{ "$ref": "steps.N.result.path" }` arguments against earlier step results. */
function resolveArgs(
  args: RunFixture['steps'][number]['args'],
  results: unknown[],
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (value === null || typeof value !== 'object') {
      resolved[name] = value;
      continue;
    }
    const [, index, , ...path] = value.$ref.split('.');
    let current: unknown = results[Number(index)];
    for (const part of path) {
      current =
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[part]
          : undefined;
    }
    if (current === undefined) {
      throw new ToolError(
        `Cannot resolve ${value.$ref}: step ${index} returned nothing at that path`,
      );
    }
    resolved[name] = current;
  }
  return resolved;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Every mock event is checked against the contract, so the mock cannot drift from the real stream. */
const event = (e: RunEvent): RunEvent => RunEvent.parse(e);

export interface MockOptions {
  tenant?: string;
  /** Pause between replayed run events (the real replay paces at ~400 ms). */
  stepDelayMs?: number;
  /** Pause between undo steps (the real executor paces at ~500 ms). */
  undoStepDelayMs?: number;
}

interface PendingApproval {
  runId: string;
  actionId: string;
  settle: (approved: boolean) => void;
}

export class MockApiClient implements ApiClient {
  readonly kind = 'mock';
  readonly tenant: string;
  private engine = new MockEngine();
  private readonly stepDelayMs: number;
  private readonly undoStepDelayMs: number;
  private activeRunId: string | null = null;
  private pending: PendingApproval | null = null;

  constructor({ tenant = 'demo', stepDelayMs = 400, undoStepDelayMs = 500 }: MockOptions = {}) {
    this.tenant = tenant;
    this.stepDelayMs = stepDelayMs;
    this.undoStepDelayMs = undoStepDelayMs;
  }

  async graph() {
    return api.graph.response.parse(this.engine.graph());
  }

  async world(asOfSeq?: number): Promise<WorldSnapshot> {
    const entities = this.engine.world(asOfSeq).map(({ type, key, display, state }) => ({
      type,
      key,
      display,
      state: state ?? {},
    }));
    return api.world.response.parse({ tenant: this.tenant, asOfSeq: asOfSeq ?? null, entities });
  }

  async actions() {
    const actions = this.engine.state.actions.map((a) => ({
      id: a.record.id,
      seq: a.record.seq,
      tool: a.record.tool,
      status: a.record.status,
      agentId: a.record.agentId,
      label: this.engine.label(a),
    }));
    return api.actions.response.parse({ actions });
  }

  async explain(actionId: string) {
    const entry = this.engine.action(actionId);
    if (!entry)
      throw new ApiError(`No action ${actionId} in bt:${this.tenant}`, 404, '/api/explain');
    return api.explain.response.parse(this.engine.explain(entry));
  }

  /** The real route checks RESET_TOKEN; the mock accepts any token because it guards nothing. */
  async reset(_token: string) {
    this.pending?.settle(false);
    this.pending = null;
    this.activeRunId = null;
    this.engine = new MockEngine();
    return { ok: true, seededAt: BASE_TS };
  }

  async *runAgent(request: AgentRequest, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    const { agent, mode, goal } = api.agent.body.parse({ ...request, tenant: this.tenant });
    if (mode === 'llm') {
      yield event({
        type: 'error',
        runId: null,
        message:
          'Live LLM runs need the real API. The mock client only replays fixtures (NEXT_PUBLIC_MOCK=1).',
      });
      return;
    }
    if (this.activeRunId) {
      yield event({
        type: 'error',
        runId: null,
        message: `Run ${this.activeRunId} is still in progress.`,
      });
      return;
    }
    // Hold on to this engine: if the world is reset mid-run, the stale run simply stops.
    const engine = this.engine;
    const fixture = runFixtures[agent];
    const run = engine.startRun(agent, goal ?? fixture.goal);
    this.activeRunId = run.id;
    try {
      yield event({
        type: 'run.started',
        runId: run.id,
        agentId: agent,
        mode,
        goal: run.goal,
        model: null,
        ts: engine.now(),
      });
      yield* this.replaySteps(engine, run, agent, fixture, signal);
    } finally {
      if (this.activeRunId === run.id) this.activeRunId = null;
      if (this.pending?.runId === run.id) this.pending = null;
    }
  }

  private async *replaySteps(
    engine: MockEngine,
    run: RunEntry,
    agent: AgentId,
    fixture: RunFixture,
    signal?: AbortSignal,
  ): AsyncGenerator<RunEvent> {
    const results: unknown[] = [];
    const fail = (message: string) => {
      run.status = 'failed';
      return [
        event({ type: 'error', runId: run.id, message }),
        event({ type: 'run.finished', runId: run.id, status: 'failed', ts: engine.now() }),
      ];
    };

    for (const [index, step] of fixture.steps.entries()) {
      await sleep(this.stepDelayMs, signal);
      if (engine !== this.engine) return;
      const stepId = engine.id('stp');
      yield event({
        type: 'step',
        runId: run.id,
        stepId,
        index,
        thought: step.thought,
        ts: engine.now(),
      });

      const spec = tools[step.tool];
      let args: Record<string, unknown>;
      let output: ToolOutput;
      try {
        if (!spec) throw new ToolError(`Unknown tool ${step.tool}`);
        args = resolveArgs(step.args, results);
        output = spec.run(args, engine.reader());
      } catch (error) {
        yield* fail(error instanceof Error ? error.message : String(error));
        return;
      }
      const base = {
        runId: run.id,
        agentId: agent,
        stepId,
        tool: step.tool,
        args,
        thought: step.thought,
        kind: 'do' as const,
        reversible: spec.reversible,
        inverseTool: spec.inverseTool,
        mitigationTool: spec.mitigationTool,
      };

      // Q5: a "never again" policy blocks the call before it touches the world.
      const policy = engine.blockingPolicy(step.tool, agent);
      if (policy) {
        const { entry } = engine.record({ ...base, status: 'blocked', output: null });
        engine.state.blocked.push({ policyId: policy.id, actionId: entry.record.id });
        yield event({
          type: 'action.blocked',
          runId: run.id,
          actionId: entry.record.id,
          tool: step.tool,
          policyId: policy.id,
          rule: policy.rule,
        });
        results.push(null);
        continue;
      }

      // Q4: an irreversible call is recorded as pending; if it would lock in reversible changes,
      // the run pauses for a human. The pending action is already in the graph with its edges.
      let entry: ActionEntry;
      let effects: EffectRecord[];
      if (!spec.reversible) {
        ({ entry } = engine.record({ ...base, status: 'pending', output }));
        const locked = engine.lockIn(entry.record.id);
        if (locked.length > 0) {
          const lockedTools = locked.map((a) => a.record.tool);
          run.status = 'paused';
          // Register the wait before announcing it, so an approval sent the moment the event
          // arrives finds the pending request (the real route records it in the graph first).
          const answer = this.waitForApproval(run.id, entry.record.id, signal);
          yield event({
            type: 'approval.requested',
            runId: run.id,
            actionId: entry.record.id,
            tool: step.tool,
            args,
            reason: `would lock in ${locked.length} reversible change${locked.length === 1 ? '' : 's'}: ${lockedTools.join(', ')}`,
            wouldLock: locked.length,
            lockedTools,
          });
          const approved = await answer;
          signal?.throwIfAborted();
          if (engine !== this.engine) return;
          run.status = 'running';
          engine.state.approvals.push({ actionId: entry.record.id, approved });
          yield event({
            type: 'approval.resolved',
            runId: run.id,
            actionId: entry.record.id,
            approved,
            by: HUMAN,
          });
          if (!approved) {
            entry.record.status = 'denied';
            results.push(null);
            continue;
          }
        }
        await sleep(this.stepDelayMs, signal);
        if (engine !== this.engine) return;
        effects = engine.commit(entry, output);
      } else {
        await sleep(this.stepDelayMs, signal);
        if (engine !== this.engine) return;
        ({ entry, effects } = engine.record({ ...base, status: 'done', output }));
      }

      results.push(output.result);
      yield event({
        type: 'action.recorded',
        runId: run.id,
        action: structuredClone(entry.record),
        effects,
        reads: entry.reads,
        dependsOn: entry.dependsOn.map((d) => d.actionId),
        trace: { cypher: CYPHER.record, ms: mockMs(entry.record.seq), rows: 1 },
      });
    }
    run.status = 'done';
    yield event({ type: 'run.finished', runId: run.id, status: 'done', ts: engine.now() });
  }

  /** Never rejects: an abandoned stream would leave the rejection unhandled. Abort reads as "no". */
  private waitForApproval(runId: string, actionId: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending = { runId, actionId, settle: resolve };
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    });
  }

  async approval({ runId, actionId, approved }: ApprovalRequest) {
    const pending = this.pending;
    if (!pending || pending.runId !== runId || pending.actionId !== actionId) return { ok: false };
    this.pending = null;
    pending.settle(approved);
    return { ok: true };
  }

  async undo(request: UndoRequest): Promise<UndoOutcome> {
    const { text, actionId, depth } = api.undo.body.parse({ ...request, tenant: this.tenant });
    const { engine } = this;
    const query = text ?? actionId ?? '';
    const target = actionId ? engine.action(actionId) : engine.resolveText(query);
    if (!target)
      return api.undo.response.parse({ kind: 'unknown', query, candidates: engine.candidates() });

    const { record } = target;
    if (record.status === 'undone') {
      // Q13 recall: say when it was undone before instead of planning again.
      const priorPlans = engine.state.plans
        .filter((p) => p.steps.some((s) => s.actionId === record.id) && p.status !== 'proposed')
        .map(({ id, ts, status, summary }) => ({ id, ts, status, summary }));
      return api.undo.response.parse({ kind: 'memory', actionId: record.id, priorPlans });
    }
    if (engine.downstream(record.id, 10).size === 0) {
      const reason =
        engine.effectsOf(record.id).length === 0
          ? `${record.tool} (seq ${record.seq}) only read data; there is nothing to undo.`
          : `Nothing depends on ${record.tool} (seq ${record.seq}); undoing it affects no other action.`;
      return api.undo.response.parse({ kind: 'none', actionId: record.id, reason });
    }
    return api.undo.response.parse({ kind: 'plan', plan: engine.proposeUndo(target, depth) });
  }

  async *executeUndo(planId: string, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    const engine = this.engine;
    const plan = engine.plan(planId);
    if (!plan || plan.status === 'executed' || plan.status === 'executing') {
      const message = plan
        ? `Plan ${planId} is already ${plan.status}.`
        : `No undo plan ${planId}.`;
      yield event({ type: 'error', runId: null, message });
      return;
    }
    plan.status = 'executing';
    const run = engine.startRun(UNDO_AGENT, plan.summary);
    const outcomes: string[] = [];
    for (const step of plan.steps) {
      const base = {
        planId,
        order: step.order,
        actionId: step.actionId,
        label: step.label,
        entity: step.entity ? refId(step.entity) : null,
      };
      yield event({ type: 'undo.step', ...base, mode: step.mode, status: 'started' });
      await sleep(this.undoStepDelayMs, signal);
      if (engine !== this.engine) return;
      const status = engine.revert(plan, step, run.id);
      outcomes.push(status);
      const mode = status === 'conflict' ? 'conflict' : status === 'skipped' ? 'skip' : step.mode;
      yield event({ type: 'undo.step', ...base, mode, status });
    }
    const conflicts = outcomes.filter((s) => s === 'conflict').length;
    plan.status =
      conflicts === 0 ? 'executed' : conflicts === outcomes.length ? 'conflict' : 'partial';
    run.status = 'done';
    yield event({ type: 'undo.finished', planId, status: plan.status });
  }

  /** Executes the plan on a fork (the mock's GRAPH.COPY) and diffs the fork's world against live. */
  async rehearse(planId: string): Promise<RehearsalDiff> {
    const plan = this.engine.plan(planId);
    if (!plan) throw new ApiError(`No undo plan ${planId}`, 404, '/api/rehearse');
    const fork = this.engine.fork();
    const forkPlan = fork.plan(planId) as UndoPlan;
    const run = fork.startRun(UNDO_AGENT, plan.summary);
    for (const step of forkPlan.steps) fork.revert(forkPlan, step, run.id);

    const live = this.engine.state.entities;
    const changes: RehearsalDiff['changes'] = [];
    for (const [id, after] of Object.entries(fork.state.entities)) {
      const before = live[id];
      const entity = { type: after.type, key: after.key, display: after.display };
      if (!before?.state || !after.state) {
        if (canonical(before?.state ?? null) !== canonical(after.state)) {
          changes.push({ entity, field: null, from: before?.state ?? null, to: after.state });
        }
        continue;
      }
      for (const field of Object.keys({ ...before.state, ...after.state })) {
        if (canonical(before.state[field]) !== canonical(after.state[field])) {
          changes.push({ entity, field, from: before.state[field], to: after.state[field] });
        }
      }
    }
    plan.status = 'rehearsed';
    return api.rehearse.response.parse({
      planId,
      changes,
      forkGraph: `bt:${this.tenant}:fork:${planId}`,
    });
  }

  async plan(planId: string) {
    const plan = this.engine.plan(planId);
    if (!plan) throw new ApiError(`No undo plan ${planId}`, 404, '/api/plan');
    return api.plan.response.parse(plan);
  }

  async policy(request: PolicyRequest) {
    const { tenant: _tenant, ...fields } = api.policy.body.parse({
      ...request,
      tenant: this.tenant,
    });
    const policy: Policy = { ...fields, id: this.engine.id('pol'), ts: this.engine.now() };
    this.engine.state.policies.push(policy);
    return api.policy.response.parse(policy);
  }

  async algo({ name, from, to }: AlgoRequest) {
    return api.algo.response.parse(this.engine.algo(name, from, to));
  }
}
