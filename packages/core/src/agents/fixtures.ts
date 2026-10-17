/** The golden runs replay mode feeds through the real recorder (fixtures/*.json). */
import billingJson from '../../../../fixtures/billing-run.json' with { type: 'json' };
import opsJson from '../../../../fixtures/ops-run.json' with { type: 'json' };
import { RunFixture } from '../contracts/fixtures.js';
import type { AgentId } from '../contracts/types.js';

const FIXTURES: Record<AgentId, unknown> = { 'ops-agent': opsJson, 'billing-agent': billingJson };

export function loadRunFixture(agent: AgentId): RunFixture {
  return RunFixture.parse(FIXTURES[agent]);
}
