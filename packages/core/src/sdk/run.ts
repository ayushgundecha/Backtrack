/**
 * `runTool`: the Backtrack wrapper around one tool call, shared by replay and live LLM runs.
 *
 *   run the tool (pure: it only computes result, reads, writes)
 *   → Q5 policies on the entities it would touch: block → record `blocked` + BLOCKED edge
 *   → irreversible, or a confirm policy → record `pending`, Q4 lock-in → ask the human and wait
 *   → otherwise record `done` in one statement
 *
 * Every step emits the same RunEvents in both modes, which is what the panel streams.
 */
import type { RunEvent } from '../contracts/events.js';
import type { TenantGraph } from '../graph/client.js';
import { markBlocked } from '../graph/queries.js';
import { entityKey } from '../world/types.js';
import { checkPolicies, lockInDecision, recordDecision } from './gate.js';
import {
  actionRecordedEvent,
  commitPending,
  finishRun,
  type RecordedAction,
  record,
} from './recorder.js';
import { type AnyToolDefinition, actionFlags } from './registry.js';

export interface RunToolContext {
  g: TenantGraph;
  runId: string;
  stepId: string;
  agentId: string;
  emit: (e: RunEvent) => void | Promise<void>;
  /**
   * Resolve a pending approval: replay waits on the graph (`waitForDecision`), the CLI may
   * auto-approve. Returns true to approve, false to deny.
   */
  awaitApproval: (pending: RecordedAction) => Promise<boolean>;
}

export type RunToolOutcome =
  | { status: 'done'; result: unknown; recorded: RecordedAction }
  | { status: 'blocked'; reason: string; policyId: string; recorded: RecordedAction }
  | { status: 'denied'; reason: string; recorded: RecordedAction };

export async function runTool(
  ctx: RunToolContext,
  def: AnyToolDefinition,
  rawArgs: Record<string, unknown>,
): Promise<RunToolOutcome> {
  const { g, runId, stepId, agentId } = ctx;
  const args = def.input.parse(rawArgs) as Record<string, unknown>;
  const outcome = await def.run({ g, agentId, runId }, args);
  const flags = actionFlags(def);
  const base = { runId, stepId, agentId, tool: def.name, args, kind: 'do' as const, ...flags };
  const touched = [
    ...outcome.reads.map(entityKey),
    ...outcome.writes.map((w) => entityKey(w.entity)),
  ];

  const policy = await checkPolicies(g, {
    tool: def.name,
    agentId,
    entities: touched,
    reversible: flags.reversible,
  });
  if (policy.decision.decision === 'denied' && policy.decision.policyId) {
    // The tool computed what it would do, but nothing is applied: only its reads are recorded.
    const recorded = await record(g, {
      ...base,
      status: 'blocked',
      outcome: { result: null, reads: outcome.reads, writes: [] },
    });
    await markBlocked(g, {
      policyId: policy.decision.policyId,
      actionId: recorded.action.id,
      ts: Date.now(),
    });
    await ctx.emit(actionRecordedEvent(recorded));
    await ctx.emit({
      type: 'action.blocked',
      runId,
      actionId: recorded.action.id,
      tool: def.name,
      policyId: policy.decision.policyId,
      rule: policy.decision.reason.replace(/^Blocked by policy: /, ''),
    });
    return {
      status: 'blocked',
      reason: policy.decision.reason,
      policyId: policy.decision.policyId,
      recorded,
    };
  }

  const needsGate = !flags.reversible || policy.decision.decision === 'user-approval';
  if (!needsGate) {
    const recorded = await record(g, { ...base, status: 'done', outcome });
    await ctx.emit(actionRecordedEvent(recorded));
    return { status: 'done', result: outcome.result, recorded };
  }

  const pending = await record(g, { ...base, status: 'pending', outcome });
  const verdict =
    policy.decision.decision === 'user-approval'
      ? policy.decision
      : (await lockInDecision(g, pending.action.id, def.name)).decision;

  if (verdict.decision === 'user-approval') {
    await finishRun(g, runId, 'paused', pending.action.id);
    await ctx.emit({
      type: 'approval.requested',
      runId,
      actionId: pending.action.id,
      tool: def.name,
      args,
      reason: verdict.reason,
      wouldLock: verdict.wouldLock,
      lockedTools: verdict.lockedTools,
    });
    const approved = await ctx.awaitApproval(pending);
    // The decision may already be recorded by /api/approval; recording again is a no-op then.
    await recordDecision(g, { actionId: pending.action.id, approved });
    await finishRun(g, runId, 'running');
    await ctx.emit({
      type: 'approval.resolved',
      runId,
      actionId: pending.action.id,
      approved,
      by: 'ayush',
    });
    if (!approved) {
      const denied = { ...pending, action: { ...pending.action, status: 'denied' as const } };
      await ctx.emit(actionRecordedEvent(denied));
      return {
        status: 'denied',
        reason: 'Denied by a human in the approval card',
        recorded: denied,
      };
    }
  }

  const recorded = await commitPending(g, pending);
  await ctx.emit(actionRecordedEvent(recorded));
  return { status: 'done', result: outcome.result, recorded };
}
