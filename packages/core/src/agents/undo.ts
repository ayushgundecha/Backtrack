/**
 * The undo agent: turns "undo the address change" into one of the four honest outcomes, in words.
 *
 * The graph decides; the model only phrases. The outcome is whatever plan_undo returned, and the
 * model's final sentence is kept only if validateSummary finds every id, tool and count in it.
 * If the model never calls plan_undo (or fails), the engine plans directly and the row-built
 * template is shown, so the answer never depends on the model getting it right.
 */
import { type LanguageModel, ToolLoopAgent } from 'ai';
import type { UndoOutcome } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import type { ToolRegistry } from '../sdk/registry.js';
import { planUndo } from '../sdk/undo.js';
import { type SummaryCheck, validateSummary } from '../sdk/validate.js';
import { LLM_RUN_SETTINGS } from './llm.js';
import { aiGraphTools, type GraphToolOutcome } from './tools.graph.js';

/** Read-only by design: the agent proposes; only the human's Confirm executes a plan. */
export const UNDO_AGENT_TOOLS = [
  'list_actions',
  'resolve_action',
  'plan_undo',
  'explain_action',
  'blast_radius',
  'entity_history',
  'recall',
] as const;

export const UNDO_AGENT_INSTRUCTIONS = `You help a person undo what AI agents did. You never execute anything; you propose.

1. Call plan_undo with the person's words as "text" (or an actionId if they gave one) and the depth they asked for (default 5).
2. Answer according to the outcome kind:
   - plan: say what will be undone, in order, how many steps, and which other agents it reaches. Irreversible actions get a mitigation, not an undo; say so.
   - memory: say it was already undone, when, and by which plan.
   - none: say why there is nothing to undo.
   - unknown: say you could not tell which action they meant and list the candidates with their ids.
3. Use only ids, tools and numbers that appear in the tool results. Never invent them.
Answer in two to four plain sentences.`;

export interface UndoAgentResult {
  outcome: UndoOutcome;
  summary: SummaryCheck;
  /** True when the outcome came from the model's plan_undo call, false when the engine stepped in. */
  fromModel: boolean;
}

export async function runUndoAgent(
  g: TenantGraph,
  request: { text: string; depth?: number },
  opts: { model: LanguageModel; registry: ToolRegistry; signal?: AbortSignal },
): Promise<UndoAgentResult> {
  // The last plan_undo answer is the outcome; the model's sentence is checked against it.
  const seen: { outcome: UndoOutcome | null } = { outcome: null };
  const keepPlan = (name: string, out: GraphToolOutcome) => {
    if (name === 'plan_undo' && out.ok) seen.outcome = out.result as UndoOutcome;
  };
  const agent = new ToolLoopAgent({
    model: opts.model,
    instructions: UNDO_AGENT_INSTRUCTIONS,
    tools: aiGraphTools({ g, registry: opts.registry }, UNDO_AGENT_TOOLS, keepPlan),
    ...LLM_RUN_SETTINGS,
  });

  let text: string | null = null;
  try {
    const result = await agent.generate({
      prompt: `${request.text}${request.depth ? ` (depth ${request.depth})` : ''}`,
      abortSignal: opts.signal,
    });
    text = result.text;
  } catch {
    // A failed model call is not a failed undo: the engine answers below with its template.
  }

  const fromModel = seen.outcome !== null;
  const final: UndoOutcome =
    seen.outcome ??
    (await planUndo(g, { text: request.text, depth: request.depth }, { registry: opts.registry }))
      .outcome;
  const knownTools = opts.registry.list().map((t) => t.name);
  return {
    outcome: final,
    summary: validateSummary(fromModel ? text : null, final, knownTools),
    fromModel,
  };
}
