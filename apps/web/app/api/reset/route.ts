import { createHash, timingSafeEqual } from 'node:crypto';
import { api, openTenant, resetTenant } from '@backtrack/core';
import { HttpError, json, parseBody, route, tenantGraph } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hashing first gives equal-length buffers, so the comparison time says nothing about the token.
const digest = (s: string) => createHash('sha256').update(s).digest();

/** POST /api/reset: drop the tenant graph and rebuild schema, actors and the seeded world. */
export const POST = route(async (req) => {
  const { tenant, token } = await parseBody(req, api.reset.body);
  const expected = process.env.RESET_TOKEN;
  if (!expected) throw new HttpError(503, 'Reset is disabled: RESET_TOKEN is not configured');
  if (!timingSafeEqual(digest(token), digest(expected))) {
    throw new HttpError(401, 'Wrong reset token');
  }
  await tenantGraph(tenant); // validates the tenant name before anything is dropped
  const { seededAt } = await resetTenant(openTenant(tenant));
  return json(api.reset.response, { ok: true, seededAt });
});
