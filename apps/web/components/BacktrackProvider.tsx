'use client';

/**
 * The one place that knows where data comes from. Components read `{ state, actions, meta }`
 * through useBacktrack() and never see the ApiClient, so swapping the mock for the real API
 * (or adding a tenant switcher later) touches only this file.
 */
import type {
  AgentId,
  Explain,
  GraphSnapshot,
  RehearsalDiff,
  RunEvent,
  RunMode,
  UndoOutcome,
  WorldSnapshot,
} from '@backtrack/core/contracts';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { type ApiClient, createApiClient, type UndoRequest } from '@/lib/api';
import { initialSession, type SessionState, sessionReducer } from '@/lib/session';

type Connection = 'connecting' | 'ok' | 'error';

interface BacktrackState {
  session: SessionState;
  graph: GraphSnapshot | null;
  world: WorldSnapshot | null;
  connection: Connection;
  /** Why the last read of graph and world failed (the route's message); null after a good read. */
  loadError: string | null;
  /** True while an agent run or an undo is streaming. */
  streaming: boolean;
  undoOutcome: UndoOutcome | null;
}

interface BacktrackActions {
  runAgent(agent: AgentId, mode: RunMode): void;
  /** Resolves true once the run accepted the answer; false (with a toast) otherwise. */
  answerApproval(runId: string, actionId: string, approved: boolean): Promise<boolean>;
  resetWorld(): void;
  /**
   * Plain words, or an exact action (⌘Z prefill, a candidate) with an optional depth. Resolves
   * with the outcome now shown in the console, or null after a toasted error.
   */
  requestUndo(request: string | UndoRequest): Promise<UndoOutcome | null>;
  /** Runs the plan on a GRAPH.COPY fork and returns the diff; null after a toasted error. */
  rehearseUndo(planId: string): Promise<RehearsalDiff | null>;
  /** Streams undo.step events into the session; resolves when the stream ends. */
  executeUndo(planId: string): Promise<void>;
  /**
   * Reads for the graph view and explain drawer. They resolve or reject to the caller (no toast)
   * and do not refresh the graph: browsing proposes a plan (Q1 + Q3) but changes nothing.
   */
  previewUndo(actionId: string, depth: number): Promise<UndoOutcome>;
  explain(actionId: string): Promise<Explain>;
  /** The world right after action `asOfSeq` (time scrubber); the live world is `state.world`. */
  worldAt(asOfSeq: number): Promise<WorldSnapshot>;
  /** Reads graph and world again, e.g. from an error state's Retry button. */
  retry(): void;
}

interface BacktrackMeta {
  /** null until the client is chosen; 'mock' means nothing on screen came from FalkorDB. */
  source: ApiClient['kind'] | null;
  tenant: string;
}

interface BacktrackContextValue {
  state: BacktrackState;
  actions: BacktrackActions;
  meta: BacktrackMeta;
}

const BacktrackContext = createContext<BacktrackContextValue | null>(null);

export function useBacktrack(): BacktrackContextValue {
  const value = use(BacktrackContext);
  if (!value) throw new Error('useBacktrack must be used inside <BacktrackProvider>');
  return value;
}

/** Events after which the graph and world have changed and are re-read from the source. */
const CHANGES_GRAPH = new Set<RunEvent['type']>([
  'action.recorded',
  'approval.requested',
  'approval.resolved',
  'action.blocked',
  'undo.step',
  'run.finished',
  'undo.finished',
]);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The reset route is guarded by RESET_TOKEN; the panel asks for it once per browser session. */
function resetToken(source: ApiClient['kind']): string | null {
  if (source === 'mock') return 'mock';
  const saved = sessionStorage.getItem('bt:reset-token');
  if (saved) return saved;
  const entered = window.prompt('Reset token (RESET_TOKEN)');
  if (entered) sessionStorage.setItem('bt:reset-token', entered);
  return entered;
}

export function BacktrackProvider({
  tenant = 'demo',
  children,
}: {
  tenant?: string;
  children: React.ReactNode;
}) {
  const [client, setClient] = useState<ApiClient | null>(null);
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [undoOutcome, setUndoOutcome] = useState<UndoOutcome | null>(null);
  const stream = useRef<AbortController | null>(null);
  // Undo answers by `actionId:depth`, shared by the graph preview and the console, so the two
  // views of one depth cost one request. The engine itself answers an identical proposal with
  // the same plan; this only saves the round trip. Cleared whenever the answer can change: an
  // action is added or changes status, a plan is rehearsed or executed, the world is reset.
  const answers = useRef(new Map<string, Promise<UndoOutcome>>());
  const actionSignature = useRef('');
  // Responses can arrive out of order while events stream; only the newest read is applied.
  const readGeneration = useRef(0);

  const refresh = useCallback(async (from: ApiClient) => {
    const generation = ++readGeneration.current;
    try {
      const [nextGraph, nextWorld] = await Promise.all([from.graph(), from.world()]);
      if (generation !== readGeneration.current) return;
      const signature = nextGraph.nodes
        .filter((n) => n.label === 'Action')
        .map((n) => `${n.id}:${n.status}`)
        .join(',');
      if (signature !== actionSignature.current) {
        actionSignature.current = signature;
        answers.current.clear();
      }
      setGraph(nextGraph);
      setWorld(nextWorld);
      setConnection('ok');
      setLoadError(null);
    } catch (error) {
      if (generation !== readGeneration.current) return;
      setConnection('error');
      setLoadError(messageOf(error));
      toast.error(messageOf(error));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    createApiClient(tenant).then((created) => {
      if (cancelled) return;
      setClient(created);
      void refresh(created);
    });
    return () => {
      cancelled = true;
      stream.current?.abort();
    };
  }, [tenant, refresh]);

  /** Consumes one event stream; the graph is re-read after every event that changed it. */
  const consume = useCallback(
    async (open: (signal: AbortSignal) => AsyncIterable<RunEvent>) => {
      if (!client || stream.current) return;
      const controller = new AbortController();
      stream.current = controller;
      setStreaming(true);
      try {
        for await (const event of open(controller.signal)) {
          dispatch(event);
          // A failure names its run; an error without one is the server explaining a fallback
          // (live mode showing the replay). Both are also kept inline in the run stream.
          if (event.type === 'error') {
            if (event.runId) toast.error(event.message);
            else toast.warning(event.message);
          }
          if (CHANGES_GRAPH.has(event.type)) void refresh(client);
        }
      } catch (error) {
        if (!controller.signal.aborted) toast.error(messageOf(error));
      } finally {
        if (stream.current === controller) stream.current = null;
        setStreaming(false);
      }
    },
    [client, refresh],
  );

  /** One undo answer per action and depth while the graph stays the same (see `answers`). */
  const askUndo = useCallback(
    (from: ApiClient, actionId: string, depth: number): Promise<UndoOutcome> => {
      const key = `${actionId}:${depth}`;
      const cached = answers.current.get(key);
      if (cached) return cached;
      const asked = from.undo({ actionId, depth });
      answers.current.set(key, asked);
      // A failed ask (a 429, say) is not an answer: the next ask goes to the server again.
      asked.catch(() => {
        if (answers.current.get(key) === asked) answers.current.delete(key);
      });
      return asked;
    },
    [],
  );

  const actions = useMemo<BacktrackActions>(
    () => ({
      runAgent(agent, mode) {
        void consume((signal) => (client as ApiClient).runAgent({ agent, mode }, signal));
      },
      async answerApproval(runId, actionId, approved) {
        if (!client) return false;
        try {
          const { ok } = await client.approval({ runId, actionId, approved });
          if (!ok)
            toast.error(`Approval for ${actionId} was not accepted: the run is no longer waiting.`);
          return ok;
        } catch (error) {
          toast.error(messageOf(error));
          return false;
        }
      },
      resetWorld() {
        if (!client) return;
        const token = resetToken(client.kind);
        if (!token) return;
        stream.current?.abort();
        client
          .reset(token)
          .then(() => {
            dispatch({ type: 'session.reset' });
            setUndoOutcome(null);
            answers.current.clear();
            toast.success('World reset to the seed.');
            return refresh(client);
          })
          .catch((error: unknown) => toast.error(messageOf(error)));
      },
      async requestUndo(request) {
        if (!client) return null;
        try {
          let outcome: UndoOutcome;
          if (typeof request !== 'string' && request.actionId && request.depth !== undefined) {
            outcome = await askUndo(client, request.actionId, request.depth);
          } else {
            outcome = await client.undo(typeof request === 'string' ? { text: request } : request);
            // Words resolved to a plan: the graph preview of the same root and depth reuses it.
            if (outcome.kind === 'plan') {
              const { rootActionId, depth } = outcome.plan;
              answers.current.set(`${rootActionId}:${depth}`, Promise.resolve(outcome));
            }
          }
          setUndoOutcome(outcome);
          void refresh(client);
          return outcome;
        } catch (error) {
          toast.error(messageOf(error));
          return null;
        }
      },
      async rehearseUndo(planId) {
        if (!client) return null;
        try {
          const diff = await client.rehearse(planId);
          // The plan is now 'rehearsed' in the graph; a new ask must not be answered with it.
          answers.current.clear();
          void refresh(client);
          return diff;
        } catch (error) {
          toast.error(messageOf(error));
          return null;
        }
      },
      executeUndo(planId) {
        answers.current.clear();
        return consume((signal) => (client as ApiClient).executeUndo(planId, signal));
      },
      previewUndo(actionId, depth) {
        if (!client) return Promise.reject(new Error('Not connected yet.'));
        return askUndo(client, actionId, depth);
      },
      explain(actionId) {
        if (!client) return Promise.reject(new Error('Not connected yet.'));
        return client.explain(actionId);
      },
      worldAt(asOfSeq) {
        if (!client) return Promise.reject(new Error('Not connected yet.'));
        return client.world(asOfSeq);
      },
      retry() {
        if (!client) return;
        setConnection('connecting');
        void refresh(client);
      },
    }),
    [client, consume, refresh, askUndo],
  );

  const value = useMemo<BacktrackContextValue>(
    () => ({
      state: { session, graph, world, connection, loadError, streaming, undoOutcome },
      actions,
      meta: { source: client?.kind ?? null, tenant },
    }),
    [session, graph, world, connection, loadError, streaming, undoOutcome, actions, client, tenant],
  );

  return <BacktrackContext value={value}>{children}</BacktrackContext>;
}
