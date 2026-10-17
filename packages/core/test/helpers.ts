import { afterAll } from 'vitest';
import { closeDb, openTenant, type TenantGraph } from '../src/graph/client.js';
import { resetTenant } from '../src/world/seed.js';

/** Every test file works on graph bt:test (files run sequentially; see vitest.config.ts). */
export const TEST_TENANT = 'test';

export function testGraph(): TenantGraph {
  const g = openTenant(TEST_TENANT);
  afterAll(async () => {
    await g.drop();
    await closeDb();
  });
  return g;
}

/** Drop bt:test and rebuild schema, actors and the seeded world. */
export async function fresh(g: TenantGraph): Promise<TenantGraph> {
  await resetTenant(g);
  return g;
}
