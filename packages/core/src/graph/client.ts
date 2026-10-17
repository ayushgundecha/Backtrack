/**
 * FalkorDB connection and query wrapper.
 *
 * Design notes
 * - One client per process, cached on globalThis so serverless invocations (and Next.js dev
 *   reloads) reuse the TCP connection instead of opening one per request.
 * - A cached client that has been idle is pinged before use; a failed ping, a connection
 *   `error` event or a "client is closed" error drops it and the next call reconnects.
 * - Every call returns `QueryResult` (rows + the Cypher + params + ms) so the UI can show the
 *   evidence behind each claim. Reads go through `read()` (GRAPH.RO_QUERY), writes through `write()`.
 * - Nested objects are not reliable as Cypher parameters, so callers pass JSON *strings* for
 *   `state`, `args`, `before`, `after` (see `toParams` in cypher.ts) and parse them on the way out.
 */
import { ConstraintType, EntityType, FalkorDB, type Graph } from 'falkordb';
import type { QueryResult } from '../contracts/types.js';

export interface FalkorConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): FalkorConfig {
  return {
    host: env.FALKORDB_HOST ?? 'localhost',
    port: Number(env.FALKORDB_PORT ?? 6379),
    username: env.FALKORDB_USERNAME || undefined,
    password: env.FALKORDB_PASSWORD || undefined,
  };
}

/** Graph name for a tenant. A tenant is a graph, never a WHERE filter. */
export const graphName = (tenant: string): string => `bt:${tenant}`;

/** A cached client that has not been used for this long is pinged before the next call. */
export const PING_AFTER_IDLE_MS = 10_000;

type Cached = { db: FalkorDB; key: string; lastOkAt: number };
const g = globalThis as unknown as { __backtrackFalkor?: Cached };

const keyOf = (c: FalkorConfig) => `${c.host}:${c.port}:${c.username ?? ''}`;

export async function getDb(config: FalkorConfig = configFromEnv()): Promise<FalkorDB> {
  const key = keyOf(config);
  const cached = g.__backtrackFalkor;
  if (cached?.key === key) {
    if (Date.now() - cached.lastOkAt < PING_AFTER_IDLE_MS) return cached.db;
    if (await ping(cached.db)) {
      cached.lastOkAt = Date.now();
      return cached.db;
    }
    forget(cached.db);
  } else if (cached) {
    // Different target (e.g. tests switching config): close the old client.
    forget(cached.db);
    await cached.db.close().catch(() => undefined);
  }
  return connect(config, key);
}

async function connect(config: FalkorConfig, key: string): Promise<FalkorDB> {
  const db = await FalkorDB.connect({
    socket: { host: config.host, port: config.port, connectTimeout: 5_000 },
    username: config.username,
    password: config.password,
  });
  // node-redis emits 'error' on the connection; an unhandled one crashes the process.
  db.on('error', (err: unknown) => {
    console.error('[backtrack] falkordb connection error', err);
    forget(db);
  });
  g.__backtrackFalkor = { db, key, lastOkAt: Date.now() };
  return db;
}

/** True when the server answers PING on this client. */
export async function ping(db: FalkorDB): Promise<boolean> {
  try {
    return (await (await db.connection).ping()) === 'PONG';
  } catch {
    return false;
  }
}

function forget(db: FalkorDB): void {
  if (g.__backtrackFalkor?.db === db) g.__backtrackFalkor = undefined;
}

function touch(db: FalkorDB): void {
  if (g.__backtrackFalkor?.db === db) g.__backtrackFalkor.lastOkAt = Date.now();
}

export async function closeDb(): Promise<void> {
  const cached = g.__backtrackFalkor;
  g.__backtrackFalkor = undefined;
  await cached?.db.close().catch(() => undefined);
}

/** FalkorDB's reply when a read-only command or GRAPH.DELETE targets a graph that does not exist. */
const isMissingGraph = (err: unknown) => /Invalid graph operation on empty key/i.test(String(err));

/** node-redis rejects with ClientClosedError before sending anything when the socket is gone. */
const isClientClosed = (err: unknown) =>
  /client is closed|ClientClosedError/i.test(String((err as Error)?.message ?? err));

export type Params = Record<
  string,
  string | number | boolean | null | Array<string | number | boolean | null>
>;

/** A handle to one tenant graph with evidence-returning read/write helpers. */
export class TenantGraph {
  readonly name: string;
  constructor(
    readonly tenant: string,
    private readonly config: FalkorConfig = configFromEnv(),
  ) {
    this.name = graphName(tenant);
  }

  /**
   * GRAPH.RO_QUERY: use for every agent-facing read. The server rejects writes here.
   * A tenant whose graph does not exist yet reads as empty instead of failing.
   */
  read<T = Record<string, unknown>>(cypher: string, params: Params = {}): Promise<QueryResult<T>> {
    return this.run(cypher, params, (graph) =>
      graph.roQuery<T>(cypher, { params }).catch((err: unknown) => {
        if (isMissingGraph(err)) return { data: [] as T[] };
        throw err;
      }),
    );
  }

  /** GRAPH.QUERY: writes. Also returns evidence so the recorder can emit a trace. */
  write<T = Record<string, unknown>>(cypher: string, params: Params = {}): Promise<QueryResult<T>> {
    return this.run(cypher, params, (graph) => graph.query<T>(cypher, { params }));
  }

  /** The underlying falkordb Graph, for the few calls without a Cypher form (copy, constraints). */
  async graph(): Promise<Graph> {
    return (await getDb(this.config)).selectGraph(this.name);
  }

  /** Unique constraints need an exact-match index on the same properties first. */
  async ensureUnique(label: string, ...props: string[]): Promise<void> {
    const alias = label[0]?.toLowerCase() ?? 'n';
    const propList = props.map((p) => `${alias}.${p}`).join(', ');
    await this.write(`CREATE INDEX FOR (${alias}:${label}) ON (${propList})`).catch(
      swallowAlreadyExists,
    );
    await (await this.graph())
      .constraintCreate(ConstraintType.UNIQUE, EntityType.NODE, label, ...props)
      .catch(swallowAlreadyExists);
  }

  async ensureIndex(label: string, prop: string): Promise<void> {
    const alias = label[0]?.toLowerCase() ?? 'n';
    await this.write(`CREATE INDEX FOR (${alias}:${label}) ON (${alias}.${prop})`).catch(
      swallowAlreadyExists,
    );
  }

  /** Poll until every constraint is OPERATIONAL (constraints build asynchronously). */
  async waitForConstraints(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await this.read<{ status: string }>(
        'CALL db.constraints() YIELD status RETURN status',
      );
      if (rows.every((r) => r.status === 'OPERATIONAL')) return;
      if (rows.some((r) => r.status === 'FAILED'))
        throw new Error('A constraint FAILED: existing data violates it');
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Timed out waiting for constraints');
  }

  /** GRAPH.COPY: snapshot the tenant graph (used for undo rehearsal). */
  async copyTo(destTenant: string): Promise<TenantGraph> {
    await (await this.graph()).copy(graphName(destTenant));
    return new TenantGraph(destTenant, this.config);
  }

  /** GRAPH.DELETE; a graph that does not exist yet is not an error. */
  async drop(): Promise<void> {
    await (await this.graph()).delete().catch((err: unknown) => {
      if (!isMissingGraph(err)) throw err;
    });
  }

  /**
   * Runs one call with the cached client. If the client turned out to be closed, reconnect and
   * retry once: ClientClosedError is raised before the command is sent, so a retry cannot apply
   * a write twice. Other errors (including mid-flight socket errors) are surfaced unchanged.
   */
  private async run<T>(
    cypher: string,
    params: Params,
    call: (graph: Graph) => Promise<{ data?: T[] }>,
  ): Promise<QueryResult<T>> {
    const t0 = performance.now();
    let db = await getDb(this.config);
    let reply: { data?: T[] };
    try {
      reply = await call(db.selectGraph(this.name));
    } catch (err) {
      if (!isClientClosed(err)) throw err;
      forget(db);
      db = await getDb(this.config);
      reply = await call(db.selectGraph(this.name));
    }
    touch(db);
    return { rows: (reply.data ?? []) as T[], cypher, params, ms: round(performance.now() - t0) };
  }
}

export function openTenant(tenant: string, config?: FalkorConfig): TenantGraph {
  return new TenantGraph(tenant, config);
}

export async function listGraphs(config?: FalkorConfig): Promise<string[]> {
  const db = await getDb(config);
  return db.list();
}

function swallowAlreadyExists(err: unknown): void {
  const msg = String((err as Error)?.message ?? err);
  if (/already (indexed|exists)|Constraint already exists|already set/i.test(msg)) return;
  throw err;
}

const round = (n: number) => Math.round(n * 100) / 100;
