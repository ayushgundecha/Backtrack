/**
 * Pure helpers behind the graph view: which snapshot nodes and links are drawn, and which of them
 * light up for a selected action. Nothing here traverses DEPENDS_ON itself: the closure is read
 * from the UndoOutcome that POST /api/undo returned (Q1 for membership and hops, Q3 for the blast
 * radius), so what lights up is exactly what the graph answered at that depth.
 */
import type { BlastRadius, GraphSnapshot, UndoOutcome } from '@backtrack/core/contracts';
import { familyOf, type ToolFamily } from './tools';

type SnapshotNode = GraphSnapshot['nodes'][number];

/** Link types the canvas draws. Run/Step/plan bookkeeping stays in the snapshot, off screen. */
export const DRAWN_LINKS = ['DEPENDS_ON', 'CAUSED', 'READ', 'UNDOES'] as const;
export type DrawnLinkType = (typeof DRAWN_LINKS)[number];

export interface ViewNode {
  id: string;
  kind: 'action' | 'entity';
  title: string;
  status: string;
  tool?: string;
  family?: ToolFamily;
  seq?: number;
  agentId?: string;
  /** do | undo | mitigation: undo-side actions are drawn smaller. */
  actionKind?: string;
  reversible?: boolean;
}

export interface ViewLink {
  source: string;
  target: string;
  type: DrawnLinkType;
}

export interface ViewGraph {
  nodes: ViewNode[];
  links: ViewLink[];
  /** Changes only when a node or link is added or removed, so the layout is not re-heated otherwise. */
  structureKey: string;
}

export const linkKey = (source: string, target: string, type: string) =>
  `${source}>${type}>${target}`;

const isDrawn = (type: string): type is DrawnLinkType =>
  (DRAWN_LINKS as readonly string[]).includes(type);

function toViewNode(node: SnapshotNode): ViewNode {
  if (node.label === 'Entity') {
    return { id: node.id, kind: 'entity', title: node.title, status: node.status ?? 'present' };
  }
  return {
    id: node.id,
    kind: 'action',
    title: node.title,
    status: node.status ?? 'done',
    tool: node.tool,
    family: familyOf(node.tool),
    seq: node.seq,
    agentId: node.agentId,
    actionKind: node.kind,
    reversible: node.reversible,
  };
}

/** Actions and entities with the links between them; everything else in the snapshot is dropped. */
export function toViewGraph(snapshot: GraphSnapshot): ViewGraph {
  const nodes = snapshot.nodes
    .filter((n) => n.label === 'Action' || n.label === 'Entity')
    .map(toViewNode);
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const links: ViewLink[] = [];
  for (const link of snapshot.links) {
    if (!isDrawn(link.type) || !ids.has(link.source) || !ids.has(link.target)) continue;
    const key = linkKey(link.source, link.target, link.type);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: link.source, target: link.target, type: link.type });
  }
  const structureKey = `${nodes.map((n) => n.id).join(',')}|${[...seen].join(',')}`;
  return { nodes, links, structureKey };
}

/** One element of a dependency path: an action we can name from the snapshot, or the raw text. */
export type PathHop =
  | { kind: 'action'; id: string; tool: string; seq: number }
  | { kind: 'text'; text: string };

/**
 * `UndoStep.via` is a list of strings whose form the contract leaves open: the real /api/undo
 * sends tool names from the root to the dependent (both included); the mock has sent action ids.
 * Either way the path is resolved against the snapshot's own DEPENDS_ON links so every chip names
 * a real action. Ids are taken as they are, ordered by seq (DEPENDS_ON always points to a smaller
 * seq, so ascending seq is root → dependent). Tool names are matched hop by hop along the links
 * from the root to the dependent. If neither fits, the strings are shown as sent.
 */
export function normalizePath(
  via: string[],
  snapshot: GraphSnapshot,
  ends?: { rootId: string; memberId: string },
): PathHop[] {
  const actions = new Map(
    snapshot.nodes.filter((n) => n.label === 'Action').map((n) => [n.id, n] as const),
  );
  const hop = (n: SnapshotNode): PathHop => ({
    kind: 'action',
    id: n.id,
    tool: n.tool ?? n.title,
    seq: n.seq ?? 0,
  });
  const byId = via.map((id) => actions.get(id));
  if (via.length > 0 && byId.every((n) => n !== undefined)) {
    return (byId as SnapshotNode[]).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(hop);
  }
  if (ends) {
    const ids = matchToolPath(via, snapshot, ends.rootId, ends.memberId);
    if (ids) return ids.map((id) => hop(actions.get(id) as SnapshotNode));
  }
  return via.map((text) => ({ kind: 'text' as const, text }));
}

/** Action ids root → member whose tools spell `tools`, walking DEPENDS_ON from dependency to dependent. */
function matchToolPath(
  tools: string[],
  snapshot: GraphSnapshot,
  rootId: string,
  memberId: string,
): string[] | null {
  const toolOf = new Map(
    snapshot.nodes.filter((n) => n.label === 'Action').map((n) => [n.id, n.tool ?? n.title]),
  );
  // dependents.get(x): the actions with a DEPENDS_ON edge to x.
  const dependents = new Map<string, string[]>();
  for (const l of snapshot.links) {
    if (l.type !== 'DEPENDS_ON') continue;
    dependents.set(l.target, [...(dependents.get(l.target) ?? []), l.source]);
  }
  if (tools.length === 0 || toolOf.get(rootId) !== tools[0]) return null;
  const walk = (at: string, index: number, path: string[]): string[] | null => {
    if (index === tools.length - 1) return at === memberId ? path : null;
    for (const next of dependents.get(at) ?? []) {
      if (toolOf.get(next) !== tools[index + 1] || path.includes(next)) continue;
      const found = walk(next, index + 1, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(rootId, 0, [rootId]);
}

export interface ClosureMember {
  actionId: string;
  tool: string;
  seq: number;
  agentId: string;
  hops: number;
  path: PathHop[];
}

export interface Closure {
  rootId: string;
  depth: number;
  outcome: UndoOutcome['kind'];
  /** Dependents of the root within `depth` hops (Q1), nearest first. Excludes the root. */
  members: ClosureMember[];
  /** Node ids to keep at full opacity: root, dependents, actions on their paths, blast entities. */
  lit: Set<string>;
  /** linkKey()s to keep lit: DEPENDS_ON between lit actions, CAUSED from them to blast entities. */
  litLinks: Set<string>;
  blast: BlastRadius | null;
  crossAgents: string[];
  planId: string | null;
  /** Why there is no plan (outcome none / memory / unknown), in the server's words when it gave some. */
  note: string | null;
}

/** Folds the outcome of POST /api/undo { actionId, depth } into what the graph view lights up. */
export function closureFromOutcome(
  outcome: UndoOutcome,
  rootId: string,
  depth: number,
  snapshot: GraphSnapshot,
): Closure {
  const base: Closure = {
    rootId,
    depth,
    outcome: outcome.kind,
    members: [],
    lit: new Set([rootId]),
    litLinks: new Set(),
    blast: null,
    crossAgents: [],
    planId: null,
    note: null,
  };
  if (outcome.kind === 'none') return { ...base, note: outcome.reason };
  if (outcome.kind === 'memory') {
    const n = outcome.priorPlans.length;
    return {
      ...base,
      note:
        n > 0
          ? `Already undone (${n} earlier ${n === 1 ? 'plan' : 'plans'}); nothing left to plan.`
          : 'Already undone; nothing left to plan.',
    };
  }
  if (outcome.kind === 'unknown') {
    return { ...base, note: `No action matched “${outcome.query}”.` };
  }

  const { plan } = outcome;
  const members = plan.steps
    .filter((s) => s.actionId !== rootId)
    .map((s) => ({
      actionId: s.actionId,
      tool: s.tool,
      seq: s.seq,
      agentId: s.agentId,
      hops: s.hops,
      path: normalizePath(s.via, snapshot, { rootId, memberId: s.actionId }),
    }))
    .sort((a, b) => a.hops - b.hops || a.seq - b.seq);

  const lit = new Set<string>([rootId]);
  for (const m of members) {
    lit.add(m.actionId);
    for (const hop of m.path) if (hop.kind === 'action') lit.add(hop.id);
  }
  const blastEntities = new Set(plan.blast.entities);
  const litLinks = new Set<string>();
  for (const link of snapshot.links) {
    if (link.type === 'DEPENDS_ON' && lit.has(link.source) && lit.has(link.target)) {
      litLinks.add(linkKey(link.source, link.target, link.type));
    }
    if (link.type === 'CAUSED' && lit.has(link.source) && blastEntities.has(link.target)) {
      litLinks.add(linkKey(link.source, link.target, link.type));
    }
  }
  for (const entity of blastEntities) lit.add(entity);

  return {
    ...base,
    members,
    lit,
    litLinks,
    blast: plan.blast,
    crossAgents: [...new Set(plan.crossAgent.map((c) => c.agentId))],
    planId: plan.id,
  };
}

/** Actions in seq order: the order the keyboard walks the graph in. */
export function actionsBySeq(snapshot: GraphSnapshot): SnapshotNode[] {
  return snapshot.nodes
    .filter((n) => n.label === 'Action')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** The action `step` places away from `currentId` in seq order, wrapping at both ends. */
export function stepSelection(
  snapshot: GraphSnapshot,
  currentId: string | null,
  step: 1 | -1,
): string | null {
  const ordered = actionsBySeq(snapshot);
  if (ordered.length === 0) return null;
  const index = ordered.findIndex((n) => n.id === currentId);
  if (index === -1) return (step === 1 ? ordered[0] : ordered.at(-1))?.id ?? null;
  return ordered[(index + step + ordered.length) % ordered.length]?.id ?? null;
}

/** A tenant-shaped synthetic snapshot for the frame-rate check: n actions over agents and entities. */
export function syntheticSnapshot(actionCount: number, entityCount: number): GraphSnapshot {
  const tools = ['lookup_order', 'update_address', 'create_ticket', 'post_message', 'send_email'];
  const nodes: GraphSnapshot['nodes'] = [];
  const links: GraphSnapshot['links'] = [];
  // A fixed LCG, so the check renders the same graph every time.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let e = 0; e < entityCount; e++) {
    nodes.push({ id: `entity:${e}`, label: 'Entity', title: `entity ${e}`, status: 'present' });
  }
  for (let i = 1; i <= actionCount; i++) {
    const tool = tools[i % tools.length] as string;
    const id = `act_${i}`;
    nodes.push({
      id,
      label: 'Action',
      title: tool,
      tool,
      seq: i,
      status: i % 17 === 0 ? 'undone' : 'done',
      kind: 'do',
      agentId: i % 3 === 0 ? 'billing-agent' : 'ops-agent',
      runId: 'run_synthetic',
      reversible: tool !== 'send_email',
    });
    links.push({
      source: id,
      target: `entity:${Math.floor(rand() * entityCount)}`,
      type: 'CAUSED',
    });
    if (i > 1) {
      // DEPENDS_ON points to a smaller seq, as in the real graph.
      const deps = 1 + Math.floor(rand() * 2);
      for (let d = 0; d < deps; d++) {
        const target = Math.max(1, i - 1 - Math.floor(rand() * 12));
        links.push({ source: id, target: `act_${target}`, type: 'DEPENDS_ON' });
      }
    }
  }
  return { nodes, links };
}
