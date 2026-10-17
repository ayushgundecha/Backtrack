/**
 * resolve_action: map "undo the address change" (or an id) onto a recorded action.
 *
 * Why plain token matching: the words people use for an action are the tool's own words
 * (update_address → "address", send_email → "email") or its arguments ("ord_1001"). Matching
 * those against the graph's action list is predictable and explainable; when the text does not
 * single out one action, the caller gets the closest candidates instead of a guess.
 */
import type { TenantGraph } from '../graph/client.js';
import { parseJson } from '../graph/cypher.js';
import { type ActionRow, listActions } from '../graph/queries.js';
import { type Trace, traceOf } from './trace.js';

export interface Candidate {
  id: string;
  tool: string;
  seq: number;
  label: string;
}

export interface Resolution {
  /** The action the text or id points at, or null when it does not single one out. */
  action: ActionRow | null;
  /** Up to three closest actions, best first (shown on the "unknown action" card). */
  candidates: Candidate[];
  trace: Trace;
}

const STOPWORDS = new Set(
  'undo revert roll back rollback the a an that this my our please change changes changed action step last of to on for it what did was made'.split(
    ' ',
  ),
);

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/follow-up/g, 'followup')
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);

export function labelOf(row: Pick<ActionRow, 'tool' | 'args'>): string {
  const args = parseJson<Record<string, unknown>>(row.args) ?? {};
  const shown = Object.values(args)
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .slice(0, 2)
    .map((v) => {
      const s = String(v);
      return s.length > 40 ? `${s.slice(0, 39)}…` : s;
    });
  return shown.length ? `${row.tool}(${shown.join(', ')})` : row.tool;
}

const candidate = (r: ActionRow): Candidate => ({
  id: r.id,
  tool: r.tool,
  seq: r.seq,
  label: labelOf(r),
});

/** Score how well the words of a request match one action: tool words count double. */
function score(tokens: string[], row: ActionRow): number {
  const toolWords = new Set(row.tool.split('_'));
  const argText = (row.args ?? '').toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (t === row.tool) s += 3;
    else if (toolWords.has(t) || toolWords.has(t.replace(/s$/, ''))) s += 2;
    else if (t.length > 2 && argText.includes(t)) s += 1;
  }
  return s;
}

export async function resolveAction(
  g: TenantGraph,
  input: { actionId?: string | null; text?: string | null },
): Promise<Resolution> {
  const res = await listActions(g, {});
  const trace = traceOf('V1', res);
  // Only original actions can be undone; undo and mitigation actions are never targets.
  const actions = res.rows.filter((r) => r.kind === 'do');
  const latestFirst = [...actions].sort((a, b) => b.seq - a.seq);

  const byId = input.actionId ?? (input.text?.match(/\bact_[a-z0-9]+\b/)?.[0] || null);
  if (byId) {
    // By id, any recorded action resolves (the planner refuses to undo an undo explicitly).
    const hit = res.rows.find((r) => r.id === byId) ?? null;
    return { action: hit, candidates: hit ? [] : latestFirst.slice(0, 3).map(candidate), trace };
  }

  const tokens = normalise(input.text ?? '').filter((t) => !STOPWORDS.has(t));
  const ranked = latestFirst
    .map((r) => ({ r, s: score(tokens, r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.seq - a.r.seq);
  const [best, second] = ranked;
  // A tie between different tools is ambiguous; a tie within one tool picks the latest call.
  const unique = best && (!second || second.s < best.s || second.r.tool === best.r.tool);
  if (best && unique) return { action: best.r, candidates: [], trace };
  const pool = ranked.length ? ranked.map((x) => x.r) : latestFirst;
  return { action: null, candidates: pool.slice(0, 3).map(candidate), trace };
}
