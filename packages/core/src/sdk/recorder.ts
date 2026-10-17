/**
 * The recorder: turns one tool call into graph history.
 *
 * Each action is written by a single Cypher statement (R3 in queries.ts): bump the seq counter,
 * create the Action under its Step, add READ edges, create Effects and set the new Entity state,
 * and derive DEPENDS_ON to the latest earlier `done` writer of every entity the action read or
 * wrote. One statement means the world, the history and the dependency edges can never disagree,
 * and FalkorDB's per-graph write serialisation makes concurrent agents safe without transactions.
 *
 * Only original actions (`kind: 'do'`) get DEPENDS_ON edges. Undo and mitigation actions are
 * linked by UNDOES instead, so a traversal from an original never wanders into compensations.
 */
import { customAlphabet } from 'nanoid';
import type { RunEvent } from '../contracts/events.js';
import type {
  ActionKind,
  ActionRecord,
  EffectDraft,
  EffectRecord,
  EntityRef,
  RunMode,
  ToolResult,
} from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { stableStringify } from '../graph/cypher.js';
import {
  commitAction,
  createRun,
  createStep,
  recordAction as recordActionQuery,
  setRunStatus,
} from '../graph/queries.js';
import { applyEffect, getMany, type State } from '../world/store.js';
import { displayOf, entityKey } from '../world/types.js';

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);
export const newId = (prefix: 'act' | 'run' | 'stp' | 'plan' | 'pol'): string =>
  `${prefix}_${nano()}`;

export interface StartedRun {
  runId: string;
  event: Extract<RunEvent, { type: 'run.started' }>;
}

export async function startRun(
  g: TenantGraph,
  input: {
    agentId: string;
    kind: 'agent' | 'undo';
    goal: string;
    mode: RunMode;
    model?: string | null;
    runId?: string;
  },
): Promise<StartedRun> {
  const runId = input.runId ?? newId('run');
  const ts = Date.now();
  const { rows } = await createRun(g, {
    runId,
    agentId: input.agentId,
    kind: input.kind,
    goal: input.goal,
    model: input.model ?? null,
    ts,
  });
  if (rows.length === 0)
    throw new Error(`Unknown agent ${input.agentId}; was the tenant bootstrapped?`);
  return {
    runId,
    event: {
      type: 'run.started',
      runId,
      agentId: input.agentId,
      mode: input.mode,
      goal: input.goal,
      model: input.model ?? null,
      ts,
    },
  };
}

export async function startStep(
  g: TenantGraph,
  input: { runId: string; index: number; thought: string },
): Promise<{ stepId: string; event: Extract<RunEvent, { type: 'step' }> }> {
  const stepId = newId('stp');
  const ts = Date.now();
  await createStep(g, { ...input, stepId, ts });
  return {
    stepId,
    event: {
      type: 'step',
      runId: input.runId,
      stepId,
      index: input.index,
      thought: input.thought,
      ts,
    },
  };
}

export async function finishRun(
  g: TenantGraph,
  runId: string,
  status: 'done' | 'failed' | 'paused' | 'running',
  pendingActionId: string | null = null,
): Promise<void> {
  await setRunStatus(g, { runId, status, pendingActionId, ts: Date.now() });
}

export interface RecordInput {
  runId: string;
  stepId: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  kind: ActionKind;
  /** `pending` records reads and dependencies but defers the writes until `commitPending`. */
  status: 'done' | 'pending' | 'blocked' | 'denied';
  reversible: boolean;
  inverseTool: string | null;
  mitigationTool: string | null;
  /** What the tool implementation returned; null when it never ran (blocked). */
  outcome: ToolResult | null;
  /** For undo and mitigation actions: the original action they compensate. */
  undoes?: string | null;
  actionId?: string;
}

export interface RecordedAction {
  action: ActionRecord;
  effects: EffectRecord[];
  /** Entities read, as `type:key`. */
  reads: string[];
  /** Ids of the actions this one now depends on. */
  dependsOn: string[];
  trace: { cypher: string; ms: number; rows: number };
  /** Writes held back while the action is pending. */
  pendingWrites: EffectDraft[];
}

export async function record(g: TenantGraph, input: RecordInput): Promise<RecordedAction> {
  const actionId = input.actionId ?? newId('act');
  const ts = Date.now();
  const reads = dedupeRefs(input.outcome?.reads ?? []);
  const writes = input.outcome?.writes ?? [];
  const applyNow = input.status === 'done';
  const applied = applyNow ? await planWrites(g, actionId, writes) : emptyWrites();

  // Dependencies are derived for original actions only, from every entity touched: what it read
  // (via 'read') and what it wrote or is about to write (via 'write', write-after-write).
  const deps =
    input.kind === 'do'
      ? [
          ...reads.map((r) => ({ ref: r, via: 'read' })),
          ...dedupeRefs(writes.map((w) => w.entity)).map((r) => ({ ref: r, via: 'write' })),
        ]
      : [];

  const res = await recordActionQuery(g, {
    stepId: input.stepId,
    actionId,
    tool: input.tool,
    args: stableStringify(input.args),
    result: stableStringify(input.outcome?.result ?? null),
    ts,
    kind: input.kind,
    status: input.status,
    reversible: input.reversible,
    inverseTool: input.inverseTool,
    mitigationTool: input.mitigationTool,
    readTypes: reads.map((r) => r.type),
    readKeys: reads.map((r) => r.key),
    readDisplays: reads.map((r) => r.display ?? displayOf(r.type, r.key)),
    ...applied.params,
    depTypes: deps.map((d) => d.ref.type),
    depKeys: deps.map((d) => d.ref.key),
    depVia: deps.map((d) => d.via),
    undoes: input.undoes ?? null,
  });
  const row = res.rows[0];
  if (!row) throw new Error(`Recording ${input.tool} failed: step ${input.stepId} not found`);

  const action: ActionRecord = {
    id: actionId,
    seq: row.seq,
    tool: input.tool,
    args: input.args,
    result: input.outcome?.result ?? null,
    ts,
    kind: input.kind,
    reversible: input.reversible,
    inverseTool: input.inverseTool,
    mitigationTool: input.mitigationTool,
    status: input.status,
    runId: input.runId,
    stepId: input.stepId,
    agentId: input.agentId,
  };
  return {
    action,
    effects: applied.records.map((e) => ({ ...e, seq: row.seq, ts })),
    reads: reads.map(entityKey),
    dependsOn: row.dependsOn,
    trace: { cypher: res.cypher, ms: res.ms, rows: res.rows.length },
    pendingWrites: applyNow ? [] : writes,
  };
}

/** Apply the held-back writes of a pending action after approval (R4). */
export async function commitPending(
  g: TenantGraph,
  pending: RecordedAction,
): Promise<RecordedAction> {
  const ts = Date.now();
  const applied = await planWrites(g, pending.action.id, pending.pendingWrites);
  const res = await commitAction(g, {
    actionId: pending.action.id,
    result: stableStringify(pending.action.result ?? null),
    ts,
    ...applied.params,
  });
  if (res.rows.length === 0) throw new Error(`Action ${pending.action.id} is no longer pending`);
  return {
    ...pending,
    action: { ...pending.action, status: 'done' },
    effects: applied.records.map((e) => ({ ...e, seq: pending.action.seq, ts })),
    trace: { cypher: res.cypher, ms: res.ms, rows: res.rows.length },
    pendingWrites: [],
  };
}

export function actionRecordedEvent(
  rec: RecordedAction,
): Extract<RunEvent, { type: 'action.recorded' }> {
  return {
    type: 'action.recorded',
    runId: rec.action.runId,
    action: rec.action,
    effects: rec.effects,
    reads: rec.reads,
    dependsOn: rec.dependsOn,
    trace: rec.trace,
  };
}

type WriteParams = {
  effIds: string[];
  effKinds: string[];
  effTypes: string[];
  effKeys: string[];
  effDisplays: string[];
  effFields: Array<string | null>;
  effBefore: string[];
  effAfter: string[];
  effStates: string[];
};

const emptyWrites = (): { params: WriteParams; records: Omit<EffectRecord, 'seq' | 'ts'>[] } => ({
  params: {
    effIds: [],
    effKinds: [],
    effTypes: [],
    effKeys: [],
    effDisplays: [],
    effFields: [],
    effBefore: [],
    effAfter: [],
    effStates: [],
  },
  records: [],
});

/**
 * Compute each effect's resulting entity state from the current world. Several effects on one
 * entity chain (state after effect i feeds effect i+1); the statement sets them in list order,
 * so the last one wins. Effect ids carry the action id and position, so `ORDER BY id` is
 * creation order within an action.
 */
async function planWrites(g: TenantGraph, actionId: string, writes: EffectDraft[]) {
  const out = emptyWrites();
  if (writes.length === 0) return out;
  const current = await getMany(g, dedupeRefs(writes.map((w) => w.entity)));
  const states = new Map<string, State | null>(current.map((e) => [entityKey(e.ref), e.state]));
  const suffix = actionId.replace(/^act_/, '');
  writes.forEach((w, i) => {
    const key = entityKey(w.entity);
    const next = applyEffect(states.get(key) ?? null, w);
    states.set(key, next);
    const id = `eff_${suffix}_${i}`;
    const p = out.params;
    p.effIds.push(id);
    p.effKinds.push(w.kind);
    p.effTypes.push(w.entity.type);
    p.effKeys.push(w.entity.key);
    p.effDisplays.push(w.entity.display ?? displayOf(w.entity.type, w.entity.key));
    p.effFields.push(w.field);
    p.effBefore.push(stableStringify(w.before ?? null));
    p.effAfter.push(stableStringify(w.after ?? null));
    p.effStates.push(stableStringify(next));
    out.records.push({ ...w, id, actionId });
  });
  return out;
}

function dedupeRefs(refs: EntityRef[]): EntityRef[] {
  const seen = new Map<string, EntityRef>();
  for (const r of refs) if (!seen.has(entityKey(r))) seen.set(entityKey(r), r);
  return [...seen.values()];
}
