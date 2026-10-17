/**
 * Live mode's model: a free OpenRouter model with fallbacks, behind a daily budget kept in FalkorDB.
 *
 * Why the budget lives in the graph: the panel runs on stateless serverless functions, and the
 * free tier allows ~50 requests a day per key. A counter on a Meta node, claimed in one
 * statement (S9) before every model request, is shared by every instance and cannot overspend.
 * When it runs out, callers fall back to replay and say so (LlmBudgetExhausted).
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { type LanguageModel, stepCountIs, wrapLanguageModel } from 'ai';
import { openTenant, type TenantGraph } from '../graph/client.js';
import { claimLlmCall, llmUsage } from '../graph/queries.js';

export interface LlmConfig {
  apiKey: string;
  model: string;
  /** Tried in order by OpenRouter when the primary model is unavailable (`models` routing). */
  fallbacks: string[];
  /** Model requests allowed per UTC day, across every tenant. */
  dailyLimit: number;
}

export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
export const DEFAULT_FALLBACKS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
];
export const DEFAULT_DAILY_LIMIT = 40;

/** Settings every live run uses: deterministic, and a hard cap on agent loop length. */
export const LLM_RUN_SETTINGS = { temperature: 0, stopWhen: stepCountIs(8) } as const;

/**
 * The budget is per API key, not per tenant, so it lives in its own graph. The leading
 * underscore keeps it out of reach of tenant names, which must start with a letter or digit.
 */
export const BUDGET_TENANT = '_budget';

/** The live-mode config, or null when no OpenRouter key is set (replay still works). */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const list = (s: string | undefined) =>
    s
      ?.split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  const limit = Number.parseInt(env.BACKTRACK_LLM_DAILY_LIMIT ?? '', 10);
  return {
    apiKey,
    model: env.BACKTRACK_MODEL?.trim() || DEFAULT_MODEL,
    fallbacks: list(env.BACKTRACK_MODEL_FALLBACKS) ?? DEFAULT_FALLBACKS,
    dailyLimit: Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_DAILY_LIMIT,
  };
}

export class LlmBudgetExhausted extends Error {
  override name = 'LlmBudgetExhausted';
  constructor(readonly limit: number) {
    super(`Today's live-model budget (${limit} requests) is used up; showing the replay instead`);
  }
}

/** The UTC day a request counts against, e.g. "2026-10-17". */
export const budgetDay = (now = new Date()) => now.toISOString().slice(0, 10);

export interface Budget {
  used: number;
  limit: number;
  left: number;
}

/** Claim one model request; throws LlmBudgetExhausted when today's limit is reached. */
export async function claimBudget(
  g: TenantGraph,
  limit: number,
  now = new Date(),
): Promise<Budget> {
  const { rows } = await claimLlmCall(g, { day: budgetDay(now), limit });
  const row = rows[0];
  if (!row?.ok) throw new LlmBudgetExhausted(limit);
  return { used: row.used, limit, left: limit - row.used };
}

/** Today's usage, for the panel's "n live runs left" hint. */
export async function readBudget(g: TenantGraph, limit: number, now = new Date()): Promise<Budget> {
  const { rows } = await llmUsage(g, { day: budgetDay(now) });
  const used = rows[0]?.used ?? 0;
  return { used, limit, left: Math.max(0, limit - used) };
}

export interface BudgetedModelOptions {
  limit: number;
  /** Where the counter lives; defaults to the shared budget graph. */
  budgetGraph?: TenantGraph;
  /** Called with the model that actually answered (OpenRouter may have used a fallback). */
  onModel?: (modelId: string) => void;
}

/**
 * Wrap any model so each request first claims budget, and report which model answered.
 * Kept separate from OpenRouter so it can be tested with a mock model.
 */
export function withBudget(model: LanguageModel, opts: BudgetedModelOptions): LanguageModel {
  if (typeof model === 'string') throw new TypeError('withBudget needs a model instance');
  const graph = opts.budgetGraph ?? openTenant(BUDGET_TENANT);
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        await claimBudget(graph, opts.limit);
        const result = await doGenerate();
        if (result.response?.modelId) opts.onModel?.(result.response.modelId);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        await claimBudget(graph, opts.limit);
        const result = await doStream();
        const report = new TransformStream({
          transform(part, controller) {
            if (part.type === 'response-metadata' && part.modelId) opts.onModel?.(part.modelId);
            controller.enqueue(part);
          },
        });
        return { ...result, stream: result.stream.pipeThrough(report) };
      },
    },
  });
}

/** The OpenRouter model for live runs, budgeted. Logs which model answered each request. */
export function createLiveModel(
  config: LlmConfig,
  opts: Omit<BudgetedModelOptions, 'limit'> = {},
): LanguageModel {
  const openrouter = createOpenRouter({ apiKey: config.apiKey });
  const model = openrouter.chat(config.model, { extraBody: { models: config.fallbacks } });
  return withBudget(model, {
    limit: config.dailyLimit,
    budgetGraph: opts.budgetGraph,
    onModel: opts.onModel ?? ((id) => console.info(`[backtrack] live model answered with ${id}`)),
  });
}
