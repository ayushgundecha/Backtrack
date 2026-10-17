/**
 * Backtrack core contracts (frozen after the foundations milestone).
 * Every package (core, mcp-server, web) imports these; nothing redefines them.
 */
import { z } from 'zod';

// ---------- World / entities ----------

/** A thing in the world an action can read or change, e.g. { type: 'order', key: 'ord_1001' }. */
export const EntityRef = z.object({
  type: z.string().min(1),
  key: z.string().min(1),
  display: z.string().optional(),
});
export type EntityRef = z.infer<typeof EntityRef>;

export const EffectKind = z.enum(['create', 'update', 'delete', 'external']);
export type EffectKind = z.infer<typeof EffectKind>;

/** One concrete change an action made. `before` is null for creates; `after` is null for deletes. */
export const EffectDraft = z.object({
  kind: EffectKind,
  entity: EntityRef,
  field: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});
export type EffectDraft = z.infer<typeof EffectDraft>;

/** What every tool implementation returns: the result plus what it actually read and wrote. */
export const ToolResult = z.object({
  result: z.unknown(),
  reads: z.array(EntityRef),
  writes: z.array(EffectDraft),
});
export type ToolResult = z.infer<typeof ToolResult>;

// ---------- Actions / runs ----------

export const ActionKind = z.enum(['do', 'undo', 'mitigation']);
export type ActionKind = z.infer<typeof ActionKind>;

export const ActionStatus = z.enum(['pending', 'done', 'undone', 'blocked', 'denied']);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const RunKind = z.enum(['agent', 'undo']);
export const RunStatus = z.enum(['running', 'paused', 'done', 'failed', 'undone']);
export const RunMode = z.enum(['replay', 'llm']);
export type RunMode = z.infer<typeof RunMode>;

export const AgentId = z.enum(['ops-agent', 'billing-agent']);
export type AgentId = z.infer<typeof AgentId>;

/** One recorded tool call. `seq` is the global monotonic order within a tenant graph. */
export const ActionRecord = z.object({
  id: z.string(),
  seq: z.number().int(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown().nullable(),
  ts: z.number(),
  kind: ActionKind,
  reversible: z.boolean(),
  inverseTool: z.string().nullable(),
  mitigationTool: z.string().nullable(),
  status: ActionStatus,
  runId: z.string(),
  stepId: z.string(),
  agentId: z.string(),
});
export type ActionRecord = z.infer<typeof ActionRecord>;

export const EffectRecord = EffectDraft.extend({
  id: z.string(),
  actionId: z.string(),
  seq: z.number().int(),
  ts: z.number(),
});
export type EffectRecord = z.infer<typeof EffectRecord>;

// ---------- Undo ----------

export const UndoStepMode = z.enum(['restore', 'inverse', 'mitigation', 'conflict', 'skip']);
export type UndoStepMode = z.infer<typeof UndoStepMode>;

export const UndoStep = z.object({
  order: z.number().int(),
  actionId: z.string(),
  tool: z.string(),
  seq: z.number().int(),
  agentId: z.string(),
  mode: UndoStepMode,
  /** Human-readable, evidence-backed line, e.g. "cancel_event evt_1 (schedule_followup)". */
  label: z.string(),
  entity: EntityRef.nullable(),
  hops: z.number().int(),
  via: z.array(z.string()),
});
export type UndoStep = z.infer<typeof UndoStep>;

export const CrossAgentDependent = z.object({
  agentId: z.string(),
  actionId: z.string(),
  tool: z.string(),
  hops: z.number().int(),
});

export const BlastRadius = z.object({
  actions: z.number().int(),
  irreversible: z.number().int(),
  entities: z.array(z.string()),
  depth: z.number().int(),
});
export type BlastRadius = z.infer<typeof BlastRadius>;

export const UndoPlanStatus = z.enum([
  'proposed',
  'rehearsed',
  'executing',
  'executed',
  'partial',
  'conflict',
]);

export const UndoPlan = z.object({
  id: z.string(),
  rootActionId: z.string(),
  depth: z.number().int(),
  status: UndoPlanStatus,
  steps: z.array(UndoStep),
  blast: BlastRadius,
  crossAgent: z.array(CrossAgentDependent),
  summary: z.string(),
  ts: z.number(),
});
export type UndoPlan = z.infer<typeof UndoPlan>;

/** The four honest outcomes of an undo request. */
export const UndoOutcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), plan: UndoPlan }),
  z.object({
    kind: z.literal('memory'),
    actionId: z.string(),
    priorPlans: z.array(
      z.object({ id: z.string(), ts: z.number(), status: UndoPlanStatus, summary: z.string() }),
    ),
  }),
  z.object({ kind: z.literal('none'), actionId: z.string(), reason: z.string() }),
  z.object({
    kind: z.literal('unknown'),
    query: z.string(),
    candidates: z.array(
      z.object({ id: z.string(), tool: z.string(), seq: z.number().int(), label: z.string() }),
    ),
  }),
]);
export type UndoOutcome = z.infer<typeof UndoOutcome>;

export const RehearsalDiff = z.object({
  planId: z.string(),
  changes: z.array(
    z.object({
      entity: EntityRef,
      field: z.string().nullable(),
      from: z.unknown(),
      to: z.unknown(),
    }),
  ),
  forkGraph: z.string(),
});
export type RehearsalDiff = z.infer<typeof RehearsalDiff>;

// ---------- Gate / policies ----------

export const GateDecision = z.object({
  decision: z.enum(['approved', 'user-approval', 'denied']),
  reason: z.string(),
  wouldLock: z.number().int(),
  lockedTools: z.array(z.string()),
  policyId: z.string().nullable(),
});
export type GateDecision = z.infer<typeof GateDecision>;

export const PolicyKind = z.enum(['block', 'confirm', 'warn']);
export const Policy = z.object({
  id: z.string(),
  rule: z.string(),
  kind: PolicyKind,
  tool: z.string().nullable(),
  agentId: z.string().nullable(),
  entity: EntityRef.nullable(),
  createdFromPlanId: z.string().nullable(),
  ts: z.number(),
});
export type Policy = z.infer<typeof Policy>;

// ---------- Query results / trace ----------

/** Every graph read returns its evidence so the UI can show the Cypher behind every claim. */
export interface QueryResult<T> {
  rows: T[];
  cypher: string;
  params: Record<string, unknown>;
  ms: number;
}

export const Trace = z.object({
  cypher: z.string(),
  params: z.record(z.string(), z.unknown()),
  ms: z.number(),
  rows: z.number().int(),
});
export type Trace = z.infer<typeof Trace>;

// ---------- Snapshots for the UI ----------

export const GraphNode = z.object({
  id: z.string(),
  label: z.enum(['Action', 'Entity', 'Agent', 'Run', 'UndoPlan', 'Policy', 'User']),
  title: z.string(),
  status: z.string().optional(),
  tool: z.string().optional(),
  kind: z.string().optional(),
  seq: z.number().int().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  reversible: z.boolean().optional(),
});
export const GraphLink = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum([
    'RAN',
    'HAS',
    'NEXT',
    'DID',
    'CAUSED',
    'ON',
    'READ',
    'DEPENDS_ON',
    'UNDOES',
    'ROOT',
    'REVERTS',
    'COULD_NOT_REVERT',
    'CONFLICT',
    'APPROVED',
    'DENIED',
    'REQUESTED',
    'SET',
    'ON_TOOL',
    'APPLIES_TO',
    'BLOCKED',
  ]),
  order: z.number().int().optional(),
});
export const GraphSnapshot = z.object({ nodes: z.array(GraphNode), links: z.array(GraphLink) });
export type GraphSnapshot = z.infer<typeof GraphSnapshot>;

export const WorldEntity = z.object({
  type: z.string(),
  key: z.string(),
  display: z.string(),
  state: z.record(z.string(), z.unknown()),
});
export const WorldSnapshot = z.object({
  tenant: z.string(),
  asOfSeq: z.number().int().nullable(),
  entities: z.array(WorldEntity),
});
export type WorldSnapshot = z.infer<typeof WorldSnapshot>;

export const ExplainEvidence = z.object({
  entity: z.string(),
  saw: z.unknown(),
  writtenBy: z.string().nullable(),
  writtenAtSeq: z.number().int().nullable(),
});
export const Explain = z.object({
  action: ActionRecord,
  thought: z.string().nullable(),
  reads: z.array(ExplainEvidence),
  effects: z.array(EffectRecord),
  dependsOn: z.array(z.object({ actionId: z.string(), tool: z.string(), seq: z.number().int() })),
  dependedOnBy: z.array(
    z.object({ actionId: z.string(), tool: z.string(), seq: z.number().int() }),
  ),
  trace: Trace,
});
export type Explain = z.infer<typeof Explain>;
