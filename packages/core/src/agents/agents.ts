/** The live agents by id, for the API route and the CLI. */
import type { AgentId } from '../contracts/types.js';
import { BILLING_AGENT } from './billing.js';
import type { LiveAgentSpec } from './live.js';
import { OPS_AGENT } from './ops.js';

export const LIVE_AGENTS: Record<AgentId, LiveAgentSpec> = {
  'ops-agent': OPS_AGENT,
  'billing-agent': BILLING_AGENT,
};
