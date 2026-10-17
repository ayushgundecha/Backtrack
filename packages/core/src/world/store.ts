/**
 * Read access to the world (Entity.state) plus the pure state transitions the recorder applies.
 *
 * Tools never write the world directly: they return EffectDrafts and the recorder applies them in
 * the same statement that records the action, so the world and its history cannot disagree.
 */
import type { EffectDraft, EntityRef, WorldSnapshot } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { parseJson, stableStringify } from '../graph/cypher.js';
import {
  countEntities,
  type EntityRow,
  effectsAfterSeq,
  getEntities,
  listEntities,
  upsertEntities,
} from '../graph/queries.js';
import { displayOf, type EntityStateByType, type EntityType, KEY_PREFIX } from './types.js';

export type State = Record<string, unknown>;

export interface StoredEntity {
  ref: EntityRef;
  /** null when the entity was deleted (or undone back to non-existence). */
  state: State | null;
}

const toStored = (row: EntityRow): StoredEntity => ({
  ref: { type: row.type, key: row.key, display: row.display ?? displayOf(row.type, row.key) },
  state: parseJson<State>(row.state),
});

export async function getEntity<T extends EntityType>(
  g: TenantGraph,
  type: T,
  key: string,
): Promise<EntityStateByType[T] | null> {
  const [found] = await getMany(g, [{ type, key }]);
  return (found?.state as unknown as EntityStateByType[T] | null | undefined) ?? null;
}

export async function getMany(
  g: TenantGraph,
  refs: Array<Pick<EntityRef, 'type' | 'key'>>,
): Promise<StoredEntity[]> {
  if (refs.length === 0) return [];
  const { rows } = await getEntities(g, {
    types: refs.map((r) => r.type),
    keys: refs.map((r) => r.key),
  });
  return rows.map(toStored);
}

export async function listByType<T extends EntityType>(
  g: TenantGraph,
  type: T,
): Promise<Array<EntityStateByType[T]>> {
  const { rows } = await listEntities(g, { type });
  return rows
    .map(toStored)
    .filter((e) => e.state !== null)
    .map((e) => e.state as unknown as EntityStateByType[T]);
}

/**
 * Write an entity's state directly, outside any action. Only for seeding and for simulating a
 * human edit between a run and its undo (which Q14 must then detect as a conflict).
 */
export async function setEntity(
  g: TenantGraph,
  ref: Pick<EntityRef, 'type' | 'key'>,
  state: State | null,
): Promise<void> {
  await upsertEntities(g, {
    types: [ref.type],
    keys: [ref.key],
    displays: [displayOf(ref.type, ref.key)],
    states: [stableStringify(state)],
  });
}

/** Readable, repeatable keys for created entities: tkt_1, msg_1, … */
export async function nextKey(g: TenantGraph, type: keyof typeof KEY_PREFIX): Promise<string> {
  const { rows } = await countEntities(g, { type });
  return `${KEY_PREFIX[type]}_${(rows[0]?.n ?? 0) + 1}`;
}

/** The new state of an entity after one effect (pure; the recorder chains these). */
export function applyEffect(state: State | null, effect: EffectDraft): State | null {
  if (effect.kind === 'delete') return null;
  if (effect.field === null) return (effect.after as State | null) ?? null;
  return { ...(state ?? {}), [effect.field]: effect.after };
}

/**
 * The world now, or as it was right after action `asOfSeq` (time scrubber). Rolling back from
 * the current state applies every later Effect's `before`, newest first; that is the same fold
 * an undo performs, so a scrubber frame always matches what an undo to that point would produce.
 */
export async function worldSnapshot(
  g: TenantGraph,
  asOfSeq: number | null = null,
): Promise<WorldSnapshot & { traces: { cypher: string; ms: number; rows: number }[] }> {
  const all = await listEntities(g, { type: null });
  const states = new Map(all.rows.map((r) => [`${r.type}:${r.key}`, toStored(r)]));
  const traces = [{ cypher: all.cypher, ms: all.ms, rows: all.rows.length }];
  if (asOfSeq !== null) {
    const later = await effectsAfterSeq(g, { seq: asOfSeq });
    traces.push({ cypher: later.cypher, ms: later.ms, rows: later.rows.length });
    for (const f of later.rows) {
      const entity = states.get(`${f.type}:${f.key}`);
      if (!entity) continue;
      const before = parseJson(f.before);
      entity.state =
        f.field === null
          ? (before as State | null)
          : { ...(entity.state ?? {}), [f.field]: before };
    }
  }
  return {
    tenant: g.tenant,
    asOfSeq,
    entities: [...states.values()]
      .filter((e) => e.state !== null)
      .map((e) => ({
        type: e.ref.type,
        key: e.ref.key,
        display: e.ref.display ?? displayOf(e.ref.type, e.ref.key),
        state: e.state as State,
      })),
    traces,
  };
}
