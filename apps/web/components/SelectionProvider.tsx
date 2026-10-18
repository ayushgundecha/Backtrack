'use client';

/**
 * Which action the user picked in the graph, at which depth, and what the graph answered for it.
 * Kept apart from BacktrackProvider because it is view state: the graph, the blast chip and the
 * explain drawer share it; the run stream and undo console do not need to re-render with it.
 */
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Closure, closureFromOutcome } from '@/lib/graph-model';
import { type DepthRejection, depthAfterFailure } from '@/lib/undo';
import { useBacktrack } from './BacktrackProvider';

export const MIN_DEPTH = 1;
export const MAX_DEPTH = 5;

type ClosureStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SelectionValue {
  selectedId: string | null;
  depth: number;
  closure: Closure | null;
  status: ClosureStatus;
  error: string | null;
  select(actionId: string | null): void;
  /** The user's choice of depth (the slider); clears an earlier rejection. */
  setDepth(depth: number): void;
  /**
   * The last depth the graph did not answer, kept on screen until the user picks a depth or an
   * action again. The slider has already gone back to the depth that is shown.
   */
  rejected: DepthRejection | null;
  /**
   * An ask at `asked` failed somewhere else (the undo console re-planning): put the slider back on
   * `shown`, the depth still on screen, and report the failure.
   */
  rejectDepth(asked: number, shown: number, message: string): void;
  /** Ask again at the current depth after an error with nothing to fall back to. */
  retry(): void;
  /** The action the explain drawer shows; null when it is closed. */
  explainId: string | null;
  openExplain(actionId: string): void;
  closeExplain(): void;
}

const SelectionContext = createContext<SelectionValue | null>(null);

export function useSelection(): SelectionValue {
  const value = use(SelectionContext);
  if (!value) throw new Error('useSelection must be used inside <SelectionProvider>');
  return value;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const { state, actions } = useBacktrack();
  const { graph } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Depth 1 first: the demo drags 1 → 3 to reveal the billing agent's credit.
  const [depth, setDepthState] = useState(MIN_DEPTH);
  const [closure, setClosure] = useState<Closure | null>(null);
  const [status, setStatus] = useState<ClosureStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [explainId, setExplainId] = useState<string | null>(null);
  const [rejected, setRejected] = useState<DepthRejection | null>(null);
  const [attempt, setAttempt] = useState(0);
  const closureRef = useRef(closure);
  closureRef.current = closure;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const generation = useRef(0);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Re-ask when an action is added or changes status (an undo turns its closure dashed), not on
  // every snapshot: each ask proposes a plan, so asking only when the answer can change.
  const liveSignature = useMemo(
    () =>
      graph?.nodes
        .filter((n) => n.label === 'Action')
        .map((n) => `${n.id}:${n.status}`)
        .join(',') ?? '',
    [graph],
  );
  // While a run or an undo streams, every step changes the answer; asking after each one would
  // record a plan per step. The closure holds still until the stream ends, then asks once.
  const settled = useRef(liveSignature);
  if (!state.streaming) settled.current = liveSignature;
  const signature = settled.current;
  const selectedExists =
    selectedId !== null && !!graph?.nodes.some((n) => n.id === selectedId && n.label === 'Action');

  useEffect(() => {
    if (selectedId && graph && !selectedExists) {
      // The action left the graph (world reset): drop the selection instead of asking about it.
      setSelectedId(null);
    }
  }, [selectedId, selectedExists, graph]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` and `attempt` re-ask
  useEffect(() => {
    const id = ++generation.current;
    if (!selectedId || !selectedExists) {
      setClosure(null);
      setStatus('idle');
      setError(null);
      return;
    }
    setStatus('loading');
    actions
      .previewUndo(selectedId, depth)
      .then((outcome) => {
        const snapshot = graphRef.current;
        if (id !== generation.current || !snapshot) return;
        setClosure(closureFromOutcome(outcome, selectedId, depth, snapshot));
        setStatus('ready');
        setError(null);
      })
      .catch((reason: unknown) => {
        if (id !== generation.current) return;
        const message = messageOf(reason);
        // An answer at another depth is still lit: go back to it rather than leave the slider
        // on a depth nothing on screen reflects (see depthAfterFailure).
        const shown = closureRef.current?.rootId === selectedId ? closureRef.current.depth : null;
        if (shown !== null && shown !== depth) {
          setRejected({ depth, message });
          setDepthState((current) => depthAfterFailure(current, depth, shown));
          setStatus('ready');
          setError(null);
          return;
        }
        setStatus('error');
        setError(message);
      });
  }, [actions, selectedId, selectedExists, depth, signature, attempt]);

  // While the drawer is open, picking another action in the graph explains that one instead.
  const select = useCallback((actionId: string | null) => {
    // A rejection is about the action it was asked for; another action starts clean.
    if (actionId !== selectedRef.current) setRejected(null);
    setSelectedId(actionId);
    if (actionId) setExplainId((open) => (open ? actionId : open));
  }, []);
  const openExplain = useCallback((actionId: string) => setExplainId(actionId), []);
  const closeExplain = useCallback(() => setExplainId(null), []);
  const setDepth = useCallback((next: number) => {
    setRejected(null);
    setDepthState(Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.round(next))));
  }, []);
  const rejectDepth = useCallback((asked: number, shown: number, message: string) => {
    setRejected({ depth: asked, message });
    setDepthState((current) => depthAfterFailure(current, asked, shown));
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo<SelectionValue>(
    () => ({
      selectedId,
      depth,
      closure,
      status,
      error,
      select,
      setDepth,
      rejected,
      rejectDepth,
      retry,
      explainId,
      openExplain,
      closeExplain,
    }),
    [
      selectedId,
      depth,
      closure,
      status,
      error,
      select,
      setDepth,
      rejected,
      rejectDepth,
      retry,
      explainId,
      openExplain,
      closeExplain,
    ],
  );
  return <SelectionContext value={value}>{children}</SelectionContext>;
}
