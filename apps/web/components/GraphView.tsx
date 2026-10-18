'use client';

/**
 * Left column: the tenant graph as a force layout (PLAN §7.3). Actions are circles colored by tool
 * family with a status ring, entities are diamonds, agents are labelled hulls, DEPENDS_ON is thick
 * with an arrow toward the dependency. Clicking an action asks the graph for its downstream closure
 * (POST /api/undo → Q1/Q3) and lights exactly what came back; the rest dims to 20 %.
 */
import type { GraphSnapshot } from '@backtrack/core/contracts';
import { Info, Play } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { stepSelection, toViewGraph, type ViewNode } from '@/lib/graph-model';
import { laterNodes } from '@/lib/time-travel';
import { agentName } from '@/lib/tools';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { useBacktrack } from './BacktrackProvider';
import { BlastChip } from './BlastChip';
import { EmptyState, ErrorState } from './EmptyState';
import { useSelection } from './SelectionProvider';
import { useTime } from './TimeProvider';

// The library reads `window` on import, so it is loaded in the browser only, in its own chunk.
const ForceCanvas = dynamic(() => import('./ForceCanvas'), {
  ssr: false,
  // Until the canvas chunk arrives the box says so instead of standing empty.
  loading: () => (
    <p className="grid size-full place-items-center text-fg-muted text-sm">Drawing the graph…</p>
  ),
});

/** Counts for the pane header, taken from the snapshot so the number names its source. */
export function graphCounts(graph: GraphSnapshot | null) {
  if (!graph) return null;
  const actions = graph.nodes.filter((n) => n.label === 'Action').length;
  const dependencies = graph.links.filter((l) => l.type === 'DEPENDS_ON').length;
  return { actions, dependencies };
}

function Skeleton() {
  // Static on purpose: the pending pulse is the only looping animation in the product.
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the graph"
      className="h-full min-h-80 rounded-lg border bg-surface-2"
    />
  );
}

const formatArgs = (args: Record<string, unknown>) =>
  Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');

export function GraphView() {
  const { state, actions, meta } = useBacktrack();
  const { graph, session } = state;
  const selection = useSelection();
  const reducedMotion = useReducedMotion();
  const view = useMemo(() => (graph ? toViewGraph(graph) : null), [graph]);
  // Scrubbed back in time: what was recorded after that point dims (BT-047).
  const time = useTime();
  const faded = useMemo(
    () => (graph ? laterNodes(graph, time.asOfSeq, time.frame) : new Set<string>()),
    [graph, time.asOfSeq, time.frame],
  );

  // Args are not in the snapshot; the run stream carried them in action.recorded.
  const argsById = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const step of session.steps) if (step.action) map.set(step.action.id, step.action.args);
    return map;
  }, [session.steps]);

  const describe = useCallback(
    (node: ViewNode) =>
      node.kind === 'entity' ? (
        <>
          <p className="font-medium">{node.title}</p>
          <p className="font-mono text-fg-muted">{node.id}</p>
        </>
      ) : (
        <>
          <p className="font-mono">
            {node.tool} <span className="text-fg-muted">seq {node.seq}</span>
          </p>
          {argsById.has(node.id) ? (
            <p className="line-clamp-3 font-mono text-fg-muted">
              {formatArgs(argsById.get(node.id) ?? {})}
            </p>
          ) : null}
          <p className="text-fg-muted">
            {node.status}
            {node.agentId ? ` · ${agentName[node.agentId] ?? node.agentId}` : ''}
          </p>
        </>
      ),
    [argsById],
  );

  if (!graph || !view) {
    return state.loadError ? (
      <ErrorState
        title={`Could not read the graph bt:${meta.tenant}`}
        message={state.loadError}
        onRetry={actions.retry}
      />
    ) : (
      <Skeleton />
    );
  }

  const actionNodes = view.nodes.filter((n) => n.kind === 'action');
  if (actionNodes.length === 0) {
    return (
      <EmptyState title="Nothing recorded yet. Run the ops agent.">
        <Button
          size="lg"
          disabled={meta.source === null || state.streaming}
          onClick={() => actions.runAgent('ops-agent', 'replay')}
        >
          <Play aria-hidden />
          Run ops agent
        </Button>
      </EmptyState>
    );
  }

  const root = actionNodes.find((n) => n.id === selection.selectedId) ?? null;
  const { closure } = selection;
  const seqOf = new Map(actionNodes.map((n) => [n.id, n.seq]));
  const dependsOn = new Map<string, number[]>();
  for (const l of view.links) {
    if (l.type !== 'DEPENDS_ON') continue;
    dependsOn.set(l.source, [...(dependsOn.get(l.source) ?? []), seqOf.get(l.target) ?? 0]);
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const keys: Record<string, 1 | -1> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    const step = keys[event.key];
    if (step) {
      event.preventDefault();
      selection.select(stepSelection(graph, selection.selectedId, step));
    } else if (event.key === 'Enter' && selection.selectedId) {
      event.preventDefault();
      selection.openExplain(selection.selectedId);
    } else if (event.key === 'Escape' && selection.selectedId) {
      event.preventDefault();
      selection.select(null);
    }
  };

  const announcement =
    root && closure && closure.rootId === root.id
      ? `${root.tool} seq ${root.seq} selected. ${closure.members.length} dependent actions within depth ${closure.depth}.`
      : root
        ? `${root.tool} seq ${root.seq} selected.`
        : '';

  return (
    <div className="flex flex-col gap-3 lg:h-full">
      {root ? (
        <BlastChip root={{ tool: root.tool ?? root.title, seq: root.seq }}>
          <Button
            variant="secondary"
            size="sm"
            data-explain-keep-open
            onClick={() => selection.openExplain(root.id)}
          >
            <Info aria-hidden />
            Explain
          </Button>
        </BlastChip>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-2.5 text-fg-muted text-sm">
          Click an action to light up everything that depends on it. With the graph focused, the
          arrow keys step through actions in seq order.
        </p>
      )}

      {/*
        The canvas is not readable by assistive tech, so the same actions are a listbox of hidden
        options (the adjacency list) and the arrow keys move the selection through them.
      */}
      <div
        role="listbox"
        aria-label={`Dependency graph: ${actionNodes.length} actions`}
        aria-describedby="graph-help"
        aria-activedescendant={root ? `graph-option-${root.id}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-graph-canvas
        // Stacked (< 1024 px) the page scrolls, so the canvas gets a fixed height; in columns it
        // takes what the pane leaves.
        className="relative h-[380px] overflow-hidden rounded-lg border bg-bg lg:h-auto lg:min-h-80 lg:flex-1"
      >
        {actionNodes.map((n) => (
          <div
            key={n.id}
            id={`graph-option-${n.id}`}
            role="option"
            // Focus stays on the listbox (aria-activedescendant); -1 keeps options out of Tab.
            tabIndex={-1}
            aria-selected={n.id === selection.selectedId}
            className="sr-only"
          >
            {`seq ${n.seq} ${n.tool}, ${n.status}${
              dependsOn.get(n.id)?.length
                ? `, depends on seq ${dependsOn.get(n.id)?.join(', ')}`
                : ''
            }${faded.has(n.id) ? ', recorded after the scrubbed time' : ''}`}
          </div>
        ))}
        <ForceCanvas
          graph={view}
          closure={closure && closure.rootId === selection.selectedId ? closure : null}
          selectedId={selection.selectedId}
          faded={faded}
          reducedMotion={reducedMotion}
          agentLabels={agentName}
          onSelect={selection.select}
          describe={describe}
        />
      </div>
      <p id="graph-help" className="sr-only">
        Arrow keys select the previous or next action by seq, Enter explains it, Escape clears the
        selection.
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <Legend />
    </div>
  );
}

function Legend() {
  const dot = (color: string, ring = color, dashed = false) => (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0">
      <circle cx="8" cy="8" r="4.5" fill={color} />
      <circle
        cx="8"
        cy="8"
        r="6.6"
        fill="none"
        stroke={ring}
        strokeWidth="1.2"
        strokeDasharray={dashed ? '2 1.6' : undefined}
      />
    </svg>
  );
  const items: [React.ReactNode, string][] = [
    [dot('var(--grey-node)'), 'Read'],
    [dot('var(--accent)'), 'Write'],
    [dot('var(--teal)'), 'Create'],
    [dot('var(--red)'), 'External'],
    [dot('var(--green)'), 'Undo step'],
    [dot('var(--accent)', 'var(--amber)'), 'Pending'],
    [dot('var(--grey-node)', 'var(--grey-node)', true), 'Undone'],
    [
      <svg key="d" aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0">
        <path d="M8 3 13 8 8 13 3 8Z" fill="var(--surface-2)" stroke="var(--fg-muted)" />
      </svg>,
      'Entity',
    ],
    [
      <svg key="a" aria-hidden viewBox="0 0 20 16" className="h-3.5 w-4 shrink-0">
        <path d="M2 8h12" stroke="var(--fg-muted)" strokeWidth="2" />
        <path d="M13 4.5 18 8l-5 3.5Z" fill="var(--fg-muted)" />
      </svg>,
      'Depends on',
    ],
  ];
  return (
    <ul aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-1 text-fg-muted text-xs">
      {items.map(([icon, text]) => (
        <li key={text} className="flex items-center gap-1.5">
          {icon}
          {text}
        </li>
      ))}
    </ul>
  );
}
