/**
 * "Never again": a human turns an undo into a rule the gate enforces on every later call.
 *
 * A policy is a node, not a config entry, so it sits in the same graph as what prompted it:
 * (User)-[:SET]->(Policy)-[:ON_TOOL]->(Agent), -[:APPLIES_TO]->(Entity), and later
 * (Policy)-[:BLOCKED]->(Action). Q5 reads these edges before every tool call (see run.ts).
 */
import { type Policy, Policy as PolicySchema } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { createPolicy, listAgents } from '../graph/queries.js';
import { getMany } from '../world/store.js';
import { newId } from './recorder.js';

export type PolicyInput = Omit<Policy, 'id' | 'ts'>;

export class PolicyError extends Error {
  override name = 'PolicyError';
}

/**
 * Record a policy and return it in contract shape.
 *
 * The scope is checked first: P5 links the agent and entity with OPTIONAL MATCH, so a typo in
 * either would silently drop the edge and turn a narrow rule into one that applies everywhere.
 */
export async function setPolicy(
  g: TenantGraph,
  input: PolicyInput,
  opts: { userId?: string } = {},
): Promise<Policy> {
  const rule = input.rule.trim();
  if (!rule) throw new PolicyError('A policy needs a rule a person can read');
  if (!input.tool && !input.entity) {
    throw new PolicyError(
      'A policy must name a tool, an entity, or both; it would match every call',
    );
  }
  if (input.agentId) {
    const { rows } = await listAgents(g, {});
    if (!rows.some((a) => a.id === input.agentId)) {
      throw new PolicyError(`Unknown agent ${input.agentId}`);
    }
  }
  if (input.entity) {
    const [found] = await getMany(g, [input.entity]);
    if (!found) throw new PolicyError(`Unknown entity ${input.entity.type}:${input.entity.key}`);
  }

  const policy = PolicySchema.parse({
    ...input,
    rule,
    id: newId('pol'),
    ts: Date.now(),
  });
  await createPolicy(g, {
    policyId: policy.id,
    userId: opts.userId ?? 'ayush',
    rule: policy.rule,
    kind: policy.kind,
    tool: policy.tool,
    agentId: policy.agentId,
    entityType: policy.entity?.type ?? null,
    entityKey: policy.entity?.key ?? null,
    createdFromPlanId: policy.createdFromPlanId,
    ts: policy.ts,
  });
  return policy;
}
