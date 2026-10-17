/**
 * Typed client for every route in `@backtrack/core/contracts` (api.ts).
 *
 * The UI only ever talks to `ApiClient`; `createApiClient()` picks the HTTP implementation or the
 * fixture-backed mock (NEXT_PUBLIC_MOCK=1). Client code imports contracts only, never the FalkorDB
 * client, so nothing server-side leaks into the browser bundle.
 */
import {
  api,
  type Explain,
  type GraphSnapshot,
  type Policy,
  type RehearsalDiff,
  RunEvent,
  type UndoOutcome,
  type UndoPlan,
  type WorldSnapshot,
} from '@backtrack/core/contracts';
import type { z } from 'zod';

// Request bodies are the contract schemas' inputs minus `tenant`, which the client owns.
type WithoutTenant<T> = Omit<T, 'tenant'>;
export type AgentRequest = WithoutTenant<z.input<typeof api.agent.body>>;
export type ApprovalRequest = WithoutTenant<z.input<typeof api.approval.body>>;
export type UndoRequest = WithoutTenant<z.input<typeof api.undo.body>>;
export type PolicyRequest = WithoutTenant<z.input<typeof api.policy.body>>;
export type AlgoRequest = WithoutTenant<z.input<typeof api.algo.query>>;

export type ActionsResponse = z.infer<typeof api.actions.response>;
export type ActionSummary = ActionsResponse['actions'][number];
export type ResetResponse = z.infer<typeof api.reset.response>;
export type ApprovalResponse = z.infer<typeof api.approval.response>;
export type AlgoResponse = z.infer<typeof api.algo.response>;

export interface ApiClient {
  /** 'mock' is shown on screen: nothing it returns came from FalkorDB. */
  readonly kind: 'http' | 'mock';
  readonly tenant: string;
  graph(): Promise<GraphSnapshot>;
  /** asOfSeq folds Effects up to that seq (the time scrubber); omitted means now. */
  world(asOfSeq?: number): Promise<WorldSnapshot>;
  actions(): Promise<ActionsResponse>;
  explain(actionId: string): Promise<Explain>;
  reset(token: string): Promise<ResetResponse>;
  /** Streams the run's RunEvents; a gated step pauses the stream until approval() answers it. */
  runAgent(request: AgentRequest, signal?: AbortSignal): AsyncIterable<RunEvent>;
  approval(request: ApprovalRequest): Promise<ApprovalResponse>;
  /** Proposes an undo; nothing is executed until executeUndo(planId). */
  undo(request: UndoRequest): Promise<UndoOutcome>;
  /** Streams undo.step × n then undo.finished. */
  executeUndo(planId: string, signal?: AbortSignal): AsyncIterable<RunEvent>;
  rehearse(planId: string): Promise<RehearsalDiff>;
  plan(planId: string): Promise<UndoPlan>;
  policy(request: PolicyRequest): Promise<Policy>;
  algo(request: AlgoRequest): Promise<AlgoResponse>;
}

/** A non-2xx response or a body that does not match its contract. `message` is the real reason. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly route: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface HttpClientOptions {
  tenant?: string;
  /** Origin prefix for the routes; empty means same origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class HttpApiClient implements ApiClient {
  readonly kind = 'http';
  readonly tenant: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ tenant = 'demo', baseUrl = '', fetch: fetchImpl }: HttpClientOptions = {}) {
    this.tenant = tenant;
    this.baseUrl = baseUrl;
    // Bound so that `this` is the global object, which window.fetch requires.
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  graph() {
    return this.get('/api/graph', {}, api.graph.response);
  }

  world(asOfSeq?: number) {
    return this.get('/api/world', { asOfSeq }, api.world.response);
  }

  actions() {
    return this.get('/api/actions', {}, api.actions.response);
  }

  explain(actionId: string) {
    return this.get('/api/explain', { actionId }, api.explain.response);
  }

  reset(token: string) {
    return this.post('/api/reset', { token }, api.reset.response);
  }

  runAgent(request: AgentRequest, signal?: AbortSignal) {
    return this.stream(
      '/api/agent',
      api.agent.body.parse({ ...request, tenant: this.tenant }),
      signal,
    );
  }

  approval(request: ApprovalRequest) {
    return this.post('/api/approval', request, api.approval.response);
  }

  undo(request: UndoRequest) {
    return this.post('/api/undo', request, api.undo.response);
  }

  executeUndo(planId: string, signal?: AbortSignal) {
    const body = api.undoExecute.body.parse({ tenant: this.tenant, planId, confirmed: true });
    return this.stream('/api/undo/execute', body, signal);
  }

  rehearse(planId: string) {
    return this.post('/api/rehearse', { planId }, api.rehearse.response);
  }

  plan(planId: string) {
    return this.get('/api/plan', { planId }, api.plan.response);
  }

  policy(request: PolicyRequest) {
    return this.post('/api/policy', request, api.policy.response);
  }

  algo({ name, from, to }: AlgoRequest) {
    return this.get('/api/algo', { name, from, to }, api.algo.response);
  }

  private url(route: string, query: Record<string, string | number | undefined> = {}): string {
    const params = new URLSearchParams({ tenant: this.tenant });
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return `${this.baseUrl}${route}?${params}`;
  }

  private async get<S extends z.ZodType>(
    route: string,
    query: Record<string, string | number | undefined>,
    schema: S,
  ): Promise<z.infer<S>> {
    const res = await this.fetchImpl(this.url(route, query), {
      headers: { accept: 'application/json' },
    });
    return parseJson(route, res, schema);
  }

  private async post<S extends z.ZodType>(
    route: string,
    body: Record<string, unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ tenant: this.tenant, ...body }),
    });
    return parseJson(route, res, schema);
  }

  private async *stream(
    route: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<RunEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
    if (!res.ok || !res.body) throw new ApiError(await errorMessage(res), res.status, route);
    yield* parseSse(res.body);
  }
}

async function parseJson<S extends z.ZodType>(
  route: string,
  res: Response,
  schema: S,
): Promise<z.infer<S>> {
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status, route);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    throw new ApiError(
      `${route} returned an unexpected shape: ${parsed.error.message}`,
      res.status,
      route,
    );
  }
  return parsed.data;
}

/** Routes answer errors as `{ error }` or `{ message }`; fall back to the raw text. */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = body.error ?? body.message;
    if (typeof message === 'string') return message;
  } catch {
    // Not JSON: the text itself is the message.
  }
  return text || `${res.status} ${res.statusText}`;
}

/**
 * Parses a Server-Sent Events body into validated RunEvents.
 * Events are separated by a blank line; each carries its JSON on one or more `data:` lines.
 * Comments (`: keep-alive`) and other fields are ignored. Chunks may split anywhere.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      // stream: true keeps a multi-byte character that straddles two chunks intact.
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = parseSseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    const tail = parseSseBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): RunEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  return data ? RunEvent.parse(JSON.parse(data)) : null;
}

/** True when the build was made with NEXT_PUBLIC_MOCK=1 (inlined by Next at build time). */
export const isMockMode = process.env.NEXT_PUBLIC_MOCK === '1';

/**
 * Chooses the implementation. The mock (and the fixtures it bundles) is loaded with a dynamic
 * import: it is split into its own chunk that a browser talking to the real API never downloads.
 */
export async function createApiClient(tenant = 'demo'): Promise<ApiClient> {
  if (isMockMode) {
    const { MockApiClient } = await import('./mock');
    return new MockApiClient({ tenant });
  }
  return new HttpApiClient({ tenant });
}
