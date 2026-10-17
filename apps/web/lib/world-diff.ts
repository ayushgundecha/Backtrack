/**
 * What changed between two world snapshots, and whether it was a revert. Pure, so the flash rules
 * are tested without a browser. The world panel only animates what this returns: a field flashes
 * because its value in GET /api/world differs from the previous read, never on a guess.
 */
import type { WorldSnapshot } from '@backtrack/core/contracts';
import type { SessionState } from './session';

type Entity = WorldSnapshot['entities'][number];

export type FieldFlash = 'changed' | 'restored';

export interface WorldDiff {
  /** Entity ids (`type:key`) that appeared. */
  created: string[];
  /** Entity ids that disappeared (deleted, or a create that was undone). */
  deleted: string[];
  /** Per entity id, the state fields whose value differs, and how to flash them. */
  fields: Record<string, Record<string, FieldFlash>>;
}

export const entityId = (e: { type: string; key: string }) => `${e.type}:${e.key}`;

/** Key order does not make a change: compare values in a canonical form. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Diffs two reads of the world. Returns null when there is nothing honest to animate: the first
 * read, a different tenant, or a different point in time (the time scrubber moves `asOfSeq`, and
 * travelling through history is not a change to the world).
 */
export function diffWorld(
  prev: WorldSnapshot | null,
  next: WorldSnapshot,
  revert: boolean,
): WorldDiff | null {
  if (!prev || prev.tenant !== next.tenant || prev.asOfSeq !== next.asOfSeq) return null;
  const before = new Map<string, Entity>(prev.entities.map((e) => [entityId(e), e]));
  const after = new Map<string, Entity>(next.entities.map((e) => [entityId(e), e]));
  const flash: FieldFlash = revert ? 'restored' : 'changed';
  const diff: WorldDiff = { created: [], deleted: [], fields: {} };

  for (const [id, entity] of after) {
    const old = before.get(id);
    if (!old) {
      diff.created.push(id);
      continue;
    }
    const keys = new Set([...Object.keys(old.state), ...Object.keys(entity.state)]);
    const changed: Record<string, FieldFlash> = {};
    for (const key of keys) {
      if (canonical(old.state[key]) !== canonical(entity.state[key])) changed[key] = flash;
    }
    if (Object.keys(changed).length > 0) diff.fields[id] = changed;
  }
  for (const id of before.keys()) if (!after.has(id)) diff.deleted.push(id);
  return diff;
}

export const isEmptyDiff = (diff: WorldDiff | null) =>
  !diff ||
  (diff.created.length === 0 && diff.deleted.length === 0 && Object.keys(diff.fields).length === 0);

/**
 * How far the current undo has got: the plan and how many of its steps finished. When this moves
 * between two world reads, the change between them was made by an undo step (only one stream runs
 * at a time), so it flashes green. undo.step names one entity per step, but a step can restore
 * several (post_message → the message and the ticket's thread), which is why the whole read counts.
 */
export function undoProgress(session: SessionState): string {
  const undo = session.undo;
  if (!undo) return '';
  const finished = Object.values(undo.steps).filter(
    (s) => s.status === 'done' || s.status === 'skipped',
  ).length;
  return `${undo.planId}:${finished}`;
}

/** A read is a revert when an undo step finished since the previous read (not when it reset). */
export const isRevert = (previousProgress: string, progress: string) =>
  progress !== '' && progress !== previousProgress;
