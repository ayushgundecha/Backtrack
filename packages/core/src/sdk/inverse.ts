/**
 * Inverse tools: the compensations the undo engine runs for reversible actions.
 *
 * Every Effect stores `before` and `after` (invariant 2), so one generic restore serves every
 * reversible tool: put each changed field (or whole entity) back to `before`, newest effect first.
 * Each inverse still gets its own name (restore_address, close_ticket, …) so the plan, the graph
 * and the UI say what is being undone in the tool's own terms.
 */
import { z } from 'zod';
import type { EffectDraft, EntityRef } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { parseJson, stableStringify } from '../graph/cypher.js';
import { type ConflictRow, q14Conflicts } from '../graph/queries.js';
import type { State } from '../world/store.js';
import { displayOf } from '../world/types.js';
import { defineTool, type ToolDefinition, type TypedToolResult } from './registry.js';

const InverseInput = z.object({
  actionId: z.string().describe('The recorded action to revert'),
});

export interface Restored {
  actionId: string;
  restored: string[];
}

export function defineInverse(
  name: string,
  description: string,
): ToolDefinition<typeof InverseInput, Restored> {
  return defineTool({
    name,
    description,
    input: InverseInput,
    effect: 'compensation',
    run: async ({ g }, { actionId }) => restoreBefore(g, actionId),
  });
}

/** Writes that put everything `actionId` changed back to its `before` value. */
export async function restoreBefore(
  g: TenantGraph,
  actionId: string,
): Promise<TypedToolResult<Restored>> {
  const { rows } = await q14Conflicts(g, { actionId });
  const reads: EntityRef[] = [];
  const writes: EffectDraft[] = [];
  for (const row of [...rows].reverse()) {
    if (row.kind === 'external') {
      throw new Error(`${actionId} had an external effect on ${row.type}:${row.key}; mitigate it`);
    }
    const entity = {
      type: row.type,
      key: row.key,
      display: row.display ?? displayOf(row.type, row.key),
    };
    const state = parseJson<State>(row.state);
    const before = parseJson(row.before);
    reads.push(entity);
    writes.push(
      row.field === null
        ? {
            kind: before === null ? 'delete' : 'update',
            entity,
            field: null,
            before: state,
            after: before,
          }
        : {
            kind: 'update',
            entity,
            field: row.field,
            before: state?.[row.field] ?? null,
            after: before,
          },
    );
  }
  return {
    result: { actionId, restored: writes.map((w) => `${w.entity.type}:${w.entity.key}`) },
    reads,
    writes,
  };
}

/**
 * Q14's verdict for one effect: is the entity still exactly as the action left it? A field
 * effect compares that field; a whole-entity effect compares the canonical JSON of the state.
 * Later live writers are named in the reason when there are any.
 */
export function judgeConflict(row: ConflictRow): { clean: boolean; reason: string | null } {
  const state = parseJson<State>(row.state);
  const now =
    row.field === null ? stableStringify(state) : stableStringify(state?.[row.field] ?? null);
  if (now === row.after) return { clean: true, reason: null };
  const what =
    row.field === null ? `${row.type}:${row.key}` : `${row.type}:${row.key}.${row.field}`;
  const by = row.laterWriters.length
    ? `${row.laterWriters.map((w) => `${w.tool} (seq ${w.seq})`).join(', ')} changed it since`
    : 'it was changed outside Backtrack since';
  return { clean: false, reason: `${what} is no longer what this action wrote: ${by}` };
}
