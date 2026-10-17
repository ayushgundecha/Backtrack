import { api, setPolicy } from '@backtrack/core';
import { json, parseBody, rateLimit, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/policy: record a "never again" rule the gate checks before every later call (Q5). */
export const POST = route(async (req) => {
  rateLimit(req, 'policy');
  const { tenant, ...input } = await parseBody(req, api.policy.body);
  const policy = await setPolicy(await tenantGraph(tenant), input);
  return json(api.policy.response, policy, 201);
});
