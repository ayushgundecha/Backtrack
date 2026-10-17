/**
 * Seeds the synthetic world into a tenant graph with fixed ids (cust_42, ord_1001, …) so every
 * demo run, test and screenshot shows the same data.
 */
import seedJson from '../../../../fixtures/world-seed.json' with { type: 'json' };
import { WorldSeed } from '../contracts/fixtures.js';
import { bootstrap } from '../graph/bootstrap.js';
import type { TenantGraph } from '../graph/client.js';
import { stableStringify } from '../graph/cypher.js';
import { markSeeded, metaInfo, upsertEntities } from '../graph/queries.js';
import { displayOf } from './types.js';

export function loadSeed(): WorldSeed {
  return WorldSeed.parse(seedJson);
}

export async function seedWorld(g: TenantGraph, seed: WorldSeed = loadSeed()): Promise<number> {
  const entities = [
    ...seed.customers.map((c) => ({ type: 'customer', key: c.id, state: c })),
    ...seed.orders.map((o) => ({ type: 'order', key: o.id, state: o })),
  ];
  const { rows } = await upsertEntities(g, {
    types: entities.map((e) => e.type),
    keys: entities.map((e) => e.key),
    displays: entities.map((e) => displayOf(e.type, e.key)),
    states: entities.map((e) => stableStringify(e.state)),
  });
  await markSeeded(g, { ts: Date.now() });
  return rows[0]?.n ?? 0;
}

/** Drop the tenant graph and rebuild it from scratch: schema, actors, world. */
export async function resetTenant(g: TenantGraph): Promise<{ seededAt: number }> {
  await g.drop();
  await bootstrap(g);
  await seedWorld(g);
  return { seededAt: Date.now() };
}

/** Bootstrap and seed only if that has not happened yet (cheap when the tenant is ready). */
export async function ensureTenant(g: TenantGraph): Promise<void> {
  const { rows } = await metaInfo(g, {});
  const meta = rows[0];
  if (meta?.bootstrapped !== true) await bootstrap(g);
  if (meta?.seededAt == null) await seedWorld(g);
}
