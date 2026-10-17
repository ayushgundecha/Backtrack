/**
 * Rehearsal: run an undo plan on a throwaway copy of the tenant graph and report the diff.
 *
 * Why GRAPH.COPY: the plan, the history and the world are all in the graph, so one copy gives
 * a complete sandbox; executing the real engine there shows exactly what Confirm would do, and
 * deleting the copy leaves no trace. The live graph only learns that the plan was rehearsed.
 */
import type { RehearsalDiff } from '../contracts/types.js';
import { openTenant, type TenantGraph } from '../graph/client.js';
import { parseJson } from '../graph/cypher.js';
import { q15PlanEntities, setPlanStatus } from '../graph/queries.js';
import type { State } from '../world/store.js';
import { displayOf } from '../world/types.js';
import type { ToolRegistry } from './registry.js';
import { type QueryTrace, traceOf } from './trace.js';
import { executeUndo } from './undo.js';

export const forkTenant = (tenant: string, planId: string) => `${tenant}:fork:${planId}`;

export async function rehearseUndo(
  g: TenantGraph,
  planId: string,
  opts: { registry?: ToolRegistry } = {},
): Promise<RehearsalDiff & { status: string; traces: QueryTrace[] }> {
  const forkName = forkTenant(g.tenant, planId);
  // A fork left behind by a crashed rehearsal would make GRAPH.COPY fail; start clean.
  await openTenant(forkName).drop();
  const fork = await g.copyTo(forkName);
  try {
    const live = await q15PlanEntities(g, { planId });
    const result = await executeUndo(fork, planId, { registry: opts.registry, paceMs: 0 });
    const after = await q15PlanEntities(fork, { planId });
    await setPlanStatus(g, { planId, status: 'rehearsed' });
    return {
      planId,
      forkGraph: fork.name,
      changes: diffStates(live.rows, after.rows),
      status: result.status,
      traces: [traceOf('Q15', live), traceOf('Q15', after)],
    };
  } finally {
    await fork.drop();
  }
}

type Row = { type: string; key: string; state: string | null };

/**
 * Field-level differences between two sets of entity states. An entity that appears or
 * disappears is one change with `field: null`; otherwise each changed top-level field is one.
 */
export function diffStates(before: Row[], after: Row[]): RehearsalDiff['changes'] {
  const index = (rows: Row[]) =>
    new Map(rows.map((r) => [`${r.type}:${r.key}`, { ...r, parsed: parseJson<State>(r.state) }]));
  const a = index(before);
  const b = index(after);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const changes: RehearsalDiff['changes'] = [];
  for (const k of keys) {
    const from = a.get(k)?.parsed ?? null;
    const to = b.get(k)?.parsed ?? null;
    const [type = '', key = ''] = k.split(':');
    const entity = { type, key, display: displayOf(type, key) };
    if (from === null || to === null) {
      if (from !== to) changes.push({ entity, field: null, from, to });
      continue;
    }
    for (const field of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
      if (JSON.stringify(from[field]) !== JSON.stringify(to[field])) {
        changes.push({ entity, field, from: from[field] ?? null, to: to[field] ?? null });
      }
    }
  }
  return changes;
}
