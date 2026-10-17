'use client';

/**
 * Frame-rate check for BT-042 ("60 fps with 200 nodes"). Renders the real ForceCanvas over a
 * synthetic 200-node snapshot and measures requestAnimationFrame cadence in two phases: while the
 * layout settles, then with an action selected (dimming, lit closure, particles). Synthetic data
 * only, labelled as such; nothing here comes from FalkorDB.
 */
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import { type Closure, linkKey, syntheticSnapshot, toViewGraph } from '@/lib/graph-model';
import { agentName } from '@/lib/tools';

const ForceCanvas = dynamic(() => import('./ForceCanvas'), { ssr: false });

const ACTIONS = 160;
const ENTITIES = 40;
const ROOT = 'act_40';
const PHASE_MS = 5000;

interface Sample {
  phase: string;
  frames: number;
  fps: number;
  p95: number;
  worst: number;
}

/** Counts animation frames for `ms` and summarises their spacing. */
function measure(phase: string, ms: number): Promise<Sample> {
  return new Promise((resolve) => {
    const gaps: number[] = [];
    let last = performance.now();
    const start = last;
    const tick = (now: number) => {
      gaps.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else {
        const sorted = [...gaps].sort((a, b) => a - b);
        const elapsed = now - start;
        resolve({
          phase,
          frames: gaps.length,
          fps: Math.round((gaps.length / elapsed) * 1000 * 10) / 10,
          p95: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10,
          worst: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
        });
      }
    };
    requestAnimationFrame(tick);
  });
}

export function GraphPerf() {
  const snapshot = useMemo(() => syntheticSnapshot(ACTIONS, ENTITIES), []);
  const view = useMemo(() => toViewGraph(snapshot), [snapshot]);
  const [selected, setSelected] = useState<string | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);

  // The synthetic closure is computed here, not asked of a graph: this page measures drawing only.
  const closure = useMemo<Closure | null>(() => {
    if (!selected) return null;
    const lit = new Set([selected]);
    let frontier = [selected];
    for (let hop = 0; hop < 3; hop++) {
      const next: string[] = [];
      for (const l of snapshot.links)
        if (l.type === 'DEPENDS_ON' && frontier.includes(l.target) && !lit.has(l.source)) {
          lit.add(l.source);
          next.push(l.source);
        }
      frontier = next;
    }
    const litLinks = new Set(
      snapshot.links
        .filter((l) => l.type === 'DEPENDS_ON' && lit.has(l.source) && lit.has(l.target))
        .map((l) => linkKey(l.source, l.target, l.type)),
    );
    return {
      rootId: selected,
      depth: 3,
      outcome: 'plan',
      members: [],
      lit,
      litLinks,
      blast: null,
      crossAgents: [],
      planId: null,
      note: null,
    };
  }, [selected, snapshot]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Let the page boot (hydration, first layout) before counting frames.
      await new Promise((r) => setTimeout(r, 1000));
      if (cancelled) return;
      const settling = await measure('Layout settling, nothing selected', PHASE_MS);
      if (cancelled) return;
      setSamples([settling]);
      setSelected(ROOT);
      const lit = await measure('Action selected: closure lit, particles flowing', PHASE_MS);
      if (cancelled) return;
      setSamples([settling, lit]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const done = samples.length === 2;
  return (
    <main className="flex h-dvh flex-col gap-3 p-4">
      <h1 className="font-semibold text-base">Graph frame-rate check</h1>
      <p className="text-fg-muted text-sm">
        Synthetic data: {view.nodes.length} nodes ({ACTIONS} actions, {ENTITIES} entities) and{' '}
        {view.links.length} links, drawn by the same canvas as the panel. Not from FalkorDB.
      </p>
      <output
        aria-live="polite"
        data-done={done}
        data-samples={JSON.stringify(samples)}
        className="font-mono text-sm"
      >
        {samples.length === 0 ? 'Measuring…' : null}
        {samples.map((s) => (
          <span key={s.phase} className="block">
            {s.phase}: {s.fps} fps over {s.frames} frames, p95 frame {s.p95} ms, worst {s.worst} ms
          </span>
        ))}
      </output>
      {/* The graph pane's canvas size at 1440 × 900 (40 % column minus padding), so the check
          draws as many pixels per frame as the panel does. */}
      <div className="relative h-[640px] w-[544px] rounded-lg border">
        <ForceCanvas
          graph={view}
          closure={closure}
          selectedId={selected}
          reducedMotion={false}
          agentLabels={agentName}
          onSelect={setSelected}
        />
      </div>
    </main>
  );
}
