import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimBudget,
  DEFAULT_MODEL,
  LlmBudgetExhausted,
  llmConfigFromEnv,
  readBudget,
  withBudget,
} from '../src/agents/llm.js';
import { testGraph } from './helpers.js';

const g = testGraph();
const day = (d: string) => new Date(`${d}T12:00:00Z`);

const answer = (modelId: string) => ({
  content: [{ type: 'text' as const, text: 'ok' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  response: { modelId },
  warnings: [],
});

describe('live-model budget', () => {
  beforeEach(async () => {
    await g.drop();
  });

  it('counts requests per UTC day and refuses the one over the limit', async () => {
    const monday = day('2026-10-19');
    expect(await claimBudget(g, 2, monday)).toEqual({ used: 1, limit: 2, left: 1 });
    expect(await claimBudget(g, 2, monday)).toEqual({ used: 2, limit: 2, left: 0 });
    await expect(claimBudget(g, 2, monday)).rejects.toBeInstanceOf(LlmBudgetExhausted);
    // The refused request was not counted.
    expect(await readBudget(g, 2, monday)).toEqual({ used: 2, limit: 2, left: 0 });
    // A new day starts from zero.
    expect(await claimBudget(g, 2, day('2026-10-20'))).toEqual({ used: 1, limit: 2, left: 1 });
  });

  it('cannot be overspent by concurrent requests', async () => {
    const claims = await Promise.allSettled(
      Array.from({ length: 7 }, () => claimBudget(g, 4, day('2026-10-21'))),
    );
    expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(4);
    expect(await readBudget(g, 4, day('2026-10-21'))).toMatchObject({ used: 4 });
  });

  it('wraps a model: each request claims budget, and the answering model is reported', async () => {
    const answered: string[] = [];
    const model = withBudget(
      new MockLanguageModelV4({ doGenerate: answer('google/gemma-4-31b-it:free') }),
      { limit: 1, budgetGraph: g, onModel: (id) => answered.push(id) },
    );
    expect((await generateText({ model, prompt: 'hi' })).text).toBe('ok');
    expect(answered).toEqual(['google/gemma-4-31b-it:free']);
    await expect(generateText({ model, prompt: 'again' })).rejects.toThrow(
      "Today's live-model budget (1 requests) is used up; showing the replay instead",
    );
  });

  it('reads its config from the environment; no key means no live mode', () => {
    expect(llmConfigFromEnv({})).toBeNull();
    expect(
      llmConfigFromEnv({
        OPENROUTER_API_KEY: ' sk-test ',
        BACKTRACK_MODEL_FALLBACKS: 'a:free, b:free',
        BACKTRACK_LLM_DAILY_LIMIT: '12',
      }),
    ).toEqual({
      apiKey: 'sk-test',
      model: DEFAULT_MODEL,
      fallbacks: ['a:free', 'b:free'],
      dailyLimit: 12,
    });
  });
});
