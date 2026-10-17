/**
 * Calls real tools the way the agent loop will: validate the input with the tool's zod schema,
 * run it, and record the outcome. Compensations are recorded as `undo` / `mitigation` actions of
 * the original they revert.
 */
import { createToolRegistry } from '../src/agents/tools.js';
import type { ActionKind, ToolResult } from '../src/contracts/types.js';
import type { TenantGraph } from '../src/graph/client.js';
import { type RecordedAction, record, startRun, startStep } from '../src/sdk/recorder.js';
import { actionFlags } from '../src/sdk/registry.js';

export const registry = createToolRegistry();

export interface Called {
  out: ToolResult & { result: Record<string, unknown> };
  rec: RecordedAction;
}

export async function newRun(g: TenantGraph, agentId: 'ops-agent' | 'billing-agent') {
  const { runId } = await startRun(g, { agentId, kind: 'agent', goal: 'test', mode: 'replay' });
  let index = 0;
  return async (
    tool: string,
    args: Record<string, unknown>,
    compensates?: { kind: Exclude<ActionKind, 'do'>; undoes: string },
  ): Promise<Called> => {
    const def = registry.get(tool);
    const { stepId } = await startStep(g, { runId, index: index++, thought: `call ${tool}` });
    const out = (await def.run({ g, agentId, runId }, def.input.parse(args))) as Called['out'];
    const rec = await record(g, {
      runId,
      stepId,
      agentId,
      tool,
      args,
      kind: compensates?.kind ?? 'do',
      status: 'done',
      ...actionFlags(def),
      outcome: out,
      undoes: compensates?.undoes ?? null,
    });
    return { out, rec };
  };
}

/** `type:key` of each ref, for compact assertions on reads. */
export const keys = (refs: Array<{ type: string; key: string }>): string[] =>
  refs.map((r) => `${r.type}:${r.key}`);
