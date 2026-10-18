'use client';

/**
 * Which action the user picked in the graph, at which depth, and what the graph answered for it.
 * Kept apart from BacktrackProvider because it is view state: the graph, the blast chip and the
 * explain drawer share it; the run stream and undo console do not need to re-render with it.
 */
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Closure, closureFromOutcome } from '@/lib/graph-model';
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
  setDepth(depth: number): void;
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
  const generation = useRef(0);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Re-ask when an action is added or changes status (an undo turns its closure dashed), not on
  // every snapshot: each ask proposes a plan, so asking only when the answer can change.
  const signature = useMemo(
    () =>
      graph?.nodes
        .filter((n) => n.label === 'Action')
        .map((n) => `${n.id}:${n.status}`)
        .join(',') ?? '',
    [graph],
  );
  const selectedExists =
    selectedId !== null && !!graph?.nodes.some((n) => n.id === selectedId && n.label === 'Action');

  useEffect(() => {
    if (selectedId && graph && !selectedExists) {
      // The action left the graph (world reset): drop the selection instead of asking about it.
      setSelectedId(null);
    }
  }, [selectedId, selectedExists, graph]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` re-asks when the answer can change
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
        setStatus('error');
        setError(messageOf(reason));
      });
  }, [actions, selectedId, selectedExists, depth, signature]);

  // While the drawer is open, picking another action in the graph explains that one instead.
  const select = useCallback((actionId: string | null) => {
    setSelectedId(actionId);
    if (actionId) setExplainId((open) => (open ? actionId : open));
  }, []);
  const openExplain = useCallback((actionId: string) => setExplainId(actionId), []);
  const closeExplain = useCallback(() => setExplainId(null), []);
  const setDepth = useCallback(
    (next: number) => setDepthState(Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.round(next)))),
    [],
  );

  const value = useMemo<SelectionValue>(
    () => ({
      selectedId,
      depth,
      closure,
      status,
      error,
      select,
      setDepth,
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
      explainId,
      openExplain,
      closeExplain,
    ],
  );
  return <SelectionContext value={value}>{children}</SelectionContext>;
}
