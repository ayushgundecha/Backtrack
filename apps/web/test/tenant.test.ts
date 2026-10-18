import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT,
  graphName,
  TENANT_PATTERN,
  tenantFromQuery,
  tenantHref,
  tenantProblem,
} from '../lib/tenant';

describe('tenant names', () => {
  it('accepts the slugs the routes accept and explains the rest', () => {
    for (const ok of ['demo', 'acme', 'web-c', '0', 'a'.repeat(32)]) {
      expect(tenantProblem(ok)).toBeNull();
      expect(TENANT_PATTERN.test(ok)).toBe(true);
    }
    expect(tenantProblem('')).toBe('Enter a tenant name.');
    expect(tenantProblem('a'.repeat(33))).toBe('Use at most 32 characters.');
    // Separators and uppercase would reach other graphs or other names (bt:demo:fork:…).
    for (const bad of ['Demo', '-demo', 'demo:fork', 'demo x', 'ümlaut', 'demo}']) {
      expect(tenantProblem(bad)).toMatch(/lowercase letters, digits and dashes/);
    }
  });

  it('reads the tenant from the URL and falls back to the demo graph', () => {
    expect(tenantFromQuery('acme')).toBe('acme');
    expect(tenantFromQuery(['acme', 'demo'])).toBe('acme');
    expect(tenantFromQuery(undefined)).toBe(DEFAULT_TENANT);
    expect(tenantFromQuery('bt:acme')).toBe(DEFAULT_TENANT);
    expect(tenantHref('demo')).toBe('/');
    expect(tenantHref('acme')).toBe('/?tenant=acme');
    expect(graphName('acme')).toBe('bt:acme');
  });
});
