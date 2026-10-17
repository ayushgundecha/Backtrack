/**
 * Typed access to the golden fixtures in /fixtures, used only by the mock client.
 * The JSON is validated against the frozen contracts when the module loads, so a fixture edit
 * that breaks the shape fails loudly here instead of producing a half-rendered demo.
 */
import { type AgentId, RunFixture, WorldSeed } from '@backtrack/core/contracts';
import billingRunJson from '../../../fixtures/billing-run.json';
import opsRunJson from '../../../fixtures/ops-run.json';
import worldSeedJson from '../../../fixtures/world-seed.json';

export const worldSeed: WorldSeed = WorldSeed.parse(worldSeedJson);

export const runFixtures: Record<AgentId, RunFixture> = {
  'ops-agent': RunFixture.parse(opsRunJson),
  'billing-agent': RunFixture.parse(billingRunJson),
};
