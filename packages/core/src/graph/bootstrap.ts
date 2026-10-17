/**
 * Idempotent schema bootstrap for one tenant graph (docs/PLAN.md §4).
 *
 * Why gated on a Meta node: index and constraint creation are not free and constraints build
 * asynchronously, so a request path must never pay for them. `/api/reset` and the CLIs call
 * `bootstrap()` explicitly; importing this module does nothing.
 */
import type { TenantGraph } from './client.js';
import {
  ensureAgent,
  ensureCounter,
  ensureUser,
  isBootstrapped,
  markBootstrapped,
} from './queries.js';

/** Labels whose `id` must be unique; Entity is unique on the composite (type, key). */
const UNIQUE_IDS = ['Action', 'Run', 'UndoPlan', 'Policy'] as const;
/** Lookup paths the queries use: seq ordering, tool/status filters, entity listing by type. */
const SECONDARY_INDEXES: ReadonlyArray<[label: string, prop: string]> = [
  ['Action', 'seq'],
  ['Action', 'tool'],
  ['Action', 'status'],
  ['Entity', 'type'],
  ['Step', 'id'],
  ['Agent', 'id'],
  ['User', 'id'],
];

/** The actors that exist in every tenant: the two demo agents, Backtrack itself, and the human. */
export const AGENTS = [
  { id: 'ops-agent', name: 'Ops agent', version: '1.0' },
  { id: 'billing-agent', name: 'Billing agent', version: '1.0' },
  { id: 'backtrack', name: 'Backtrack', version: '1.0' },
] as const;
export const DEFAULT_USER = { id: 'ayush', name: 'Ayush' } as const;

export async function bootstrap(g: TenantGraph): Promise<{ created: boolean }> {
  const { rows } = await isBootstrapped(g, {});
  if (rows[0]?.done === true) return { created: false };

  for (const label of UNIQUE_IDS) await g.ensureUnique(label, 'id');
  await g.ensureUnique('Entity', 'type', 'key');
  await g.waitForConstraints();
  for (const [label, prop] of SECONDARY_INDEXES) await g.ensureIndex(label, prop);

  await ensureCounter(g, {});
  for (const agent of AGENTS) await ensureAgent(g, agent);
  await ensureUser(g, DEFAULT_USER);
  // Meta last: if anything above fails, the next call retries the whole (idempotent) sequence.
  await markBootstrapped(g, {});
  return { created: true };
}
