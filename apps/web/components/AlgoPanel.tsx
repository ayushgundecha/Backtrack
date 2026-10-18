'use client';

/**
 * Ask the graph (BT-04B): FalkorDB's algorithms over DEPENDS_ON, one button each, through
 * GET /api/algo. The answer is drawn on the graph (ranks, clusters, a route) and listed here with
 * the Cypher and milliseconds that produced it. The graph shows one answer at a time: asking
 * clears the selection, and picking an action afterwards clears the answer.
 */
import type { GraphSnapshot } from '@backtrack/core/contracts';
import { cn } from 'cn';
import { LoaderCircle, Route, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  ALGOS,
  type AlgoName,
  type AlgoOverlay,
  type AlgoView,
  orderPicks,
  overlayOf,
  parseAlgo,
} from '@/lib/algo-view';
import { type AlgoResponse, ApiError } from '@/lib/api';
import { useBacktrack } from './BacktrackProvider';
import { TraceStrip } from './TraceStrip';

const NAMES = Object.keys(ALGOS) as AlgoName[];

interface Answer {
  name: AlgoName;
  view: AlgoView;
  response: AlgoResponse;
  params: Record<string, string>;
}

interface Failure {
  name: AlgoName;
  status: number | null;
  message: string;
}

export interface AlgoState {
  mode: AlgoName | null;
  answer: Answer | null;
  failure: Failure | null;
  loading: boolean;
  picks: { from: string | null; to: string | null };
  focus: number | null;
  overlay: AlgoOverlay | null;
  /** True while a click on the graph picks an endpoint instead of selecting. */
  picking: boolean;
  run(name: AlgoName): void;
  pick(actionId: string): void;
  setPick(slot: 'from' | 'to', actionId: string | null): void;
  findPath(): void;
  setFocus(cluster: number | null): void;
  clear(): void;
}

/** The panel's state, owned by GraphView so the canvas and the panel read the same answer. */
export function useAlgo(graph: GraphSnapshot | null, preselected: string | null): AlgoState {
  const { actions } = useBacktrack();
  const [mode, setMode] = useState<AlgoName | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  const [picks, setPicks] = useState<{ from: string | null; to: string | null }>({
    from: null,
    to: null,
  });
  const [focus, setFocus] = useState<number | null>(null);

  // A new recording can change every answer: drop the old one rather than show it as current.
  const actionCount = graph?.nodes.filter((n) => n.label === 'Action').length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the history grows or shrinks
  useEffect(() => {
    setMode(null);
    setAnswer(null);
    setFailure(null);
    setFocus(null);
    setPicks({ from: null, to: null });
  }, [actionCount]);

  const ask = useCallback(
    (name: AlgoName, params: Record<string, string>) => {
      setLoading(true);
      setFailure(null);
      actions
        .algo({ name, ...params })
        .then((response) => {
          setAnswer({ name, view: parseAlgo(name, response.rows, graph), response, params });
          setFocus(null);
        })
        .catch((error: unknown) => {
          setAnswer(null);
          setFailure({
            name,
            status: error instanceof ApiError ? error.status : null,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => setLoading(false));
    },
    [actions, graph],
  );

  const run = useCallback(
    (name: AlgoName) => {
      setMode(name);
      setAnswer(null);
      setFailure(null);
      if (name === 'path_between') {
        // Start from the selected action, if any: it is usually the one being asked about.
        setPicks({ from: preselected, to: null });
        return;
      }
      ask(name, {});
    },
    [ask, preselected],
  );

  const setPick = useCallback((slot: 'from' | 'to', actionId: string | null) => {
    setPicks((p) => ({ ...p, [slot]: actionId }));
    setAnswer(null);
    setFailure(null);
  }, []);

  // Clicks fill From, then To; a third click starts a new pair.
  const pick = useCallback((actionId: string) => {
    setPicks((p) =>
      p.from === null
        ? { from: actionId, to: p.to }
        : p.to === null
          ? { from: p.from, to: actionId }
          : { from: actionId, to: null },
    );
    setAnswer(null);
    setFailure(null);
  }, []);

  // The query is sent with whatever is picked: if an end is missing, the route's own 400 says so.
  const findPath = useCallback(() => {
    const { from, to } = orderPicks(picks.from, picks.to, graph);
    setPicks({ from, to });
    const params: Record<string, string> = {};
    if (from) params.from = from;
    if (to) params.to = to;
    ask('path_between', params);
  }, [ask, picks, graph]);

  const clear = useCallback(() => {
    setMode(null);
    setAnswer(null);
    setFailure(null);
    setFocus(null);
  }, []);

  const overlay = useMemo(() => {
    if (!graph) return null;
    // No route found: keep the two ends lit, so the graph still shows what was asked about.
    const noRoute = answer?.view.name === 'path_between' && answer.view.path === null;
    if (answer && !noRoute) return overlayOf(answer.view, graph, focus);
    // While picking a path, the picked ends stay lit so the person sees what they chose.
    if (mode === 'path_between') {
      const ends = [picks.from, picks.to].filter((id): id is string => id !== null);
      if (ends.length === 0) return null;
      return {
        lit: new Set(ends),
        litLinks: new Set<string>(),
        badges: new Map(
          ends.map((id) => [id, id === picks.from ? 'From' : 'To'] as [string, string]),
        ),
      };
    }
    return null;
  }, [graph, answer, focus, mode, picks]);

  return {
    mode,
    answer,
    failure,
    loading,
    picks,
    focus,
    overlay,
    picking: mode === 'path_between',
    run,
    pick,
    setPick,
    findPath,
    setFocus,
    clear,
  };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));

export function AlgoPanel({ algo, graph }: { algo: AlgoState; graph: GraphSnapshot }) {
  const { meta } = useBacktrack();
  const actionOptions = useMemo(
    () =>
      graph.nodes
        .filter((n) => n.label === 'Action' && n.kind === 'do')
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    [graph],
  );
  const active = algo.mode;

  return (
    <section aria-labelledby="algo-title" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 id="algo-title" className="mr-1 text-fg-muted text-xs">
          Ask the graph
        </h3>
        {NAMES.map((name) => (
          <Button
            key={name}
            variant={active === name ? 'default' : 'secondary'}
            size="sm"
            aria-pressed={active === name}
            onClick={() => (active === name ? algo.clear() : algo.run(name))}
          >
            {name === 'path_between' ? <Route aria-hidden /> : null}
            {ALGOS[name].label}
          </Button>
        ))}
        {algo.loading ? (
          <LoaderCircle
            aria-label="Asking FalkorDB"
            className="size-3.5 animate-spin text-fg-muted motion-reduce:animate-none"
          />
        ) : null}
      </div>

      {active ? (
        <div className="flex flex-col gap-2 rounded-lg border bg-surface p-3">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-sm">
              {ALGOS[active].question}{' '}
              <span className="font-mono text-fg-muted text-xs">{ALGOS[active].query}</span>
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close the answer"
              onClick={algo.clear}
            >
              <X aria-hidden />
            </Button>
          </div>

          {active === 'path_between' ? <PathPicker algo={algo} options={actionOptions} /> : null}

          <div aria-live="polite" className="flex flex-col gap-2">
            {algo.failure && algo.failure.name === active ? (
              <p className="text-red text-sm">
                {algo.failure.status !== null ? (
                  <span className="font-mono">{algo.failure.status} · </span>
                ) : null}
                {algo.failure.message}
              </p>
            ) : null}
            {algo.answer && algo.answer.name === active ? (
              <AnswerBody algo={algo} answer={algo.answer} />
            ) : null}
          </div>

          {algo.answer && algo.answer.name === active ? (
            <TraceStrip
              trace={{
                cypher: algo.answer.response.cypher,
                ms: algo.answer.response.ms,
                rows: algo.answer.response.rows.length,
              }}
            />
          ) : null}
          {meta.source === 'mock' && algo.answer ? (
            <p className="text-fg-muted text-xs">
              Mock data: the rows are computed in the browser, not by FalkorDB.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PathPicker({ algo, options }: { algo: AlgoState; options: GraphSnapshot['nodes'] }) {
  // Stacked on phones: two selects side by side would cut the tool names to a few letters.
  const select = (slot: 'from' | 'to') => (
    <label className="flex min-w-0 basis-full flex-col gap-1 text-fg-muted text-xs sm:basis-0 sm:flex-1">
      {slot === 'from' ? 'From (earlier)' : 'To (later)'}
      <select
        value={algo.picks[slot] ?? ''}
        onChange={(e) => algo.setPick(slot, e.target.value || null)}
        className="h-8 rounded-md border bg-surface-2 px-2 font-mono text-fg text-xs focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <option value="">Pick an action</option>
        {options.map((n) => (
          <option key={n.id} value={n.id}>
            seq {n.seq} · {n.tool ?? n.title}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-fg-muted text-xs">
        Click two actions in the graph, or choose them here. They are put in seq order: a later
        action can only depend on an earlier one.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {select('from')}
        {select('to')}
        <Button size="sm" onClick={algo.findPath} disabled={algo.loading}>
          Find path
        </Button>
      </div>
    </div>
  );
}

function AnswerBody({ algo, answer }: { algo: AlgoState; answer: Answer }) {
  const { view } = answer;
  if (view.name === 'load_bearing' || view.name === 'hinge_actions') {
    const standing = view.rows.filter((r) => r.rank !== null);
    const tied = view.rows.filter((r) => r.rank === null);
    // Name the measure, not a reading of it: betweenness is not a path count when routes tie.
    const unit = view.name === 'hinge_actions' ? 'betweenness' : 'PageRank';
    if (view.rows.length === 0) return <p className="text-fg-muted text-sm">No actions yet.</p>;
    return (
      <div className="flex flex-col gap-1.5 text-sm">
        {standing.length > 0 ? (
          <ol className="flex flex-col gap-1">
            {standing.map((r) => (
              <li key={r.id} className="flex items-baseline gap-2">
                <span className="w-6 shrink-0 font-mono text-accent text-xs">#{r.rank}</span>
                <span className="min-w-0 truncate font-mono">
                  {r.tool} <span className="text-fg-muted text-xs">seq {r.seq}</span>
                </span>
                <span className="ml-auto shrink-0 font-mono text-fg-muted text-xs">
                  {unit} {fmt(r.score)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-fg-muted">
            No action stands out: every returned row scored {fmt(view.lowest ?? 0)}.
          </p>
        )}
        {tied.length > 0 && standing.length > 0 ? (
          <p className="text-fg-muted text-xs">
            {tied.length} more tied at the lowest {unit} {fmt(view.lowest ?? 0)}:{' '}
            <span className="font-mono">{tied.map((r) => `${r.tool} ${r.seq}`).join(', ')}</span>
          </p>
        ) : null}
      </div>
    );
  }
  if (view.name === 'independent_clusters') {
    return (
      <ul className="flex flex-col gap-1 text-sm">
        {view.clusters.map((c) => {
          const on = algo.focus === c.number;
          return (
            <li key={c.componentId}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => algo.setFocus(on ? null : c.number)}
                className={cn(
                  '-mx-1.5 flex w-full items-baseline gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring',
                  on && 'bg-surface-2',
                )}
              >
                <span className="w-6 shrink-0 font-mono text-accent text-xs">C{c.number}</span>
                <span className="shrink-0 text-fg-muted text-xs">
                  {c.actions.length} {c.actions.length === 1 ? 'action' : 'actions'}
                </span>
                <span className="min-w-0 truncate font-mono text-xs">
                  {c.actions.map((a) => `${a.tool} ${a.seq}`).join(', ')}
                </span>
              </button>
            </li>
          );
        })}
        <li className="pt-0.5 text-fg-muted text-xs">
          Click a cluster to light it alone. Undoing inside one cluster cannot reach another.
        </li>
      </ul>
    );
  }
  if (view.name !== 'path_between') return null;
  if (!view.path) {
    return (
      <p className="text-sm">
        Q11 returned 0 rows: no DEPENDS_ON route leads from the earlier action to the later one
        within 10 hops, so the later one does not rest on the earlier one.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <ol className="flex flex-wrap items-center gap-1">
        {view.path.map((step, i) => (
          <li key={step.id} className="flex items-center gap-1">
            {i > 0 ? (
              <span aria-hidden className="text-fg-muted">
                →
              </span>
            ) : null}
            <span className="rounded-md border bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
              {step.tool}
              {step.seq !== null ? <span className="text-fg-muted"> {step.seq}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-fg-muted text-xs">
        {view.hops} DEPENDS_ON {view.hops === 1 ? 'hop' : 'hops'}: each step depends on the one
        before it, so an undo of the first reaches the last at depth {view.hops}.
      </p>
    </div>
  );
}
