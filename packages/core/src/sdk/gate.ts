/**
 * The gate: a graph query decides whether an agent may act, must ask, or is stopped.
 *
 * Why a query and not a rule like "always ask before emails": what makes an irreversible action
 * dangerous is what it would lock in. Q4 walks upstream from the pending action and counts the
 * reversible changes it builds on; with none, there is nothing to protect and the agent proceeds.
 * Policies (Q5) are checked first, because a human's "never again" outranks everything.
 */
import type { GateDecision } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { approvalState, decideAction, q4LockIn, q5Policies } from '../graph/queries.js';
import type { Trace } from './trace.js';
import { traceOf } from './trace.js';

export interface GateInput {
  tool: string;
  agentId: string;
  /** Entities the call would touch (`type:key`), for entity-scoped policies. */
  entities: string[];
  reversible: boolean;
}

export interface PolicyVerdict {
  decision: GateDecision;
  traces: Trace[];
}

/** Q5 only: is the call blocked, or does a policy ask for confirmation? */
export async function checkPolicies(g: TenantGraph, input: GateInput): Promise<PolicyVerdict> {
  const res = await q5Policies(g, {
    tool: input.tool,
    agentId: input.agentId,
    entities: input.entities,
  });
  const top = res.rows[0];
  const traces = [traceOf('Q5', res)];
  if (top?.kind === 'block') {
    return {
      decision: decision('denied', `Blocked by policy: ${top.rule}`, [], top.id),
      traces,
    };
  }
  if (top?.kind === 'confirm') {
    return {
      decision: decision(
        'user-approval',
        `A policy asks for confirmation: ${top.rule}`,
        [],
        top.id,
      ),
      traces,
    };
  }
  const warn = top?.kind === 'warn' ? ` (policy warning: ${top.rule})` : '';
  return { decision: decision('approved', `No policy applies${warn}`, [], null), traces };
}

/**
 * Q4 on a recorded pending action: which reversible changes would it lock in? The reason text is
 * built from the rows, so the sentence on screen is exactly what the graph returned.
 */
export async function lockInDecision(
  g: TenantGraph,
  pendingActionId: string,
  tool: string,
): Promise<PolicyVerdict> {
  const res = await q4LockIn(g, { actionId: pendingActionId });
  const tools = res.rows.map((r) => r.tool);
  const traces = [traceOf('Q4', res)];
  if (tools.length === 0) {
    return {
      decision: decision('approved', `${tool} builds on no reversible changes`, [], null),
      traces,
    };
  }
  const noun = tools.length === 1 ? 'change' : 'changes';
  return {
    decision: decision(
      'user-approval',
      `would lock in ${tools.length} reversible ${noun}: ${tools.join(', ')}`,
      tools,
      null,
    ),
    traces,
  };
}

/** Record a human's decision on a pending action: (User)-[:APPROVED|DENIED]->(Action). */
export async function recordDecision(
  g: TenantGraph,
  input: { actionId: string; approved: boolean; userId?: string; reason?: string },
): Promise<{ status: string } | null> {
  const { rows } = await decideAction(g, {
    actionId: input.actionId,
    userId: input.userId ?? 'ayush',
    approved: input.approved,
    reason: input.reason ?? (input.approved ? 'approved in the panel' : 'denied in the panel'),
    ts: Date.now(),
  });
  return rows[0] ?? null;
}

export type Decision = { approved: boolean; by: string | null } | null;

/** The current decision on a pending action, or null while nobody has decided. */
export async function readDecision(g: TenantGraph, actionId: string): Promise<Decision> {
  const { rows } = await approvalState(g, { actionId });
  const row = rows[0];
  if (!row?.decision) return null;
  return { approved: row.decision === 'APPROVED', by: row.by };
}

/**
 * Wait until a human decides. Polls the graph rather than holding state in memory: the approval
 * arrives through another HTTP request (another serverless invocation) that only shares the graph.
 */
export async function waitForDecision(
  g: TenantGraph,
  actionId: string,
  opts: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Decision> {
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  while (Date.now() < deadline && !opts.signal?.aborted) {
    const d = await readDecision(g, actionId);
    if (d) return d;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

function decision(
  d: GateDecision['decision'],
  reason: string,
  lockedTools: string[],
  policyId: string | null,
): GateDecision {
  return { decision: d, reason, wouldLock: lockedTools.length, lockedTools, policyId };
}
