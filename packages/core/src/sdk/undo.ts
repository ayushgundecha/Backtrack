/**
 * The undo engine: plan (four honest outcomes) and execute.
 *
 * Planning is reachability: Q1 finds what depends on the action up to a depth, Q2 orders it
 * (seq DESC is a reverse topological order, invariant 1), Q3 sizes it, Q7 names other agents.
 * Execution is its own Run: per step, Q14 checks the entity is still as the action left it, then
 * the inverse restores `before` (or the mitigation compensates an external effect), and the
 * compensating action is recorded with UNDOES. Nothing is executed without a persisted plan.
 */
import type { RunEvent } from '../contracts/events.js';
import type {
  EntityRef,
  UndoOutcome,
  UndoPlan,
  UndoStep,
  UndoStepMode,
} from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { parseJson } from '../graph/cypher.js';
import {
  type ActionRow,
  compensations,
  createPlan,
  getActions,
  getPlan,
  markConflict,
  q1Downstream,
  q2UndoOrder,
  q3BlastRadius,
  q7CrossAgent,
  q13Recall,
  q14Conflicts,
  setPlanStatus,
} from '../graph/queries.js';
import { displayOf } from '../world/types.js';
import { judgeConflict, restoreBefore } from './inverse.js';
import { finishRun, newId, record, startRun, startStep } from './recorder.js';
import { actionFlags, type ToolRegistry } from './registry.js';
import { type Candidate, resolveAction } from './resolve.js';
import { type Trace, traceOf } from './trace.js';

export const BACKTRACK_AGENT = 'backtrack';

export interface PlanRequest {
  actionId?: string | null;
  text?: string | null;
  depth?: number;
  userId?: string;
}

export interface PlanResult {
  outcome: UndoOutcome;
  traces: Trace[];
}

/** How an undo step for this action is carried out, from its tool definition when known. */
function stepMode(
  action: { reversible: boolean; tool: string },
  registry?: ToolRegistry,
): UndoStepMode {
  if (!action.reversible) return 'mitigation';
  const def = registry?.has(action.tool) ? registry.get(action.tool) : null;
  return def?.effect === 'reversible' ? def.undoMode : 'inverse';
}

export async function planUndo(
  g: TenantGraph,
  req: PlanRequest,
  opts: { registry?: ToolRegistry } = {},
): Promise<PlanResult> {
  const depth = req.depth ?? 5;
  const resolution = await resolveAction(g, req);
  const traces: Trace[] = [resolution.trace];
  const root = resolution.action;

  if (!root) {
    return {
      outcome: {
        kind: 'unknown',
        query: req.text ?? req.actionId ?? '',
        candidates: resolution.candidates as Candidate[],
      },
      traces,
    };
  }

  if (root.kind !== 'do') {
    return {
      outcome: {
        kind: 'none',
        actionId: root.id,
        reason: `${root.tool} (seq ${root.seq}) is itself a ${root.kind} action; undoing an undo is refused (traversals only follow original actions)`,
      },
      traces,
    };
  }

  if (root.status === 'undone') {
    const recall = await q13Recall(g, { actionId: root.id, tool: null, type: null, key: null });
    traces.push(traceOf('Q13', recall));
    return {
      outcome: {
        kind: 'memory',
        actionId: root.id,
        priorPlans: recall.rows
          .filter((r) => r.kind === 'plan')
          .sort((a, b) => b.ts - a.ts)
          .map((r) => ({
            id: r.id,
            ts: r.ts,
            status: r.status as UndoPlan['status'],
            summary: r.summary,
          })),
      },
      traces,
    };
  }

  if (root.status !== 'done') {
    return {
      outcome: {
        kind: 'none',
        actionId: root.id,
        reason: `${root.tool} (seq ${root.seq}) is ${root.status}; it never changed the world`,
      },
      traces,
    };
  }

  const closure = await q1Downstream(g, { actionId: root.id }, { depth });
  traces.push(traceOf('Q1', closure));
  const order = await q2UndoOrder(g, { actionIds: [root.id, ...closure.rows.map((r) => r.id)] });
  traces.push(traceOf('Q2', order));
  const rootRow = order.rows.find((r) => r.id === root.id);
  if (!rootRow || rootRow.entities.length === 0) {
    return {
      outcome: {
        kind: 'none',
        actionId: root.id,
        reason: `${root.tool} (seq ${root.seq}) only read; it changed nothing, so there is nothing to undo`,
      },
      traces,
    };
  }

  const blast = await q3BlastRadius(g, { actionId: root.id }, { depth });
  traces.push(traceOf('Q3', blast));
  const cross = await q7CrossAgent(g, { actionId: root.id }, { depth });
  traces.push(traceOf('Q7', cross));

  const hopsOf = new Map(closure.rows.map((r) => [r.id, r]));
  const agents = new Map(closure.rows.map((r) => [r.id, r.agentId]));
  agents.set(root.id, root.agentId);
  const steps: UndoStep[] = order.rows.map((row, i) => {
    const mode = stepMode(row, opts.registry);
    const primary =
      row.entities.find((e) => e.kind === 'create' || e.kind === 'external') ??
      row.entities[0] ??
      null;
    const entity: EntityRef | null = primary
      ? {
          type: primary.type,
          key: primary.key,
          display: primary.display ?? displayOf(primary.type, primary.key),
        }
      : null;
    const verb =
      mode === 'mitigation' ? row.mitigationTool : (row.inverseTool ?? `revert_${row.tool}`);
    const hit = hopsOf.get(row.id);
    return {
      order: i + 1,
      actionId: row.id,
      tool: row.tool,
      seq: row.seq,
      agentId: agents.get(row.id) ?? root.agentId,
      mode,
      label: `${verb}${entity ? ` ${entity.key}` : ''} (${row.tool})`,
      entity,
      hops: hit?.hops ?? 0,
      via: hit?.via ?? [row.tool],
    };
  });

  const b = blast.rows[0] ?? { actions: steps.length, irreversible: 0, entities: [] };
  const plan: UndoPlan = {
    id: newId('plan'),
    rootActionId: root.id,
    depth,
    status: 'proposed',
    steps,
    blast: { actions: b.actions, irreversible: b.irreversible, entities: b.entities, depth },
    crossAgent: cross.rows,
    summary: summarise(root, steps, cross.rows, depth),
    ts: Date.now(),
  };
  const saved = await createPlan(g, {
    planId: plan.id,
    rootId: root.id,
    userId: req.userId ?? 'ayush',
    ts: plan.ts,
    depth,
    summary: plan.summary,
    stepIds: steps.map((s) => s.actionId),
    stepModes: steps.map((s) => s.mode),
    stepLabels: steps.map((s) => s.label),
    stepHops: steps.map((s) => s.hops),
    stepVia: steps.map((s) => JSON.stringify(s.via)),
    stepEntities: steps.map((s) => (s.entity ? `${s.entity.type}:${s.entity.key}` : null)),
    stepMitigations: order.rows.map((r) => (r.reversible ? null : r.mitigationTool)),
  });
  traces.push(traceOf('P1', saved));
  return { outcome: { kind: 'plan', plan }, traces };
}

/** The plan sentence, built only from rows (the model may rephrase it; validateSummary checks). */
export function summarise(
  root: Pick<ActionRow, 'tool' | 'seq'>,
  steps: UndoStep[],
  cross: Array<{ agentId: string; tool: string; hops: number }>,
  depth: number,
): string {
  const mitigated = steps.filter((s) => s.mode === 'mitigation');
  const parts = [
    `Undo ${root.tool} (seq ${root.seq}) at depth ${depth}: ${steps.length} step${steps.length === 1 ? '' : 's'} in reverse dependency order`,
  ];
  if (mitigated.length) {
    parts.push(
      `${mitigated.length} irreversible (${mitigated.map((s) => s.tool).join(', ')}) gets a mitigation instead`,
    );
  }
  if (cross.length) {
    parts.push(`affects ${cross.map((c) => `${c.agentId} ${c.tool} (${c.hops} hops)`).join(', ')}`);
  }
  return `${parts.join('; ')}.`;
}

/** Rebuild an UndoPlan from the graph (P2), e.g. for GET /api/plan or before executing. */
export async function loadPlan(g: TenantGraph, planId: string): Promise<UndoPlan | null> {
  const { rows } = await getPlan(g, { planId });
  const p = rows[0];
  if (!p) return null;
  const blastEntities = [...new Set(p.steps.flatMap((s) => (s.entity ? [s.entity] : [])))];
  const steps: UndoStep[] = p.steps.map((s) => {
    const [type, key] = s.entity?.split(':') ?? [];
    return {
      order: s.order,
      actionId: s.actionId,
      tool: s.tool,
      seq: s.seq,
      agentId: s.agentId,
      mode: s.mode as UndoStepMode,
      label: s.label,
      entity: type && key ? { type, key, display: displayOf(type, key) } : null,
      hops: s.hops,
      via: parseJson<string[]>(s.via) ?? [],
    };
  });
  const rootAgent = steps.find((s) => s.actionId === p.rootId)?.agentId;
  return {
    id: p.id,
    rootActionId: p.rootId,
    depth: p.depth,
    status: p.status as UndoPlan['status'],
    steps,
    blast: {
      actions: steps.length,
      irreversible: steps.filter((s) => s.mode === 'mitigation').length,
      entities: blastEntities,
      depth: p.depth,
    },
    crossAgent: steps
      .filter((s) => s.agentId !== rootAgent)
      .map((s) => ({ agentId: s.agentId, actionId: s.actionId, tool: s.tool, hops: s.hops })),
    summary: p.summary,
    ts: p.ts,
  };
}

type UndoEvent = Extract<RunEvent, { type: 'undo.step' | 'undo.finished' }>;

export interface ExecuteOptions {
  registry?: ToolRegistry;
  /** Delay between steps so an audience can follow (the UI uses ~500 ms; tests use 0). */
  paceMs?: number;
  onEvent?: (e: UndoEvent) => void | Promise<void>;
}

export interface ExecuteResult {
  planId: string;
  status: 'executed' | 'partial' | 'conflict';
  runId: string | null;
  events: UndoEvent[];
}

export async function executeUndo(
  g: TenantGraph,
  planId: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const plan = await loadPlan(g, planId);
  if (!plan) throw new Error(`Unknown plan ${planId}`);
  const events: UndoEvent[] = [];
  const emit = async (e: UndoEvent) => {
    events.push(e);
    await opts.onEvent?.(e);
  };
  const pace = () => new Promise((r) => setTimeout(r, opts.paceMs ?? 0));
  const step = (s: UndoStep, status: 'started' | 'done' | 'conflict' | 'skipped'): UndoEvent => ({
    type: 'undo.step',
    planId,
    order: s.order,
    actionId: s.actionId,
    mode: s.mode,
    status,
    label: s.label,
    entity: s.entity ? `${s.entity.type}:${s.entity.key}` : null,
  });

  // Re-running a finished plan is a no-op: every step reports skipped.
  if (plan.status === 'executed') {
    for (const s of plan.steps) await emit(step(s, 'skipped'));
    const finished: UndoEvent = { type: 'undo.finished', planId, status: 'executed' };
    await emit(finished);
    return { planId, status: 'executed', runId: null, events };
  }

  const { runId } = await startRun(g, {
    agentId: BACKTRACK_AGENT,
    kind: 'undo',
    goal: plan.summary,
    mode: 'replay',
  });
  await setPlanStatus(g, { planId, status: 'executing' });

  const current = await getActions(g, { ids: plan.steps.map((s) => s.actionId) });
  const statusOf = new Map(current.rows.map((r) => [r.id, r]));
  let done = 0;
  let conflicts = 0;

  for (const s of plan.steps) {
    await emit(step(s, 'started'));
    const original = statusOf.get(s.actionId);
    const already = await alreadyCompensated(g, s.actionId);
    if (!original || original.status === 'undone' || already) {
      await emit(step(s, 'skipped'));
      await pace();
      continue;
    }
    const { stepId } = await startStep(g, { runId, index: s.order - 1, thought: s.label });

    if (s.mode === 'mitigation') {
      const name = original.mitigationTool;
      if (!name || !opts.registry?.has(name)) throw new Error(`No mitigation tool for ${s.tool}`);
      const def = opts.registry.get(name);
      const outcome = await def.run(
        { g, agentId: BACKTRACK_AGENT, runId },
        { actionId: s.actionId },
      );
      await record(g, {
        runId,
        stepId,
        agentId: BACKTRACK_AGENT,
        tool: name,
        args: { actionId: s.actionId },
        kind: 'mitigation',
        status: 'done',
        ...actionFlags(def),
        outcome,
        undoes: s.actionId,
      });
      done += 1;
      await emit(step(s, 'done'));
      await pace();
      continue;
    }

    const check = await q14Conflicts(g, { actionId: s.actionId });
    const dirty = check.rows.map(judgeConflict).find((v) => !v.clean);
    if (dirty) {
      await markConflict(g, { planId, actionId: s.actionId, reason: dirty.reason ?? 'conflict' });
      conflicts += 1;
      await emit(step(s, 'conflict'));
      await pace();
      continue;
    }

    const inverseName = original.inverseTool ?? `revert_${s.tool}`;
    const inverse = opts.registry?.has(inverseName) ? opts.registry.get(inverseName) : null;
    const outcome = inverse
      ? await inverse.run({ g, agentId: BACKTRACK_AGENT, runId }, { actionId: s.actionId })
      : await restoreBefore(g, s.actionId);
    await record(g, {
      runId,
      stepId,
      agentId: BACKTRACK_AGENT,
      tool: inverseName,
      args: { actionId: s.actionId },
      kind: 'undo',
      status: 'done',
      reversible: true,
      inverseTool: null,
      mitigationTool: null,
      outcome,
      undoes: s.actionId,
    });
    done += 1;
    await emit(step(s, 'done'));
    await pace();
  }

  const status: ExecuteResult['status'] =
    conflicts === 0 ? 'executed' : done === 0 ? 'conflict' : 'partial';
  await setPlanStatus(g, { planId, status });
  await finishRun(g, runId, 'done');
  await emit({ type: 'undo.finished', planId, status });
  return { planId, status, runId, events };
}

/** True when a mitigation or undo action already points at this original (UNDOES). */
async function alreadyCompensated(g: TenantGraph, actionId: string): Promise<boolean> {
  const { rows } = await compensations(g, { actionId });
  return (rows[0]?.n ?? 0) > 0;
}
