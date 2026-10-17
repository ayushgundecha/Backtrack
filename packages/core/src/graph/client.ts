/**
 * FalkorDB connection and query wrapper.
 *
 * Design notes
 * - One client per process, cached on globalThis so serverless invocations reuse the TCP connection.
 * - Every read returns `QueryResult` (rows + the Cypher + params + ms) so the UI can show the evidence
 *   behind each claim. Writes go through `write()`, reads through `read()` (GRAPH.RO_QUERY).
 * - Nested objects are not reliable as Cypher parameters, so callers pass JSON *strings* for
 *   `state`, `args`, `before`, `after` and parse them on the way out.
 */
import { ConstraintType, EntityType, FalkorDB, type Graph } from 'falkordb';
import type { QueryResult } from '../contracts/types.js';

export { ConstraintType, EntityType };

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

type Cached = { db: FalkorDB; key: string };
const g = globalThis as unknown as { __backtrackFalkor?: Cached };

export async function getDb(config: FalkorConfig = configFromEnv()): Promise<FalkorDB> {
  const key = `${config.host}:${config.port}:${config.username ?? ''}`;
  if (g.__backtrackFalkor?.key === key) {
    return g.__backtrackFalkor.db;
  }
  const db = await FalkorDB.connect({
    socket: { host: config.host, port: config.port },
    username: config.username,
    password: config.password,
  });
  // node-redis emits 'error' on the connection; an unhandled one crashes the process.
  (db as unknown as { on?: (e: string, cb: (err: unknown) => void) => void }).on?.(
    'error',
    (err) => {
      console.error('[backtrack] falkordb connection error', err);
      if (g.__backtrackFalkor?.db === db) g.__backtrackFalkor = undefined;
    },
  );
  g.__backtrackFalkor = { db, key };
  return db;
}

export async function closeDb(): Promise<void> {
  const cached = g.__backtrackFalkor;
  g.__backtrackFalkor = undefined;
  await cached?.db.close();
}

export type Params = Record<
  string,
  string | number | boolean | null | Array<string | number | boolean | null>
>;

/** A handle to one tenant graph with evidence-returning read/write helpers. */
export class TenantGraph {
  readonly name: string;
  constructor(
    readonly graph: Graph,
    readonly db: FalkorDB,
    readonly tenant: string,
  ) {
    this.name = graphName(tenant);
  }

  /** GRAPH.RO_QUERY: use for every agent-facing read. */
  async read<T = Record<string, unknown>>(
    cypher: string,
    params: Params = {},
  ): Promise<QueryResult<T>> {
    const t0 = performance.now();
    const reply = await this.graph.roQuery<T>(cypher, { params });
    return { rows: (reply.data ?? []) as T[], cypher, params, ms: round(performance.now() - t0) };
  }

  /** GRAPH.QUERY: writes. Also returns evidence so the recorder can emit a trace. */
  async write<T = Record<string, unknown>>(
    cypher: string,
    params: Params = {},
  ): Promise<QueryResult<T>> {
    const t0 = performance.now();
    const reply = await this.graph.query<T>(cypher, { params });
    return { rows: (reply.data ?? []) as T[], cypher, params, ms: round(performance.now() - t0) };
  }

  /** Unique constraints need an exact-match index on the same properties first. */
  async ensureUnique(label: string, ...props: string[]): Promise<void> {
    const alias = label[0]?.toLowerCase() ?? 'n';
    const propList = props.map((p) => `${alias}.${p}`).join(', ');
    await this.write(`CREATE INDEX FOR (${alias}:${label}) ON (${propList})`).catch(
      swallowAlreadyExists,
    );
    await this.graph
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
  async copyTo(destTenantOrName: string): Promise<string> {
    const dest = destTenantOrName.startsWith('bt:')
      ? destTenantOrName
      : graphName(destTenantOrName);
    await this.graph.copy(dest);
    return dest;
  }

  async drop(): Promise<void> {
    await this.graph.delete().catch(() => undefined);
  }
}

export async function openTenant(tenant: string, config?: FalkorConfig): Promise<TenantGraph> {
  const db = await getDb(config);
  return new TenantGraph(db.selectGraph(graphName(tenant)), db, tenant);
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
