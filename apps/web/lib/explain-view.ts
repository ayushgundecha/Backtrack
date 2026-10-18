/**
 * What the explain drawer may say about an action, derived only from the Explain contract
 * (GET /api/explain, Q6), the graph snapshot it names actions from, and the Q1 closure the graph
 * view already asked for. Pure, so "nothing on screen claims what the graph cannot back" is tested.
 */
import type { Explain, GraphSnapshot } from '@backtrack/core/contracts';
import type { Closure, ClosureMember } from './graph-model';

export interface ActionRef {
  actionId: string;
  tool: string | null;
  seq: number | null;
}

/**
 * Who wrote what an action read. Q6 returns the writer's id and seq; its tool comes from the
 * action's own DEPENDS_ON list (the writer is a dependency by construction) or the snapshot. If
 * neither names it, the id is shown as is rather than guessed.
 */
export function writerOf(
  evidence: Explain['reads'][number],
  explain: Explain,
  snapshot: GraphSnapshot | null,
): ActionRef | null {
  if (!evidence.writtenBy) return null;
  const dep = explain.dependsOn.find((d) => d.actionId === evidence.writtenBy);
  if (dep) return { actionId: dep.actionId, tool: dep.tool, seq: dep.seq };
  const node = snapshot?.nodes.find((n) => n.id === evidence.writtenBy);
  return {
    actionId: evidence.writtenBy,
    tool: node?.tool ?? null,
    seq: evidence.writtenAtSeq ?? node?.seq ?? null,
  };
}

/** Which Q1 paths the drawer can show for an action, given the graph's current selection. */
export type PathView =
  | { kind: 'no-selection' }
  /** The explained action is the selected root: every dependent's path to it. */
  | { kind: 'root'; depth: number; members: ClosureMember[] }
  /** The explained action depends on the selected root within the depth: its path. */
  | { kind: 'member'; depth: number; rootId: string; member: ClosureMember }
  /** Something else is selected and this action is not in its closure at that depth. */
  | { kind: 'outside'; depth: number; rootId: string }
  /**
   * The selection has no plan (already undone, read-only, unknown), so Q1 was never asked and
   * no path can be shown or denied; the closure's note says why.
   */
  | { kind: 'no-plan'; depth: number; note: string };

export function pathView(actionId: string, closure: Closure | null): PathView {
  if (!closure) return { kind: 'no-selection' };
  if (closure.outcome !== 'plan') {
    return { kind: 'no-plan', depth: closure.depth, note: closure.note ?? 'No plan to show.' };
  }
  if (closure.rootId === actionId) {
    return { kind: 'root', depth: closure.depth, members: closure.members };
  }
  const member = closure.members.find((m) => m.actionId === actionId);
  if (member) return { kind: 'member', depth: closure.depth, rootId: closure.rootId, member };
  return { kind: 'outside', depth: closure.depth, rootId: closure.rootId };
}

/** One-line JSON for before/after values; null reads as "empty", not as the string "null". */
export function brief(value: unknown, max = 80): string {
  if (value === null || value === undefined) return 'empty';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
