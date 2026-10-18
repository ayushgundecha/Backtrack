'use client';

/**
 * The force-directed canvas (react-force-graph-2d). Loaded only in the browser (next/dynamic,
 * ssr: false) because the library touches `window` on import. It draws what it is given and owns
 * no data: GraphView decides what is lit; this file decides how it looks (docs/design-system.md,
 * graph encoding) and how it moves (PLAN §7.3: one animation per change, under 400 ms).
 */
import { Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import { Button } from '@/components/ui/button';
import {
  type Closure,
  linkKey,
  type ViewGraph,
  type ViewLink,
  type ViewNode,
} from '@/lib/graph-model';
import {
  entityShortLabel,
  type LabelCandidate,
  type Obstacle,
  placeLabels,
} from '@/lib/label-layout';

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
/**
 * The closest a fit may zoom. Without a cap the first one or two nodes of a run fill the canvas
 * (zoomToFit on a tiny bounding box); at 2.5× a node is ~30 px across, about what it has mid-run.
 */
const MAX_FIT_ZOOM = 2.5;
const MIN_ZOOM = 0.3;
/** Motion budget (PLAN §7.3: one animation per change, under 400 ms). */
const MOTION = {
  /** A new node grows from nothing at its laid-out place. */
  enterMs: 240,
  /** The camera follows the grown graph; runs alongside the node's entrance, not after it. */
  fitMs: 300,
  /** Visible layout settling after a change; the bulk of the layout runs before the first frame. */
  settleMs: 380,
  /** One particle per lit DEPENDS_ON edge crosses it once in ~20 frames (~330 ms at 60 fps). */
  particleSpeed: 0.05,
} as const;
/** Layout ticks run before a changed graph is drawn, so what the user sees is nearly settled. */
const WARMUP_TICKS = 200;
/** Label text size in screen pixels, constant at every zoom. */
const LABEL_PX = 11;

/**
 * Keeps nodes apart so circles and the labels under them do not pile up (a d3 force with the
 * library's own velocity integration). O(n²), fine for the few hundred nodes a tenant shows.
 */
function collideForce(radius: (n: Node) => number, strength = 0.7) {
  let nodes: Node[] = [];
  const force = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i] as Node;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j] as Node;
        const dx = (b.x ?? 0) + (b.vx ?? 0) - (a.x ?? 0) - (a.vx ?? 0);
        const dy = (b.y ?? 0) + (b.vy ?? 0) - (a.y ?? 0) - (a.vy ?? 0);
        const min = radius(a) + radius(b);
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= min * min) continue;
        const dist = Math.sqrt(dist2) || 0.01;
        const push = ((min - dist) / dist) * strength * 0.5;
        // A jitter-free split for coincident nodes: push along x.
        const px = dist2 === 0 ? min * strength * 0.5 : dx * push;
        const py = dy * push;
        a.vx = (a.vx ?? 0) - px;
        a.vy = (a.vy ?? 0) - py;
        b.vx = (b.vx ?? 0) + px;
        b.vy = (b.vy ?? 0) + py;
      }
    }
  };
  return Object.assign(force, { initialize: (all: Node[]) => (nodes = all) });
}

/**
 * Earlier actions sit left, later right (a weak pull on x by seq), each agent in its own band on
 * y, plus a little gravity so a part with no links (a mitigation's draft email) stays near the
 * graph instead of drifting off and shrinking the fit. Everything it needs is read from the nodes
 * when the library hands them over, so it is registered once and serves every snapshot.
 */
function timeForce() {
  let nodes: Node[] = [];
  let min = 0;
  let span = 1;
  let width = 160;
  let agents: string[] = [];
  const band = (agentId: string) => (agents.indexOf(agentId) - (agents.length - 1) / 2) * 110;
  const force = (a: number) => {
    for (const n of nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      n.vx = (n.vx ?? 0) - n.x * 0.03 * a;
      n.vy = (n.vy ?? 0) - n.y * 0.03 * a;
      if (n.seq === undefined) continue;
      const target = ((n.seq - min) / span - 0.5) * width;
      n.vx = (n.vx ?? 0) + (target - n.x) * 0.08 * a;
      if (n.agentId && !isUndoSide(n)) {
        n.vy = (n.vy ?? 0) + (band(n.agentId) - n.y) * 0.05 * a;
      }
    }
  };
  const initialize = (all: Node[]) => {
    nodes = all;
    const seqs = all.flatMap((n) => (n.seq === undefined ? [] : [n.seq]));
    min = seqs.length > 0 ? Math.min(...seqs) : 0;
    span = Math.max(1, (seqs.length > 0 ? Math.max(...seqs) : 0) - min);
    width = Math.max(160, Math.sqrt(all.length) * 70);
    agents = [...new Set(all.flatMap((n) => (n.agentId && !isUndoSide(n) ? [n.agentId] : [])))];
  };
  return Object.assign(force, { initialize });
}

/** Ease-out for the entrance: fast start, soft landing (the design system's curve, roughly). */
const easeOut = (t: number) => 1 - (1 - t) ** 3;

export interface ForceCanvasProps {
  graph: ViewGraph;
  /** What is lit: a selection's closure, or an algorithm's result (only lit and litLinks). */
  closure: Pick<Closure, 'lit' | 'litLinks'> | null;
  /** Labels drawn beside nodes for an algorithm result: #1 ranks, C1 clusters, path steps. */
  badges?: Map<string, string>;
  selectedId: string | null;
  /** Node ids dimmed whatever is lit: recorded after the time scrubber's position. */
  faded?: Set<string>;
  reducedMotion: boolean;
  agentLabels: Record<string, string>;
  onSelect(actionId: string | null): void;
  /** Hover detail beyond the snapshot (args come from the run stream when it has them). */
  describe?(node: ViewNode): React.ReactNode;
}

export default function ForceCanvas({
  graph,
  closure,
  badges,
  selectedId,
  faded,
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
  // Once the user pans or zooms, the camera is theirs until they ask for the fit back.
  const [moved, setMoved] = useState(false);
  const movedRef = useRef(false);
  movedRef.current = moved;
  const press = useRef<{ x: number; y: number } | null>(null);
  // The forces are registered on the library's simulation after it mounts; until then the first
  // layout would run with the library's defaults, so the data is fed again once they are in.
  const [forcesReady, setForcesReady] = useState(false);
  const fitted = useRef(false);
  const mounted = size.width > 0 && size.height > 0;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  /**
   * Centre the graph and zoom to fit it, never closer than MAX_FIT_ZOOM. Skips moves too small
   * to see, so a settled layout does not add a second camera motion to the same change.
   */
  const fitView = useCallback((ms: number) => {
    const api = fg.current;
    const { width, height } = sizeRef.current;
    if (!api || width === 0 || movedRef.current) return;
    const bbox = api.getGraphBbox();
    if (!bbox || !Number.isFinite(bbox.x[0])) return;
    const pad = fitPadding(width);
    const k = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_FIT_ZOOM,
        (width - pad * 2) / Math.max(1, bbox.x[1] - bbox.x[0]),
        (height - pad * 2) / Math.max(1, bbox.y[1] - bbox.y[0]),
      ),
    );
    const cx = (bbox.x[0] + bbox.x[1]) / 2;
    const cy = (bbox.y[0] + bbox.y[1]) / 2;
    const now = api.zoom();
    const at = api.centerAt();
    const shift = Math.hypot((cx - at.x) * now, (cy - at.y) * now);
    if (fitted.current && Math.abs(k - now) / now < 0.04 && shift < 12) return;
    fitted.current = true;
    api.centerAt(cx, cy, ms);
    api.zoom(k, ms);
  }, []);

  // The blast chip opening or a breakpoint change resizes the canvas: fit again (instantly: the
  // layout itself moved, so a camera glide on top would be a second animation).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every size change
  useEffect(() => {
    if (!mounted) return;
    const timer = setTimeout(() => fitView(0), 50);
    return () => clearTimeout(timer);
  }, [size.width, size.height, mounted, fitView]);

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
  // the layout still while statuses change, and only new nodes grow in.
  const cache = useRef(new Map<string, Node>());
  // When each node first appeared, for its entrance; nodes of the first snapshot have none.
  const born = useRef(new Map<string, number>());
  const latest = useRef(graph);
  latest.current = graph;
  // Rebuilt only when a node or link is added or removed (structureKey); status changes mutate
  // the cached objects in place and just repaint, so the layout does not re-heat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: structureKey stands for the graph
  const data = useMemo(() => {
    const graph = latest.current;
    const next = new Map<string, Node>();
    const first = cache.current.size === 0;
    const now = performance.now();
    for (const view of graph.nodes) {
      const existing = cache.current.get(view.id);
      if (!existing && !first) born.current.set(view.id, now);
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
  }, [graph.structureKey, forcesReady]);

  // Keep the cached node fields current even when the structure did not change.
  useEffect(() => {
    for (const view of graph.nodes) {
      const node = cache.current.get(view.id);
      if (node) Object.assign(node, view);
    }
  }, [graph]);

  // Register the forces once the library has mounted; `data` is then fed again so its warm-up
  // ticks run with them (see forcesReady).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, after the canvas mounts
  useEffect(() => {
    const api = fg.current;
    if (!api || forcesReady) return;
    api.d3Force('time', timeForce());
    api.d3Force(
      'collide',
      collideForce((n) => (n.kind === 'entity' ? 11 : 14)),
    );
    api.d3Force('charge')?.strength?.(-90);
    // Repulsion only between neighbours: far parts are not pushed apart without limit.
    api.d3Force('charge')?.distanceMax?.(160);
    api.d3Force('link')?.distance?.((l: Link) => (l.type === 'DEPENDS_ON' ? 42 : 28));
    setForcesReady(true);
  }, [mounted, forcesReady]);

  // After each change the library has already run the warm-up ticks (children's effects run
  // before this one), so the positions are nearly final: the camera moves once, alongside the
  // entrance. The first fit is instant, so the panel never opens zoomed in on one node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `data` changing is the trigger
  useEffect(() => {
    if (!forcesReady) return;
    fitView(fitted.current && !reducedMotion ? MOTION.fitMs : 0);
  }, [data, forcesReady, reducedMotion, fitView]);

  const lit = closure?.lit ?? null;
  const litLinks = closure?.litLinks ?? null;
  const isLit = useCallback((id: string) => (!lit || lit.has(id)) && !faded?.has(id), [lit, faded]);

  /** 0 → 1 over the entrance; 1 for nodes that were there from the start or under reduced motion. */
  const grown = useCallback(
    (id: string) => {
      const t0 = born.current.get(id);
      if (t0 === undefined || reducedMotion) return 1;
      const t = (performance.now() - t0) / MOTION.enterMs;
      if (t >= 1) {
        born.current.delete(id);
        return 1;
      }
      return easeOut(Math.max(0, t));
    },
    [reducedMotion],
  );

  const paintNode = useCallback(
    (node: Node, ctx: CanvasRenderingContext2D) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const g = grown(node.id);
      ctx.globalAlpha = (isLit(node.id) ? 1 : DIM) * g;

      if (node.kind === 'entity') {
        const s = R * 0.8 * g;
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
        ctx.globalAlpha = 1;
        return;
      }

      const r = (node.actionKind === 'do' || node.actionKind === undefined ? R : R * 0.7) * g;
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
      // The one loop the spec allows: the pending ring breathes on a 1.2 s cycle.
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
      ctx.globalAlpha = 1;
    },
    [isLit, lit, palette, selectedId, reducedMotion, grown],
  );

  const paintPointer = useCallback((node: Node, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, R + 3, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  /** Each agent's actions, for its hull; undo steps sit next to what they undo and get none. */
  const agentGroups = useCallback(() => {
    const groups = new Map<string, Node[]>();
    for (const n of data.nodes) {
      if (n.kind !== 'action' || !n.agentId || isUndoSide(n) || n.x === undefined) continue;
      const group = groups.get(n.agentId) ?? [];
      group.push(n);
      groups.set(n.agentId, group);
    }
    return groups;
  }, [data.nodes]);

  // Agents as hulls: the convex hull of each agent's actions, stroked with a wide round join so
  // it pads out evenly, filled with the nested-surface color, outlined. The agent's name is drawn
  // with the other labels (paintLabels), so it takes part in the overlap check.
  const paintHulls = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      for (const nodes of agentGroups().values()) {
        ctx.globalAlpha = nodes.some((n) => isLit(n.id)) ? 1 : 0.5;
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
      }
      ctx.globalAlpha = 1;
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
    },
    [agentGroups, isLit, palette],
  );

  /**
   * Labels after everything else, placed so none overlaps another label or a node: the selection
   * and algorithm badges always, then lit actions, then the rest, entities last. A crowded action
   * keeps its seq number; a crowded entity shows nothing (both are in the hover tooltip and the
   * listbox). Sizes are screen pixels divided by the zoom, so labels read the same at any zoom.
   */
  const paintLabels = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      const size = LABEL_PX / scale;
      const height = size * 1.25;
      ctx.font = `${size}px ${palette.mono}`;
      const charW = ctx.measureText('0').width;
      const width = (text: string) => text.length * charW;
      const clip = (text: string) => (text.length > 22 ? `${text.slice(0, 21)}…` : text);
      const candidates: LabelCandidate[] = [];
      const obstacles: Obstacle[] = [];
      const meta = new Map<
        string,
        { color: string; font: string; alpha: number; align?: 'badge' }
      >();

      // Badges (#1, C2, From/To) sit up and right of their node and always show.
      for (const n of data.nodes) {
        const badge = badges?.get(n.id);
        if (!badge || n.x === undefined || n.y === undefined) continue;
        const id = `badge:${n.id}`;
        const w = width(badge) + 6 / scale;
        candidates.push({
          id,
          priority: 0,
          x: n.x + R + 2 + w / 2,
          y: n.y - R - 2 - height,
          height,
          variants: [{ text: badge, width: w }],
          always: true,
        });
        meta.set(id, { color: palette.fg, font: palette.mono, alpha: 1, align: 'badge' });
      }

      // Agent names above their hulls.
      for (const [agentId, nodes] of agentGroups()) {
        const top = nodes.reduce((a, b) => ((b.y ?? 0) < (a.y ?? 0) ? b : a));
        const text = agentLabels[agentId] ?? agentId;
        const id = `agent:${agentId}`;
        ctx.font = `500 ${size}px ${palette.sans}`;
        const w = ctx.measureText(text).width;
        ctx.font = `${size}px ${palette.mono}`;
        candidates.push({
          id,
          priority: 1,
          x: top.x ?? 0,
          y: (top.y ?? 0) - HULL_PAD - 3 / scale - height,
          height,
          variants: [{ text, width: w }],
          always: true,
        });
        const anyLit = nodes.some((n) => isLit(n.id));
        meta.set(id, { color: palette.fgMuted, font: palette.sans, alpha: anyLit ? 1 : 0.5 });
      }

      for (const n of data.nodes) {
        if (n.x === undefined || n.y === undefined) continue;
        const g = grown(n.id);
        const on = isLit(n.id);
        const r = n.kind === 'entity' ? R * 0.8 : isUndoSide(n) ? R * 0.7 : R;
        obstacles.push({ id: n.id, x0: n.x - r, y0: n.y - r, x1: n.x + r, y1: n.y + r });
        // Labels appear with their node, not before it has grown.
        if (g < 1) continue;
        // Below the node first, above it when below is taken.
        const above = n.y - r - 3 / scale - height;
        if (n.kind === 'entity') {
          const text = clip(entityShortLabel(n.id, n.title));
          candidates.push({
            id: n.id,
            priority: on && lit ? 3 : 6,
            x: n.x,
            y: n.y + r + 2 / scale,
            height,
            variants: [
              { text, width: width(text) },
              { text, width: width(text), y: above },
            ],
            ignore: n.id,
          });
          meta.set(n.id, { color: palette.fgMuted, font: palette.mono, alpha: on ? 1 : DIM });
          continue;
        }
        const seq = n.seq === undefined ? '' : String(n.seq);
        const full = clip(`${seq} ${n.tool ?? n.title}`.trim());
        const selected = n.id === selectedId;
        candidates.push({
          id: n.id,
          // Later actions first among equals: the newest step is the one being talked about.
          priority: selected ? 0 : on && lit ? 2 : on ? 4 : 5,
          x: n.x,
          y: n.y + r + 3 / scale,
          height,
          variants: [
            { text: full, width: width(full) },
            { text: full, width: width(full), y: above },
            ...(seq
              ? [
                  { text: seq, width: width(seq) },
                  { text: seq, width: width(seq), y: above },
                ]
              : []),
          ],
          always: selected,
          ignore: n.id,
        });
        meta.set(n.id, {
          color: selected ? palette.fg : palette.fgMuted,
          font: palette.mono,
          alpha: on ? 1 : DIM,
        });
      }
      // Newest actions first within a priority (placeLabels keeps input order for ties).
      candidates.sort((a, b) => {
        const sa = cache.current.get(a.id)?.seq ?? -1;
        const sb = cache.current.get(b.id)?.seq ?? -1;
        return sb - sa;
      });

      ctx.textBaseline = 'top';
      for (const label of placeLabels(candidates, obstacles)) {
        const m = meta.get(label.id);
        if (!m) continue;
        ctx.globalAlpha = m.alpha;
        if (m.align === 'badge') {
          const { x0, y0, x1, y1 } = label.rect;
          ctx.beginPath();
          ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 3 / scale);
          ctx.fillStyle = palette.surface2;
          ctx.fill();
          ctx.lineWidth = 1 / scale;
          ctx.strokeStyle = palette.accent;
          ctx.stroke();
          ctx.font = `500 ${size * 0.92}px ${palette.mono}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = m.color;
          ctx.fillText(label.text, x0 + 3 / scale, (y0 + y1) / 2);
          ctx.textBaseline = 'top';
          continue;
        }
        ctx.font = m.font === palette.sans ? `500 ${size}px ${m.font}` : `${size}px ${m.font}`;
        ctx.textAlign = 'center';
        const lx = (label.rect.x0 + label.rect.x1) / 2;
        // A halo in the page color keeps a label readable where an edge runs under it.
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = alpha(palette.bg, 0.85);
        ctx.strokeText(label.text, lx, label.rect.y0);
        ctx.fillStyle = m.color;
        ctx.fillText(label.text, lx, label.rect.y0);
      }
      ctx.globalAlpha = 1;
      ctx.lineJoin = 'miter';
    },
    [data.nodes, badges, agentGroups, agentLabels, isLit, lit, grown, selectedId, palette],
  );

  const linkOn = useCallback(
    (l: Link) =>
      (!litLinks || litLinks.has(linkKey(endId(l.source), endId(l.target), l.type))) &&
      !faded?.has(endId(l.source)) &&
      !faded?.has(endId(l.target)),
    [litLinks, faded],
  );
  const linkColor = useCallback(
    (l: Link) => {
      const on = linkOn(l);
      const g = Math.min(grown(endId(l.source)), grown(endId(l.target)));
      if (l.type === 'DEPENDS_ON') {
        if (litLinks && on) return alpha(palette.accent, g);
        return alpha(palette.fgMuted, (on ? 0.55 : 0.55 * DIM) * g);
      }
      if (l.type === 'UNDOES') return alpha(palette.green, (on ? 0.7 : 0.7 * DIM) * g);
      if (litLinks && on) return alpha(palette.accent, 0.6 * g);
      return alpha(palette.fgMuted, (on ? 0.3 : 0.3 * DIM) * g);
    },
    [linkOn, litLinks, palette, grown],
  );
  const linkWidth = useCallback((l: Link) => (l.type === 'DEPENDS_ON' ? 2 : 0.6), []);
  const linkDash = useCallback(
    (l: Link) => (l.type === 'READ' ? [2, 2] : l.type === 'UNDOES' ? [3, 2] : null),
    [],
  );
  const arrowLength = useCallback((l: Link) => (l.type === 'DEPENDS_ON' ? 5 : 0), []);

  // Particles cross each lit DEPENDS_ON edge once, toward the dependency, when what is lit
  // changes: the spec's "particles flow along dependency edges" as one motion under 400 ms, not
  // a loop (only the pending pulse loops). Reduced motion: none.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires when the lit set changes
  useEffect(() => {
    const api = fg.current;
    if (!api || reducedMotion || !litLinks) return;
    for (const l of data.links) if (l.type === 'DEPENDS_ON' && linkOn(l)) api.emitParticle(l);
  }, [litLinks, reducedMotion]);

  const pending = graph.nodes.some((n) => n.status === 'pending');

  const markMoved = () => {
    if (!movedRef.current) setMoved(true);
    movedRef.current = true;
  };

  return (
    <div
      ref={box}
      className="relative size-full"
      // A pan is a press that travels; a click on a node (a selection) leaves the camera alone.
      onPointerDown={(e) => {
        press.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && e.buttons > 0 && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) markMoved();
      }}
      onPointerUp={() => {
        press.current = null;
      }}
      onWheel={markMoved}
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
          linkDirectionalParticleWidth={2.6}
          linkDirectionalParticleSpeed={MOTION.particleSpeed}
          linkDirectionalParticleColor={() => palette.accent}
          onRenderFramePre={paintHulls}
          onRenderFramePost={paintLabels}
          // The pending pulse is the one loop allowed; it needs frames while the layout is idle.
          autoPauseRedraw={!(pending && !reducedMotion)}
          // Most of the layout runs before the first frame of each change; what is left plays
          // for at most settleMs. Reduced motion: none of it plays.
          warmupTicks={WARMUP_TICKS}
          cooldownTicks={reducedMotion ? 0 : Number.POSITIVE_INFINITY}
          cooldownTime={reducedMotion ? 0 : MOTION.settleMs}
          d3VelocityDecay={0.35}
          onEngineStop={() => fitView(reducedMotion ? 0 : MOTION.fitMs)}
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
          minZoom={MIN_ZOOM}
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
      {moved ? (
        <Button
          variant="secondary"
          size="xs"
          className="absolute right-2 bottom-2"
          onClick={() => {
            movedRef.current = false;
            setMoved(false);
            fitted.current = true;
            fitView(reducedMotion ? 0 : MOTION.fitMs);
          }}
        >
          <Maximize2 aria-hidden />
          Fit graph
        </Button>
      ) : null}
    </div>
  );
}
