/**
 * Shared plumbing for the API routes: tenant resolution, contract parsing, JSON errors and SSE.
 *
 * Routes are deliberately thin: parse with the contract schema, call one core function, validate
 * the response with the contract schema. All graph work lives in @backtrack/core.
 */
import {
  createToolRegistry,
  ensureTenant,
  openTenant,
  PolicyError,
  queries,
  RunEvent,
  type TenantGraph,
  type ToolRegistry,
} from '@backtrack/core';
import { ZodError, type z } from 'zod';
import {
  clientKey,
  type LimitedRoute,
  MAX_BODY_BYTES,
  oversizedField,
  RATE_LIMITS,
  RateLimiter,
} from './limits';
import { TENANT_PATTERN } from './tenant';

/** An error with an HTTP status and a message that is safe and useful to show in the panel. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** The tenant graph, bootstrapped and seeded on first use (cheap afterwards). */
export async function tenantGraph(tenant: string): Promise<TenantGraph> {
  // Tenants map to graph names (`bt:<tenant>`); the pattern is shared with the panel's switcher.
  if (!TENANT_PATTERN.test(tenant)) {
    throw new HttpError(400, 'tenant must be 1–32 lowercase letters, digits or dashes');
  }
  const g = openTenant(tenant);
  await ensureTenant(g);
  return g;
}

let registry: ToolRegistry | undefined;
/** One tool registry per server process; tool definitions are stateless. */
export const tools = (): ToolRegistry => {
  registry ??= createToolRegistry();
  return registry;
};

export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return schema.parse(params);
}

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    throw new HttpError(413, `Request body is larger than ${MAX_BODY_BYTES} bytes`);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
  const tooLong = oversizedField(body);
  if (tooLong) throw new HttpError(400, tooLong);
  return schema.parse(body);
}

const limiter = new RateLimiter();

/** Count this request against the client's per-minute allowance for a route (429 when over). */
export function rateLimit(req: Request, route: LimitedRoute): void {
  const verdict = limiter.take(`${route}:${clientKey(req)}`, RATE_LIMITS[route]);
  if (!verdict.ok) {
    throw new HttpError(429, `Too many requests; try again in ${verdict.retryAfterS} s`, {
      'retry-after': String(verdict.retryAfterS),
    });
  }
}

/** Longest a streamed run can live (the routes' maxDuration); older unfinished runs are dead. */
const RUN_LIFETIME_MS = 300_000;

/**
 * One run or undo at a time per tenant. Checked in the graph (R9), not in memory, because two
 * requests may land on different serverless instances.
 */
export async function assertIdle(g: TenantGraph): Promise<void> {
  const { rows } = await queries.activeRuns(g, { since: Date.now() - RUN_LIFETIME_MS });
  const busy = rows[0];
  if (busy) {
    const what = busy.kind === 'undo' ? 'An undo' : `A run by ${busy.agentId}`;
    throw new HttpError(
      409,
      `${what} is still ${busy.status} on this tenant; wait for it to finish`,
    );
  }
}

/** Validate a response against its contract before it leaves the server. */
export function json<S extends z.ZodType>(schema: S, data: z.input<S>, status = 200): Response {
  return Response.json(schema.parse(data), { status });
}

/** Wrap a handler so every failure becomes `{ error }` with the right status. */
export function route(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status, headers: err.headers });
  }
  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return Response.json({ error: message }, { status: 400 });
  }
  if (err instanceof PolicyError) return Response.json({ error: err.message }, { status: 400 });
  console.error(err);
  return Response.json({ error: errorText(err) }, { status: 500 });
}

/**
 * A message worth showing for any thrown value. A refused connection to FalkorDB arrives as an
 * AggregateError with an empty message (one inner error per address tried), which would leave
 * the panel with a blank error; the inner messages or the error code say what happened.
 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message) return err.message;
  if (err instanceof AggregateError && err.errors.length > 0) {
    return [...new Set(err.errors.map(errorText))].join('; ');
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? `${err.name}: ${code}` : err.name;
}

export type Emit = (e: RunEvent) => Promise<void>;

const KEEP_ALIVE_MS = 15_000;

/**
 * Stream RunEvents as Server-Sent Events, one JSON object per `data:` line.
 *
 * Every event is validated against the contract first. A comment line every 15 s keeps proxies
 * from closing the connection while a run waits for a human at the gate. When the client goes
 * away, `signal` aborts so the producer can stop waiting.
 */
export function sse(
  req: Request,
  produce: (emit: Emit, signal: AbortSignal) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort());

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
        }
      };
      const timer = setInterval(() => write(': keep-alive\n\n'), KEEP_ALIVE_MS);
      const emit: Emit = async (e) => write(`data: ${JSON.stringify(RunEvent.parse(e))}\n\n`);
      try {
        await produce(emit, abort.signal);
      } catch (err) {
        const message = errorText(err);
        await emit({ type: 'error', runId: null, message });
      } finally {
        clearInterval(timer);
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by a disconnecting client.
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
