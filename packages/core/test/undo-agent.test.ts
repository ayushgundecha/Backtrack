import { MockLanguageModelV4 } from 'ai/test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createToolRegistry } from '../src/agents/tools.js';
import { runUndoAgent } from '../src/agents/undo.js';
import { buildGolden } from './golden.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const registry = createToolRegistry();
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const planCall = {
  content: [
    {
      type: 'tool-call' as const,
      toolCallId: 'c1',
      toolName: 'plan_undo',
      input: JSON.stringify({ text: 'undo the address change', depth: 3 }),
    },
  ],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage,
  warnings: [],
};
const say = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});
const ask = (model: MockLanguageModelV4) =>
  runUndoAgent(g, { text: 'undo the address change', depth: 3 }, { model, registry });

describe('undo agent (mock model)', () => {
  beforeAll(async () => {
    await fresh(g);
    await buildGolden(g);
  });

  it("keeps the model's sentence when the plan backs every claim", async () => {
    const text =
      'This takes 6 steps at depth 3, from revoking cr_1 back to restoring ord_1001; the email eml_1 gets a correction draft, and it reaches billing-agent.';
    const res = await ask(new MockLanguageModelV4({ doGenerate: [planCall, say(text)] }));
    expect(res.fromModel).toBe(true);
    expect(res.outcome.kind).toBe('plan');
    expect(res.summary).toEqual({ text, valid: true, problems: [] });
  });

  it('replaces a sentence with an invented id by the plan’s own summary', async () => {
    const res = await ask(
      new MockLanguageModelV4({ doGenerate: [planCall, say('Undoing act_zz99zz99 in 6 steps.')] }),
    );
    if (res.outcome.kind !== 'plan') throw new Error('expected a plan');
    expect(res.summary).toMatchObject({
      valid: false,
      text: res.outcome.plan.summary,
      problems: ['act_zz99zz99 is not in the outcome'],
    });
  });

  it('a model that never plans (or fails) still gets the engine’s answer, never its own', async () => {
    const lazy = await ask(new MockLanguageModelV4({ doGenerate: [say('Done, all undone!')] }));
    expect(lazy.fromModel).toBe(false);
    expect(lazy.outcome.kind).toBe('plan');
    expect(lazy.summary.valid).toBe(false);

    const broken = await ask(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error('provider down');
        },
      }),
    );
    expect(broken.fromModel).toBe(false);
    if (broken.outcome.kind !== 'plan') throw new Error('expected a plan');
    expect(broken.summary.text).toBe(broken.outcome.plan.summary);
  });
});
