/**
 * Small, dependency-free helpers for building safe Cypher.
 *
 * Why: every value goes in as a parameter. The single exception FalkorDB forces on us is the
 * variable-length bound (`*1..$depth` is a server error, see docs/spike-results.md), so the only
 * thing that may be interpolated into query text is a `Depth` produced by `depth()`, which clamps
 * to an integer in 1..10. The `cypher` tag enforces that at runtime.
 */
import type { Params } from './client.js';

export const MIN_DEPTH = 1;
export const MAX_DEPTH = 10;

const DEPTH = Symbol('depth');
/** A clamped integer that may be interpolated into Cypher text (and nothing else may). */
export interface Depth {
  readonly [DEPTH]: true;
  readonly value: number;
}

export function depth(n: number): Depth {
  const value = Number.isFinite(n) ? Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.trunc(n))) : 1;
  return { [DEPTH]: true, value };
}

const isDepth = (v: unknown): v is Depth =>
  typeof v === 'object' && v !== null && (v as Partial<Depth>)[DEPTH] === true;

/**
 * Tagged template for query text. Interpolating anything but a `Depth` throws, so a user- or
 * model-supplied string can never end up inside the Cypher; it has to travel as a parameter.
 */
export function cypher(strings: TemplateStringsArray, ...values: Depth[]): string {
  return strings.reduce((out, part, i) => {
    if (i === 0) return part;
    const v: unknown = values[i - 1];
    if (!isDepth(v)) throw new TypeError('cypher`…`: only depth() literals may be interpolated');
    return `${out}${v.value}${part}`;
  }, '');
}

/**
 * Canonical JSON: object keys sorted at every level. Entity state, args and effect values are
 * stored as JSON strings, and Q14 compares stored strings, so equal values must serialise equally.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

/** Parse a JSON string read back from the graph; `null`/missing stays `null`. */
export function parseJson<T = unknown>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw as T;
  return JSON.parse(raw) as T;
}

type Primitive = string | number | boolean | null;

/**
 * Turn arbitrary values into FalkorDB-safe parameters: primitives and arrays of primitives pass
 * through; objects (and arrays containing objects) become canonical JSON strings; `undefined`
 * becomes `null`. Nested maps are not reliable as parameters (spike), so this is the only path in.
 */
export function toParams(input: Record<string, unknown>): Params {
  const out: Params = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = toParam(value);
  }
  return out;
}

function toParam(value: unknown): Params[string] {
  if (value === undefined || value === null) return null;
  if (isPrimitive(value)) return value;
  if (Array.isArray(value) && value.every((v) => v === null || isPrimitive(v))) {
    return value as Primitive[];
  }
  return stableStringify(value);
}

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
