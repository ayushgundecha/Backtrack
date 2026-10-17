/**
 * Public-URL guards: body size, text length and per-client request rates.
 *
 * Why in memory: these only need to stop casual abuse of a demo, and a serverless instance's
 * memory is enough for that. What must hold across instances (one run at a time per tenant) is
 * checked in the graph instead (see `assertIdle` in server.ts).
 */

/** Largest JSON body any route accepts; the biggest legitimate one (a policy) is well under 1 KB. */
export const MAX_BODY_BYTES = 8 * 1024;

/** Longest accepted value per text field; anything else defaults to MAX_TEXT. */
export const TEXT_CAPS: Record<string, number> = { goal: 500, text: 300, rule: 200 };
export const MAX_TEXT = 200;

/** First field over its cap, as a message, or null when every string fits. */
export function oversizedField(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  for (const [field, value] of Object.entries(body)) {
    const cap = TEXT_CAPS[field] ?? MAX_TEXT;
    if (typeof value === 'string' && value.length > cap) {
      return `${field} is longer than ${cap} characters`;
    }
  }
  return null;
}

/** Requests per client per minute, for the routes that write or run something. */
export const RATE_LIMITS = {
  agent: 6,
  approval: 30,
  undo: 30,
  'undo-execute': 6,
  rehearse: 10,
  policy: 10,
  reset: 3,
} as const;
export type LimitedRoute = keyof typeof RATE_LIMITS;

const WINDOW_MS = 60_000;

/** A sliding one-minute window per key. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Count a request; returns the seconds to wait when the key is over its limit. */
  take(
    key: string,
    limit: number,
    now = Date.now(),
  ): { ok: true } | { ok: false; retryAfterS: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Keep memory bounded on a long-lived instance.
    if (this.hits.size > 10_000) this.hits.clear();
    return { ok: true };
  }
}

/** Who is asking: the first address a proxy recorded, or "local" in development. */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('x-real-ip')?.trim() || 'local';
}
