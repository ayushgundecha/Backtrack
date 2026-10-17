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
  RunEvent,
  type TenantGraph,
  type ToolRegistry,
} from '@backtrack/core';
import { ZodError, type z } from 'zod';

/** An error with an HTTP status and a message that is safe and useful to show in the panel. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Tenants map to graph names (`bt:<tenant>`); a strict shape keeps callers off other graphs.
const TENANT = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The tenant graph, bootstrapped and seeded on first use (cheap afterwards). */
export async function tenantGraph(tenant: string): Promise<TenantGraph> {
  if (!TENANT.test(tenant)) {
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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
  return schema.parse(body);
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
  if (err instanceof HttpError)
    return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return Response.json({ error: message }, { status: 400 });
  }
  if (err instanceof PolicyError) return Response.json({ error: err.message }, { status: 400 });
  console.error(err);
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: message }, { status: 500 });
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
        const message = err instanceof Error ? err.message : String(err);
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
