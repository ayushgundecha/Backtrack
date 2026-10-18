/**
 * Tenants are graphs: `bt:<tenant>` (AGENTS.md rule 7). The name is checked here, on both sides of
 * the wire: the routes refuse anything else (lib/server.ts), and the panel says why before asking.
 * A strict slug keeps a caller off other graphs (`bt:demo:fork:…`, `bt:budget`) and out of the
 * query text.
 */

export const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const DEFAULT_TENANT = 'demo';

/** Tenants the panel offers by name: the demo graph and the isolation demo (README). */
export const KNOWN_TENANTS = ['demo', 'acme'] as const;

export const graphName = (tenant: string) => `bt:${tenant}`;

/** Why a name is not a tenant, in words for the form; null when it is one. */
export function tenantProblem(name: string): string | null {
  if (name === '') return 'Enter a tenant name.';
  if (name.length > 32) return 'Use at most 32 characters.';
  if (!TENANT_PATTERN.test(name)) {
    return 'Use lowercase letters, digits and dashes, starting with a letter or digit.';
  }
  return null;
}

/** The tenant a URL asks for (`?tenant=`), or the default when it names none or an invalid one. */
export function tenantFromQuery(value: string | string[] | undefined): string {
  const name = Array.isArray(value) ? value[0] : value;
  return name && TENANT_PATTERN.test(name) ? name : DEFAULT_TENANT;
}

/** The panel URL for a tenant; the default tenant keeps the bare URL. */
export const tenantHref = (tenant: string) =>
  tenant === DEFAULT_TENANT ? '/' : `/?tenant=${encodeURIComponent(tenant)}`;
