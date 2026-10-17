/**
 * A scripted "model" that plays a golden fixture through the real ToolLoopAgent.
 *
 * Why: replay calls runTool directly, live mode goes through the AI SDK's tool loop. Playing the
 * same fixture through both and comparing the graphs proves the live path records exactly what
 * replay does, without spending model budget. The model reads earlier tool results from the
 * prompt, the way a real model would, to fill `$ref` arguments.
 */
import type { LanguageModel } from 'ai';
import type { RunFixture } from '../contracts/fixtures.js';
import { resolveArgs } from './replay.js';

type ModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type CallOptions = Parameters<ModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<ModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** The `result` of each world tool call so far, read back from the prompt's tool messages. */
function resultsSoFar(prompt: CallOptions['prompt']): unknown[] {
  const results: unknown[] = [];
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.output.type !== 'json') continue;
      const value = part.output.value as { status?: string; result?: unknown } | null;
      results.push(value?.status === 'done' ? value.result : undefined);
    }
  }
  return results;
}

export function scriptedModel(fixture: RunFixture): ModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'backtrack',
    modelId: `scripted:${fixture.agentId}`,
    supportedUrls: {},
    async doGenerate(options): Promise<GenerateResult> {
      const results = resultsSoFar(options.prompt);
      const step = fixture.steps[results.length];
      if (!step) {
        return {
          content: [{ type: 'text', text: `Replayed ${fixture.steps.length} scripted steps.` }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        };
      }
      const args = { ...resolveArgs(step.args, results), why: step.thought };
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `call_${results.length}`,
            toolName: step.tool,
            input: JSON.stringify(args),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('The scripted model only supports generate');
    },
  };
}
