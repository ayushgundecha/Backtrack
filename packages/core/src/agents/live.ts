/**
 * Live mode: a model chooses the tools, through exactly the code path replay uses.
 *
 * Every world tool call goes through `runTool` (policies, gate, recorder), so a live run writes
 * the same graph and emits the same RunEvents as a replay. Why the gate sits inside the tool
 * call rather than in the AI SDK's `toolApproval` round-trip: the decision arrives through
 * /api/approval and is read back from the graph within the same streamed request, so there is
 * one gate and one event stream for both modes. The model sees a blocked or denied call as the
 * tool's result, with the reason, and carries on.
 */
import { type LanguageModel, type ModelMessage, ToolLoopAgent, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { RunEvent } from '../contracts/events.js';
import type { AgentId } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { stableStringify } from '../graph/cypher.js';
import { setRunMessages } from '../graph/queries.js';
import { waitForDecision } from '../sdk/gate.js';
import { finishRun, type RecordedAction, startRun, startStep } from '../sdk/recorder.js';
import type { AnyToolDefinition, ToolRegistry } from '../sdk/registry.js';
import { runTool } from '../sdk/run.js';
import { LLM_RUN_SETTINGS } from './llm.js';
import { aiGraphTools } from './tools.graph.js';

/** What a live agent is: its instructions, the world tools it may call, and graph self-checks. */
export interface LiveAgentSpec {
  agentId: AgentId;
  instructions: string;
  /** World tools; each call is gated and recorded. */
  tools: string[];
  /** Graph tools (tools.graph.ts) the agent may consult; they read the graph and are not recorded. */
  graphTools: string[];
}

export interface LiveRunOptions {
  model: LanguageModel;
  /** The id of the model, for the Run node and the run.started event. */
  modelId: string;
  registry: ToolRegistry;
  emit: (e: RunEvent) => void | Promise<void>;
  goal: string;
  awaitApproval?: (pending: RecordedAction) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface LiveRunResult {
  runId: string;
  status: 'done' | 'failed';
  text: string;
  actions: RecordedAction[];
}

// Every live call must say why: the sentence becomes the Step's thought, so the graph can
// explain a model's tool call the same way it explains a replayed one.
const why = z
  .string()
  .min(3)
  .describe('One sentence: why you are calling this tool now. It is shown to the human.');

/** The world tool's answer, as the model sees it: the result, or why nothing happened. */
function forModel(outcome: Awaited<ReturnType<typeof runTool>>) {
  switch (outcome.status) {
    case 'done':
      return { status: 'done', result: outcome.result };
    case 'blocked':
      return { status: 'blocked', reason: outcome.reason };
    case 'denied':
      return { status: 'denied', reason: outcome.reason };
  }
}

export async function runLiveAgent(
  g: TenantGraph,
  spec: LiveAgentSpec,
  opts: LiveRunOptions,
): Promise<LiveRunResult> {
  const awaitApproval =
    opts.awaitApproval ??
    (async (pending: RecordedAction) =>
      (await waitForDecision(g, pending.action.id, { signal: opts.signal }))?.approved ?? false);

  const { runId, event } = await startRun(g, {
    agentId: spec.agentId,
    kind: 'agent',
    goal: opts.goal,
    mode: 'llm',
    model: opts.modelId,
  });
  await opts.emit(event);

  const actions: RecordedAction[] = [];
  let index = 0;
  const worldTool = (def: AnyToolDefinition) =>
    tool({
      description: def.description,
      inputSchema: (def.input as z.ZodObject).extend({ why }),
      execute: async ({ why: thought, ...args }: Record<string, unknown>) => {
        const step = await startStep(g, { runId, index: index++, thought: String(thought) });
        await opts.emit(step.event);
        const outcome = await runTool(
          { g, runId, stepId: step.stepId, agentId: spec.agentId, emit: opts.emit, awaitApproval },
          def,
          args,
        );
        actions.push(outcome.recorded);
        return forModel(outcome);
      },
    });

  const tools: ToolSet = aiGraphTools({ g, registry: opts.registry }, spec.graphTools);
  for (const name of spec.tools) tools[name] = worldTool(opts.registry.get(name));

  const agent = new ToolLoopAgent({
    model: opts.model,
    instructions: spec.instructions,
    tools,
    ...LLM_RUN_SETTINGS,
  });

  try {
    const result = await agent.generate({ prompt: opts.goal, abortSignal: opts.signal });
    // The conversation is kept on the Run, so a live run can be audited (and resumed) later.
    const messages: ModelMessage[] = result.steps.flatMap((s) => s.response.messages);
    await setRunMessages(g, { runId, messages: stableStringify(messages) });
    await finishRun(g, runId, 'done');
    await opts.emit({ type: 'run.finished', runId, status: 'done', ts: Date.now() });
    return { runId, status: 'done', text: result.text, actions };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(g, runId, 'failed');
    await opts.emit({ type: 'error', runId, message });
    await opts.emit({ type: 'run.finished', runId, status: 'failed', ts: Date.now() });
    return { runId, status: 'failed', text: '', actions };
  }
}
