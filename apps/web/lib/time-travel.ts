/**
 * Pure helpers behind the time scrubber (PLAN §7.3, BT-047). The scrubber has one stop per
 * recorded action, plus one before the first and one for now. A stop at seq N asks
 * GET /api/world?asOfSeq=N, which folds the later Effects back by their `before`; nothing here
 * computes a world itself. What dims in the graph is read off the snapshot (actions with a later
 * seq) and off that frame (entities that did not exist yet, or no longer did).
 */
import type { GraphSnapshot, WorldSnapshot } from '@backtrack/core/contracts';
import { agentName } from './tools';
import { entityId } from './world-diff';

export interface TimelineAction {
  id: string;
  seq: number;
  tool: string;
  agentId: string | null;
  /** do | undo | mitigation */
  kind: string | null;
  status: string | null;
}

/** The scrubber's stops: before everything, after each action in seq order, then now. */
export type Stop =
  | { kind: 'start'; asOfSeq: number }
  | { kind: 'action'; asOfSeq: number; action: TimelineAction }
  | { kind: 'now'; asOfSeq: null };

/** Every recorded action, oldest first. Undo steps are actions too and get their own stop. */
export function timeline(snapshot: GraphSnapshot | null): TimelineAction[] {
  if (!snapshot) return [];
  const bySeq = new Map<number, TimelineAction>();
  for (const n of snapshot.nodes) {
    if (n.label !== 'Action' || n.seq === undefined || bySeq.has(n.seq)) continue;
    bySeq.set(n.seq, {
      id: n.id,
      seq: n.seq,
      tool: n.tool ?? n.title,
      agentId: n.agentId ?? null,
      kind: n.kind ?? null,
      status: n.status ?? null,
    });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Stops for a timeline. "Now" is its own stop rather than the last action's: the live read has no
 * asOfSeq, so it also shows a state written outside any action (a human edit) that a fold cannot.
 */
export function stops(actions: TimelineAction[]): Stop[] {
  const first = actions[0];
  if (!first) return [{ kind: 'now', asOfSeq: null }];
  return [
    { kind: 'start', asOfSeq: first.seq - 1 },
    ...actions.map((action): Stop => ({ kind: 'action', asOfSeq: action.seq, action })),
    { kind: 'now', asOfSeq: null },
  ];
}

/** Index of the stop for asOfSeq: the latest action at or before it, now for null. */
export function stopIndex(all: Stop[], asOfSeq: number | null): number {
  if (asOfSeq === null) return all.length - 1;
  let index = 0;
  for (const [i, stop] of all.entries()) {
    if (stop.asOfSeq !== null && stop.asOfSeq <= asOfSeq) index = i;
  }
  return index;
}

/**
 * Graph node ids to dim while the scrubber is at asOfSeq: every action recorded after it, and
 * every entity drawn in the graph that the frame does not contain (created later, or already
 * deleted by then). Without a frame yet, only the actions are dimmed: the seq alone backs that.
 */
export function laterNodes(
  snapshot: GraphSnapshot,
  asOfSeq: number | null,
  frame: WorldSnapshot | null,
): Set<string> {
  const dim = new Set<string>();
  if (asOfSeq === null) return dim;
  const present = frame && frame.asOfSeq === asOfSeq ? new Set(frame.entities.map(entityId)) : null;
  for (const n of snapshot.nodes) {
    if (n.label === 'Action' && n.seq !== undefined && n.seq > asOfSeq) dim.add(n.id);
    if (n.label === 'Entity' && present && !present.has(n.id)) dim.add(n.id);
  }
  return dim;
}

/** What a stop is called, on screen and as the slider's spoken value. */
export function stopLabel(stop: Stop): string {
  if (stop.kind === 'now') return 'Now';
  if (stop.kind === 'start') return `Before seq ${stop.asOfSeq + 1}`;
  const { action } = stop;
  const who = action.agentId ? (agentName[action.agentId] ?? action.agentId) : null;
  const undo =
    action.kind === 'undo' || action.kind === 'mitigation' ? ` (${action.kind} step)` : '';
  return `After seq ${action.seq} · ${action.tool}${undo}${who ? ` · ${who}` : ''}`;
}
