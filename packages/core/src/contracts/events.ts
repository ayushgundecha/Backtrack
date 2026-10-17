/** Events streamed (SSE) while an agent run or an undo executes. Both replay and LLM modes emit exactly these. */
import { z } from 'zod';
import { ActionRecord, EffectRecord, RunMode, UndoStepMode } from './types.js';

export const RunEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    runId: z.string(),
    agentId: z.string(),
    mode: RunMode,
    goal: z.string(),
    model: z.string().nullable(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('step'),
    runId: z.string(),
    stepId: z.string(),
    index: z.number().int(),
    thought: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('action.recorded'),
    runId: z.string(),
    action: ActionRecord,
    effects: z.array(EffectRecord),
    reads: z.array(z.string()),
    dependsOn: z.array(z.string()),
    trace: z.object({ cypher: z.string(), ms: z.number(), rows: z.number().int() }),
  }),
  z.object({
    type: z.literal('approval.requested'),
    runId: z.string(),
    actionId: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    reason: z.string(),
    wouldLock: z.number().int(),
    lockedTools: z.array(z.string()),
  }),
  z.object({
    type: z.literal('approval.resolved'),
    runId: z.string(),
    actionId: z.string(),
    approved: z.boolean(),
    by: z.string(),
  }),
  z.object({
    type: z.literal('action.blocked'),
    runId: z.string(),
    actionId: z.string(),
    tool: z.string(),
    policyId: z.string(),
    rule: z.string(),
  }),
  z.object({
    type: z.literal('undo.step'),
    planId: z.string(),
    order: z.number().int(),
    actionId: z.string(),
    mode: UndoStepMode,
    status: z.enum(['started', 'done', 'conflict', 'skipped']),
    label: z.string(),
    entity: z.string().nullable(),
  }),
  z.object({
    type: z.literal('undo.finished'),
    planId: z.string(),
    status: z.enum(['executed', 'partial', 'conflict']),
  }),
  z.object({
    type: z.literal('run.finished'),
    runId: z.string(),
    status: z.enum(['done', 'paused', 'failed']),
    ts: z.number(),
  }),
  z.object({ type: z.literal('error'), runId: z.string().nullable(), message: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
