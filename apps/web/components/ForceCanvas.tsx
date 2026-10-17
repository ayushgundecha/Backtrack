'use client';

/**
 * The force-directed canvas (react-force-graph-2d). Loaded only in the browser (next/dynamic,
 * ssr: false) because the library touches `window` on import. It draws what it is given and owns
 * no data: GraphView decides what is lit; this file decides how it looks (docs/design-system.md,
 * graph encoding).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import {
  type Closure,
  linkKey,
  type ViewGraph,
  type ViewLink,
  type ViewNode,
} from '@/lib/graph-model';

type Node = NodeObject<ViewNode>;
type Link = LinkObject<ViewNode, ViewLink>;
type Methods = ForceGraphMethods<Node, Link>;

/** Node radius in graph units. Arrows end at the circle edge because nodeRelSize matches it. */
const R = 6;
/** How far an agent hull reaches past its outermost action. */
const HULL_PAD = R * 2.6;

type Point = readonly [number, number];

/** Andrew's monotone chain; one or two points come back as they are (a dot or a capsule). */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const p of list) {
      while (
        out.length >= 2 &&
        cross(out[out.length - 2] as Point, out[out.length - 1] as Point, p) <= 0
      )
        out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

interface Palette {
  bg: string;
  surface2: string;
  border: string;
  fg: string;
  fgMuted: string;
  accent: string;
  amber: string;
  red: string;
  green: string;
  teal: string;
  greyNode: string;
  sans: string;
  mono: string;
}

const FALLBACK: Palette = {
  bg: '#070b14',
  surface2: '#141c30',
  border: '#243049',
  fg: '#eef2f8',
  fgMuted: '#93a1b8',
  accent: '#4c8dff',
  amber: '#f5b544',
  red: '#f0564a',
  green: '#3ecf8e',
  teal: '#2fb8c6',
  greyNode: '#5b6b85',
  sans: 'ui-sans-serif, system-ui, sans-serif',
  mono: 'ui-monospace, monospace',
};

/** The canvas cannot use CSS variables, so the tokens are read once from :root (light or dark). */
function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--bg', FALLBACK.bg),
    surface2: read('--surface-2', FALLBACK.surface2),
    border: read('--border', FALLBACK.border),
    fg: read('--fg', FALLBACK.fg),
    fgMuted: read('--fg-muted', FALLBACK.fgMuted),
    accent: read('--accent', FALLBACK.accent),
    amber: read('--amber', FALLBACK.amber),
    red: read('--red', FALLBACK.red),
    green: read('--green', FALLBACK.green),
    teal: read('--teal', FALLBACK.teal),
    greyNode: read('--grey-node', FALLBACK.greyNode),
    // next/font names its families (e.g. "__Inter_x"); the variables hold the real stack.
    sans: read('--font-inter', FALLBACK.sans),
    mono: read('--font-jetbrains-mono', FALLBACK.mono),
  };
}

/** #rrggbb + alpha → rgba(); dimming is done with alpha so colors keep their meaning. */
function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) return hex;
  const n = Number.parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** The library swaps a link's source/target ids for the node objects once it has laid them out. */
const endId = (end: unknown): string =>
  typeof end === 'object' && end !== null ? String((end as { id: unknown }).id) : String(end);

const DIM = 0.2;

const isUndoSide = (n: ViewNode) => n.actionKind === 'undo' || n.actionKind === 'mitigation';
/** Screen pixels kept around the nodes on fit; labels hang ~80 px past a node's centre. */
const FIT_PADDING = 64;
/** Narrow canvases cannot spare 64 px a side. */
const fitPadding = (width: number) => Math.min(FIT_PADDING, Math.round(width / 9));

export interface ForceCanvasProps {
  graph: ViewGraph;
  closure: Closure | null;
  selectedId: string | null;
  reducedMotion: boolean;
  agentLabels: Record<string, string>;
  onSelect(actionId: string | null): void;
  /** Hover detail beyond the snapshot (args come from the run stream when it has them). */
  describe?(node: ViewNode): React.ReactNode;
}

export default function ForceCanvas({
  graph,
  closure,
  selectedId,
  reducedMotion,
  agentLabels,
  onSelect,
  describe,
}: ForceCanvasProps) {
  const fg = useRef<Methods | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [palette, setPalette] = useState<Palette>(FALLBACK);
  const [hover, setHover] = useState<{ node: Node; x: number; y: number } | null>(null);
  const userMoved = useRef(false);
  const mounted = size.width > 0 && size.height > 0;

  // The blast chip opening or a breakpoint change resizes the canvas: fit again, unless the user
  // has panned or zoomed on purpose.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every size change
  useEffect(() => {
    if (!mounted || userMoved.current) return;
    const timer = setTimeout(
      () => fg.current?.zoomToFit(reducedMotion ? 0 : 200, fitPadding(size.width)),
      50,
    );
    return () => clearTimeout(timer);
  }, [size.width, size.height, mounted, reducedMotion]);

  useEffect(() => setPalette(readPalette()), []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Node objects are kept across snapshots: d3 stores positions on them, so reusing them keeps
  // the layout still while statuses change, and only new nodes spring in.
  const cache = useRef(new Map<string, Node>());
  const latest = useRef(graph);
  latest.current = graph;
  // Rebuilt only when a node or link is added or removed (structureKey); status changes mutate
  // the cached objects in place and just repaint, so the layout does not re-heat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: structureKey stands for the graph
  const data = useMemo(() => {
    const graph = latest.current;
    const next = new Map<string, Node>();
    for (const view of graph.nodes) {
      const existing = cache.current.get(view.id);
      next.set(view.id, existing ? Object.assign(existing, view) : { ...view });
    }
    // New nodes start beside something they link to, so they grow out of the graph.
    for (const link of graph.links) {
      const a = next.get(link.source);
      const b = next.get(link.target);
      if (!a || !b) continue;
      if (a.x === undefined && b.x !== undefined) {
        a.x = b.x + 8;
        a.y = (b.y ?? 0) + 8;
      } else if (b.x === undefined && a.x !== undefined) {
        b.x = a.x - 8;
        b.y = (a.y ?? 0) - 8;
      }
    }
    cache.current = next;
    return {
      nodes: [...next.values()],
      links: graph.links.map((l) => ({ ...l })) as Link[],
    };
  }, [graph.structureKey]);

  // Keep the cached node fields current even when the structure did not change.
  useEffect(() => {
    for (const view of graph.nodes) {
      const node = cache.current.get(view.id);
      if (node) Object.assign(node, view);
    }
  }, [graph]);

  // Earlier actions sit left, later right: a weak pull on x by seq, so time reads left to right.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run once the canvas has mounted
  useEffect(() => {
    const api = fg.current;
    if (!api) return;
    const seqs = data.nodes.flatMap((n) => (n.seq === undefined ? [] : [n.seq]));
    const min = Math.min(...seqs);
    const max = Math.max(...seqs);
    const span = Math.max(1, max - min);
    const width = Math.max(160, Math.sqrt(data.nodes.length) * 70);
    // Each agent gets its own band on y, so the agent hulls separate instead of overlapping.
    const agents = [
      ...new Set(data.nodes.flatMap((n) => (n.agentId && !isUndoSide(n) ? [n.agentId] : []))),
    ];
    const band = (agentId: string) => (agents.indexOf(agentId) - (agents.length - 1) / 2) * 110;
    let nodes: Node[] = [];
    const byTime = Object.assign(
      (a: number) => {
        for (const n of nodes) {
          if (n.x === undefined || n.y === undefined) continue;
          // A little gravity, so a part with no links to the rest (a mitigation's new draft
          // email) stays near the graph instead of drifting off and shrinking the fit.
          n.vx = (n.vx ?? 0) - n.x * 0.03 * a;
          n.vy = (n.vy ?? 0) - n.y * 0.03 * a;
          if (n.seq === undefined) continue;
          const target = ((n.seq - min) / span - 0.5) * width;
          n.vx = (n.vx ?? 0) + (target - n.x) * 0.08 * a;
          if (n.agentId && !isUndoSide(n) && n.y !== undefined) {
            n.vy = (n.vy ?? 0) + (band(n.agentId) - n.y) * 0.05 * a;
          }
        }
      },
      { initialize: (all: Node[]) => (nodes = all) },
    );
    api.d3Force('time', byTime);
    api.d3Force('charge')?.strength?.(-90);
    // Repulsion only between neighbours: far parts are not pushed apart without limit.
    api.d3Force('charge')?.distanceMax?.(160);
    api.d3Force('link')?.distance?.((l: Link) => (l.type === 'DEPENDS_ON' ? 42 : 28));
    api.d3ReheatSimulation();
  }, [data, mounted]);

  const lit = closure?.lit ?? null;
  const litLinks = closure?.litLinks ?? null;
  const isLit = useCallback((id: string) => !lit || lit.has(id), [lit]);

  const paintNode = useCallback(
    (node: Node, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      ctx.globalAlpha = isLit(node.id) ? 1 : DIM;
      const showLabel = isLit(node.id) || scale > 1.6 || data.nodes.length <= 60;

      if (node.kind === 'entity') {
        const s = R * 0.8;
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x - s, y);
        ctx.closePath();
        ctx.fillStyle = palette.surface2;
        ctx.fill();
        const dashed = node.status === 'deleted';
        if (dashed) ctx.setLineDash([2, 2]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = lit?.has(node.id) ? palette.accent : palette.fgMuted;
        ctx.stroke();
        if (dashed) ctx.setLineDash([]);
        if (showLabel) label(ctx, node.title, x, y + s + 2, scale, palette.fgMuted, palette.mono);
        ctx.globalAlpha = 1;
        return;
      }

      const r = node.actionKind === 'do' || node.actionKind === undefined ? R : R * 0.7;
      // Undo and mitigation steps are Backtrack's own actions: green, the color of a revert.
      const fill =
        node.status === 'undone'
          ? palette.greyNode
          : isUndoSide(node)
            ? palette.green
            : {
                read: palette.greyNode,
                write: palette.accent,
                create: palette.teal,
                external: palette.red,
              }[node.family ?? 'write'];

      // Selected root: an accent halo outside the status ring.
      if (node.id === selectedId) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5.5, 0, 2 * Math.PI);
        ctx.fillStyle = alpha(palette.accent, 0.22);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = node.status === 'undone' ? alpha(fill, 0.45) : fill;
      ctx.fill();

      // Status ring, 2 px outside the fill: done solid, pending amber (pulsing), undone dashed
      // grey, blocked or denied red.
      const ring =
        node.status === 'pending'
          ? palette.amber
          : node.status === 'blocked' || node.status === 'denied'
            ? palette.red
            : node.status === 'undone'
              ? palette.greyNode
              : fill;
      let ringR = r + 2;
      if (node.status === 'pending' && !reducedMotion) {
        ringR += 1.2 * (0.5 + 0.5 * Math.sin((performance.now() / 1200) * 2 * Math.PI));
      }
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, 2 * Math.PI);
      // Dash state is only touched when needed: setLineDash per node per frame is not free.
      const dashed = node.status === 'undone';
      if (dashed) ctx.setLineDash([2, 1.6]);
      ctx.lineWidth = node.status === 'pending' ? 1.6 : 1.1;
      ctx.strokeStyle = ring;
      ctx.stroke();
      if (dashed) ctx.setLineDash([]);

      if (showLabel) {
        label(
          ctx,
          `${node.seq ?? ''} ${node.tool ?? node.title}`,
          x,
          y + r + 3,
          scale,
          node.id === selectedId ? palette.fg : palette.fgMuted,
          palette.mono,
        );
      }
      ctx.globalAlpha = 1;
    },
    [isLit, lit, palette, selectedId, reducedMotion, data.nodes.length],
  );

  const paintPointer = useCallback((node: Node, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, R + 3, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  // Agents as hulls: the convex hull of each agent's actions, stroked with a wide round join so
  // it pads out evenly, filled with the nested-surface color, outlined, and labelled above.
  const paintHulls = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      const groups = new Map<string, Node[]>();
      for (const n of data.nodes) {
        // Undo steps sit next to what they undo (UNDOES), so they get no hull of their own.
        if (n.kind !== 'action' || !n.agentId || isUndoSide(n) || n.x === undefined) continue;
        const group = groups.get(n.agentId) ?? [];
        group.push(n);
        groups.set(n.agentId, group);
      }
      for (const [agentId, nodes] of groups) {
        const anyLit = !lit || nodes.some((n) => lit.has(n.id));
        ctx.globalAlpha = anyLit ? 1 : 0.5;
        const hull = convexHull(nodes.map((n) => [n.x ?? 0, n.y ?? 0] as const));
        const tracePath = () => {
          ctx.beginPath();
          const [only] = hull;
          // A lone action has no hull edges; a tiny circle stroked wide becomes a padded disc.
          if (hull.length === 1 && only) ctx.arc(only[0], only[1], 0.5, 0, 2 * Math.PI);
          else
            for (const [i, [x, y]] of hull.entries()) {
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
          ctx.closePath();
        };
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        // Outline first (pad + 1 px), then the fill on top, leaving a 1 px border ring.
        tracePath();
        ctx.lineWidth = HULL_PAD * 2 + 2 / scale;
        ctx.strokeStyle = palette.border;
        ctx.stroke();
        ctx.lineWidth = HULL_PAD * 2;
        ctx.strokeStyle = palette.surface2;
        ctx.stroke();
        ctx.fillStyle = palette.surface2;
        ctx.fill();

        const top = hull.reduce((a, b) => (b[1] < a[1] ? b : a));
        const size = 11 / scale;
        ctx.font = `500 ${size}px ${palette.sans}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = palette.fgMuted;
        ctx.fillText(agentLabels[agentId] ?? agentId, top[0], top[1] - HULL_PAD - 3 / scale);
      }
      ctx.globalAlpha = 1;
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
    },
    [data.nodes, lit, palette, agentLabels],
  );

  const linkOn = useCallback(
    (l: Link) => !litLinks || litLinks.has(linkKey(endId(l.source), endId(l.target), l.type)),
    [litLinks],
  );
  const linkColor = useCallback(
    (l: Link) => {
      const on = linkOn(l);
      if (l.type === 'DEPENDS_ON') {
        if (litLinks && on) return palette.accent;
        return alpha(palette.fgMuted, on ? 0.55 : 0.55 * DIM);
      }
      if (l.type === 'UNDOES') return alpha(palette.green, on ? 0.7 : 0.7 * DIM);
      if (litLinks && on) return alpha(palette.accent, 0.6);
      return alpha(palette.fgMuted, on ? 0.3 : 0.3 * DIM);
    },
    [linkOn, litLinks, palette],
  );
  const linkWidth = useCallback((l: Link) => (l.type === 'DEPENDS_ON' ? 2 : 0.6), []);
  const linkDash = useCallback(
    (l: Link) => (l.type === 'READ' ? [2, 2] : l.type === 'UNDOES' ? [3, 2] : null),
    [],
  );
  const arrowLength = useCallback((l: Link) => (l.type === 'DEPENDS_ON' ? 5 : 0), []);
  // Particles flow along lit DEPENDS_ON edges toward the dependency (source → target).
  const particles = useCallback(
    (l: Link) => (!reducedMotion && litLinks && l.type === 'DEPENDS_ON' && linkOn(l) ? 2 : 0),
    [reducedMotion, litLinks, linkOn],
  );

  const pending = graph.nodes.some((n) => n.status === 'pending');

  return (
    <div
      ref={box}
      className="relative size-full"
      onPointerDown={() => {
        userMoved.current = true;
      }}
      onWheel={() => {
        userMoved.current = true;
      }}
    >
      {mounted ? (
        <ForceGraph2D<ViewNode, ViewLink>
          ref={fg}
          width={size.width}
          height={size.height}
          graphData={data}
          nodeId="id"
          nodeRelSize={R}
          nodeVal={(n) => (n.kind === 'entity' ? 0.64 : 1)}
          nodeLabel={() => ''}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointer}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={linkDash}
          linkDirectionalArrowLength={arrowLength}
          linkDirectionalArrowRelPos={1}
          linkDirectionalParticles={particles}
          linkDirectionalParticleWidth={2.6}
          linkDirectionalParticleSpeed={0.012}
          linkDirectionalParticleColor={() => palette.accent}
          onRenderFramePre={paintHulls}
          // The pending pulse is the one loop allowed; it needs frames while the layout is idle.
          autoPauseRedraw={!(pending && !reducedMotion)}
          // Reduced motion: lay the graph out before the first frame and never animate it.
          warmupTicks={reducedMotion ? 160 : 0}
          cooldownTicks={reducedMotion ? 0 : Number.POSITIVE_INFINITY}
          cooldownTime={reducedMotion ? 0 : 2500}
          d3VelocityDecay={0.35}
          onEngineStop={() => {
            if (!userMoved.current)
              fg.current?.zoomToFit(reducedMotion ? 0 : 300, fitPadding(size.width));
          }}
          onNodeClick={(node) => {
            if (node.kind === 'action') onSelect(node.id);
          }}
          onBackgroundClick={() => onSelect(null)}
          onNodeHover={(node) => {
            if (!node || !fg.current) return setHover(null);
            const p = fg.current.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
            setHover({ node, x: p.x, y: p.y });
          }}
          onZoom={() => setHover(null)}
          minZoom={0.3}
          maxZoom={6}
        />
      ) : null}
      {hover && describe ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-72 -translate-x-1/2 rounded-md border bg-surface-2 px-2.5 py-1.5 text-xs shadow-none"
          style={{ left: hover.x, top: hover.y + 16 }}
        >
          {describe(hover.node)}
        </div>
      ) : null}
    </div>
  );
}

/** Text at a constant on-screen size (11 px) whatever the zoom. */
function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: string,
  font: string,
) {
  const size = 11 / scale;
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(text.length > 22 ? `${text.slice(0, 21)}…` : text, x, y);
}
