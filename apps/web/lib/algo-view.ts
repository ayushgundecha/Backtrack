/**
 * Pure helpers behind the algorithm buttons (BT-04B): read the rows GET /api/algo returned for
 * Q8–Q11 and say what the graph view should light, rank and label. The contract types the rows
 * as open records, so each algorithm's row shape is checked here; a row that does not match is
 * an error on screen, not a guess.
 */
import type { GraphSnapshot } from '@backtrack/core/contracts';
import { z } from 'zod';
import type { AlgoRequest } from './api';
import { linkKey } from './graph-model';

export type AlgoName = AlgoRequest['name'];

/** What each button asks, in the words of its catalogue entry, and which query answers it. */
export const ALGOS: Record<AlgoName, { label: string; query: string; question: string }> = {
  load_bearing: {
    label: 'Load-bearing',
    query: 'Q8 · algo.pageRank',
    question: 'Which actions does the most other work rest on?',
  },
  hinge_actions: {
    label: 'Hinges',
    query: 'Q9 · algo.betweenness',
    question: 'Which actions sit on the most dependency paths between other actions?',
  },
  independent_clusters: {
    label: 'Clusters',
    query: 'Q10 · algo.wcc',
    question: 'Which groups of actions are independent, so undoing one cannot touch another?',
  },
  path_between: {
    label: 'Path between',
    query: 'Q11 · algo.SPpaths',
    question: 'How does a later action depend on an earlier one?',
  },
};

const RankedRow = z.object({
  id: z.string(),
  tool: z.string(),
  seq: z.number(),
  status: z.string().nullish(),
  agentId: z.string().nullish(),
  score: z.number(),
});
const ClusterRow = z.object({
  componentId: z.number(),
  size: z.number(),
  actions: z.array(z.object({ id: z.string(), tool: z.string(), seq: z.number() })),
});
const PathRow = z.object({
  ids: z.array(z.string()),
  tools: z.array(z.string()),
  pathWeight: z.number(),
});

export interface Ranked {
  id: string;
  tool: string;
  seq: number;
  agentId: string | null;
  score: number;
  /** Dense rank among the rows that stand out (1 = highest score); null for the tied lowest. */
  rank: number | null;
}

export interface Cluster {
  /** 1-based, largest first: the order the rows came back in. */
  number: number;
  componentId: number;
  actions: { id: string; tool: string; seq: number }[];
}

export type AlgoView =
  | { name: 'load_bearing' | 'hinge_actions'; rows: Ranked[]; lowest: number | null }
  | { name: 'independent_clusters'; clusters: Cluster[] }
  | {
      name: 'path_between';
      /** null: the query returned no route (0 rows). */
      path: { id: string; tool: string; seq: number | null }[] | null;
      hops: number | null;
    };

/**
 * Reads the rows of one algorithm. For the two rankings, a row "stands out" when its score is
 * above the lowest score returned: PageRank gives every action a baseline score and betweenness
 * gives 0 to an action on no path, and calling the tied bottom "#4 … #9" would claim an order
 * the scores do not have.
 */
export function parseAlgo(
  name: AlgoName,
  rows: Record<string, unknown>[],
  snapshot: GraphSnapshot | null,
): AlgoView {
  switch (name) {
    case 'load_bearing':
    case 'hinge_actions': {
      const parsed = z.array(RankedRow).parse(rows);
      const lowest = parsed.length > 0 ? Math.min(...parsed.map((r) => r.score)) : null;
      const distinct = [...new Set(parsed.map((r) => r.score).filter((s) => s !== lowest))].sort(
        (a, b) => b - a,
      );
      return {
        name,
        lowest,
        rows: parsed.map((r) => ({
          id: r.id,
          tool: r.tool,
          seq: r.seq,
          agentId: r.agentId ?? null,
          score: r.score,
          rank: r.score === lowest ? null : distinct.indexOf(r.score) + 1,
        })),
      };
    }
    case 'independent_clusters':
      return {
        name,
        clusters: z
          .array(ClusterRow)
          .parse(rows)
          .map((r, i) => ({ number: i + 1, componentId: r.componentId, actions: r.actions })),
      };
    case 'path_between': {
      const [row] = z.array(PathRow).parse(rows);
      if (!row) return { name, path: null, hops: null };
      const seqOf = new Map(
        (snapshot?.nodes ?? []).flatMap((n) =>
          n.label === 'Action' && n.seq !== undefined ? [[n.id, n.seq] as const] : [],
        ),
      );
      return {
        name,
        hops: row.pathWeight,
        path: row.ids.map((id, i) => ({
          id,
          tool: row.tools[i] ?? id,
          seq: seqOf.get(id) ?? null,
        })),
      };
    }
  }
}

export interface AlgoOverlay {
  /** Node ids at full opacity; null = nothing dims (every cluster shown at once). */
  lit: Set<string> | null;
  litLinks: Set<string>;
  /** Small labels drawn beside nodes: ranks (#1), cluster numbers (C1) or path steps (1, 2 …). */
  badges: Map<string, string>;
}

/** DEPENDS_ON links of the snapshot whose two ends are both in `ids`. */
function linksWithin(snapshot: GraphSnapshot, ids: Set<string>): Set<string> {
  const keys = new Set<string>();
  for (const l of snapshot.links) {
    if (l.type === 'DEPENDS_ON' && ids.has(l.source) && ids.has(l.target)) {
      keys.add(linkKey(l.source, l.target, l.type));
    }
  }
  return keys;
}

/**
 * What the graph shows for a result. `focus` picks one cluster (its number) to light alone.
 * Ids the snapshot does not hold are left out of the overlay; the result list still names them.
 */
export function overlayOf(
  view: AlgoView,
  snapshot: GraphSnapshot,
  focus: number | null = null,
): AlgoOverlay {
  const present = new Set(snapshot.nodes.map((n) => n.id));
  const badges = new Map<string, string>();
  switch (view.name) {
    case 'load_bearing':
    case 'hinge_actions': {
      const lit = new Set<string>();
      for (const r of view.rows) {
        if (r.rank === null || !present.has(r.id)) continue;
        lit.add(r.id);
        badges.set(r.id, `#${r.rank}`);
      }
      return { lit, litLinks: linksWithin(snapshot, lit), badges };
    }
    case 'independent_clusters': {
      for (const c of view.clusters) {
        for (const a of c.actions) if (present.has(a.id)) badges.set(a.id, `C${c.number}`);
      }
      const chosen = view.clusters.find((c) => c.number === focus);
      if (!chosen) return { lit: null, litLinks: new Set(), badges };
      const lit = new Set(chosen.actions.map((a) => a.id).filter((id) => present.has(id)));
      return { lit, litLinks: linksWithin(snapshot, lit), badges };
    }
    case 'path_between': {
      const lit = new Set<string>();
      const litLinks = new Set<string>();
      const path = view.path ?? [];
      for (const [i, step] of path.entries()) {
        if (!present.has(step.id)) continue;
        lit.add(step.id);
        badges.set(step.id, String(i + 1));
        // The route runs earlier → later; each later step DEPENDS_ON the one before it.
        const previous = path[i - 1];
        if (previous) litLinks.add(linkKey(step.id, previous.id, 'DEPENDS_ON'));
      }
      return { lit, litLinks, badges };
    }
  }
}

/** The two picks in seq order: a later action can only depend on an earlier one (Q11). */
export function orderPicks(
  a: string | null,
  b: string | null,
  snapshot: GraphSnapshot | null,
): { from: string | null; to: string | null } {
  if (!a || !b) return { from: a, to: b };
  const seq = (id: string) => snapshot?.nodes.find((n) => n.id === id)?.seq ?? 0;
  return seq(a) <= seq(b) ? { from: a, to: b } : { from: b, to: a };
}
