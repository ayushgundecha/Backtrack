import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunFixture, WorldSeed } from '../src/contracts/fixtures.js';

const root = resolve(import.meta.dirname, '../../../fixtures');
const read = (f: string) => JSON.parse(readFileSync(resolve(root, f), 'utf8'));

describe('fixtures match the contracts', () => {
  it('world seed validates and has fixed, unique ids', () => {
    const seed = WorldSeed.parse(read('world-seed.json'));
    expect(seed.customers).toHaveLength(10);
    expect(seed.orders).toHaveLength(20);
    expect(new Set(seed.orders.map((o) => o.id)).size).toBe(20);
    expect(seed.orders[0]?.id).toBe('ord_1001');
    expect(seed.orders[0]?.customerId).toBe('cust_42');
  });

  it('ops run validates and gates exactly once, on send_email', () => {
    const run = RunFixture.parse(read('ops-run.json'));
    expect(run.agentId).toBe('ops-agent');
    expect(run.steps.map((s) => s.tool)).toEqual([
      'lookup_order',
      'update_address',
      'create_ticket',
      'post_message',
      'send_email',
      'schedule_followup',
    ]);
    const gated = run.steps.filter((s) => s.expectGate === 'user-approval');
    expect(gated.map((s) => s.tool)).toEqual(['send_email']);
  });

  it('billing run validates and only references earlier steps', () => {
    const run = RunFixture.parse(read('billing-run.json'));
    run.steps.forEach((step, i) => {
      for (const v of Object.values(step.args)) {
        if (typeof v === 'object' && v !== null && '$ref' in v) {
          const idx = Number(v.$ref.split('.')[1]);
          expect(idx).toBeLessThan(i);
        }
      }
    });
  });
});
