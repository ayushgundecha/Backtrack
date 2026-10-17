import { describe, expect, it } from 'vitest';
import { clientKey, oversizedField, RateLimiter } from '@/lib/limits';

describe('limits', () => {
  it('allows `limit` requests per key per minute, then says how long to wait', () => {
    const rl = new RateLimiter();
    const t0 = 1_000_000;
    expect(rl.take('a', 2, t0)).toEqual({ ok: true });
    expect(rl.take('a', 2, t0 + 10_000)).toEqual({ ok: true });
    // The window frees up when the first request is a minute old: 50 s from now.
    expect(rl.take('a', 2, t0 + 10_000)).toEqual({ ok: false, retryAfterS: 50 });
    expect(rl.take('b', 2, t0 + 10_000)).toEqual({ ok: true });
    expect(rl.take('a', 2, t0 + 60_001)).toEqual({ ok: true });
  });

  it('caps text fields by name', () => {
    expect(oversizedField({ goal: 'x'.repeat(500), text: 'y'.repeat(300) })).toBeNull();
    expect(oversizedField({ goal: 'x'.repeat(501) })).toBe('goal is longer than 500 characters');
    expect(oversizedField({ planId: 'p'.repeat(201) })).toBe(
      'planId is longer than 200 characters',
    );
  });

  it('keys clients by the first forwarded address', () => {
    const req = (headers: Record<string, string>) => new Request('http://x/', { headers });
    expect(clientKey(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientKey(req({}))).toBe('local');
  });
});
