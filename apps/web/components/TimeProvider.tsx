'use client';

/**
 * Where the time scrubber stands, and the world as GET /api/world?asOfSeq= returned it there.
 * Shared by the scrubber, the world panel (which shows the frame instead of the live world) and
 * the graph (which dims what came later). View state, so it lives apart from BacktrackProvider.
 */
import type { WorldSnapshot } from '@backtrack/core/contracts';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Stop, stopIndex, stops as stopsOf, timeline } from '@/lib/time-travel';
import { useBacktrack } from './BacktrackProvider';

type FrameStatus = 'idle' | 'loading' | 'ready' | 'error';

interface TimeValue {
  /** null = now (the live world); a number = right after the action with that seq. */
  asOfSeq: number | null;
  stops: Stop[];
  /** Index into `stops` of the current position. */
  index: number;
  /** The last frame that arrived for a scrubbed position; its own asOfSeq says which. */
  frame: WorldSnapshot | null;
  /** What the world panel shows: the frame while scrubbed, the live world at now. */
  world: WorldSnapshot | null;
  status: FrameStatus;
  error: string | null;
  scrubTo(asOfSeq: number | null): void;
}

const TimeContext = createContext<TimeValue | null>(null);

export function useTime(): TimeValue {
  const value = use(TimeContext);
  if (!value) throw new Error('useTime must be used inside <TimeProvider>');
  return value;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function TimeProvider({ children }: { children: React.ReactNode }) {
  const { state, actions } = useBacktrack();
  const { graph, world: live, streaming } = state;
  const [asOfSeq, setAsOfSeq] = useState<number | null>(null);
  const [frame, setFrame] = useState<WorldSnapshot | null>(null);
  const [status, setStatus] = useState<FrameStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const all = useMemo(() => stopsOf(timeline(graph)), [graph]);
  // Frames are cached per graph read: dragging back and forth asks each seq once, and any new
  // recording (a new snapshot) drops them, since an undo or a human edit can change the fold.
  const cache = useMemo(() => {
    void graph;
    return new Map<number, WorldSnapshot>();
  }, [graph]);

  // A run or an undo streams into the live world; watching it scrubbed back would hide it.
  useEffect(() => {
    if (streaming) setAsOfSeq(null);
  }, [streaming]);
  // After a reset there is no history left to stand in.
  useEffect(() => {
    if (all.length === 1) setAsOfSeq(null);
  }, [all.length]);

  useEffect(() => {
    const id = ++generation.current;
    if (asOfSeq === null) {
      setStatus('idle');
      setError(null);
      return;
    }
    const cached = cache.get(asOfSeq);
    if (cached) {
      setFrame(cached);
      setStatus('ready');
      setError(null);
      return;
    }
    setStatus('loading');
    actions
      .worldAt(asOfSeq)
      .then((next) => {
        cache.set(asOfSeq, next);
        if (id !== generation.current) return;
        setFrame(next);
        setStatus('ready');
        setError(null);
      })
      .catch((reason: unknown) => {
        if (id !== generation.current) return;
        setStatus('error');
        setError(messageOf(reason));
      });
  }, [actions, asOfSeq, cache]);

  const scrubTo = useCallback((next: number | null) => setAsOfSeq(next), []);

  const value = useMemo<TimeValue>(
    () => ({
      asOfSeq,
      stops: all,
      index: stopIndex(all, asOfSeq),
      frame,
      world: asOfSeq === null ? live : (frame ?? live),
      status,
      error,
      scrubTo,
    }),
    [asOfSeq, all, frame, live, status, error, scrubTo],
  );
  return <TimeContext value={value}>{children}</TimeContext>;
}
