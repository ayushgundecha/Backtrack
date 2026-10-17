/**
 * Replay mode: a golden fixture drives the run instead of a model, through exactly the code path
 * a live run uses (runTool: policies, gate, recorder). Only the choice of tool and arguments is
 * scripted; the graph, the gate's decision and every undo plan are computed live.
 */
import type { RunEvent } from '../contracts/events.js';
import type { RunFixture } from '../contracts/fixtures.js';
import type { TenantGraph } from '../graph/client.js';
import { waitForDecision } from '../sdk/gate.js';
import { finishRun, type RecordedAction, startRun, startStep } from '../sdk/recorder.js';
import type { ToolRegistry } from '../sdk/registry.js';
import { runTool } from '../sdk/run.js';

export const REPLAY_PACE_MS = 400;

export interface ReplayOptions {
  registry: ToolRegistry;
  emit: (e: RunEvent) => void | Promise<void>;
  /** Delay between steps so the graph visibly grows (400 ms in the panel, 0 in tests). */
  paceMs?: number;
  /** How a gated call gets its answer; by default, wait for a decision written to the graph. */
  awaitApproval?: (pending: RecordedAction) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface ReplayResult {
  runId: string;
  status: 'done' | 'failed';
  /** Recorded actions in order, by step index (blocked and denied included). */
  actions: RecordedAction[];
}

export async function replayRun(
  g: TenantGraph,
  fixture: RunFixture,
  opts: ReplayOptions,
): Promise<ReplayResult> {
  const pace = () => new Promise((r) => setTimeout(r, opts.paceMs ?? REPLAY_PACE_MS));
  const awaitApproval =
    opts.awaitApproval ??
    (async (pending: RecordedAction) =>
      (await waitForDecision(g, pending.action.id, { signal: opts.signal }))?.approved ?? false);

  const { runId, event } = await startRun(g, {
    agentId: fixture.agentId,
    kind: 'agent',
    goal: fixture.goal,
    mode: 'replay',
  });
  await opts.emit(event);
  const results: unknown[] = [];
  const actions: RecordedAction[] = [];

  try {
    for (const [index, step] of fixture.steps.entries()) {
      if (opts.signal?.aborted) throw new Error('Run cancelled');
      const { stepId, event: stepEvent } = await startStep(g, {
        runId,
        index,
        thought: step.thought,
      });
      await opts.emit(stepEvent);
      const args = resolveArgs(step.args, results);
      const outcome = await runTool(
        { g, runId, stepId, agentId: fixture.agentId, emit: opts.emit, awaitApproval },
        opts.registry.get(step.tool),
        args,
      );
      actions.push(outcome.recorded);
      results.push(outcome.status === 'done' ? outcome.result : undefined);
      await pace();
    }
    await finishRun(g, runId, 'done');
    await opts.emit({ type: 'run.finished', runId, status: 'done', ts: Date.now() });
    return { runId, status: 'done', actions };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(g, runId, 'failed');
    await opts.emit({ type: 'error', runId, message });
    await opts.emit({ type: 'run.finished', runId, status: 'failed', ts: Date.now() });
    return { runId, status: 'failed', actions };
  }
}

type ArgValue = RunFixture['steps'][number]['args'][string];

/**
 * Resolve `{ "$ref": "steps.2.result.announcement" }` against earlier step results. A reference
 * to a step that was blocked or denied has no result, and fails the run with a clear message.
 */
export function resolveArgs(
  args: Record<string, ArgValue>,
  results: unknown[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => {
      if (value === null || typeof value !== 'object') return [name, value];
      const [head, index, field, ...path] = value.$ref.split('.');
      if (head !== 'steps' || index === undefined || field !== 'result') {
        throw new Error(`Bad $ref ${value.$ref}: expected steps.<n>.result.<path>`);
      }
      let cur: unknown = results[Number(index)];
      if (cur === undefined) {
        throw new Error(
          `${name}: step ${index} has no result (it did not run), so ${value.$ref} is unavailable`,
        );
      }
      for (const key of path) {
        cur = (cur as Record<string, unknown> | undefined)?.[key];
      }
      if (cur === undefined) throw new Error(`${name}: ${value.$ref} resolved to nothing`);
      return [name, cur];
    }),
  );
}
