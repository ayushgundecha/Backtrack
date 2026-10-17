'use client';

/**
 * The one place that knows where data comes from. Components read `{ state, actions, meta }`
 * through useBacktrack() and never see the ApiClient, so swapping the mock for the real API
 * (or adding a tenant switcher later) touches only this file.
 */
import type {
  AgentId,
  GraphSnapshot,
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
import { type ApiClient, createApiClient } from '@/lib/api';
import { initialSession, type SessionState, sessionReducer } from '@/lib/session';

type Connection = 'connecting' | 'ok' | 'error';

interface BacktrackState {
  session: SessionState;
  graph: GraphSnapshot | null;
  world: WorldSnapshot | null;
  connection: Connection;
  /** True while an agent run or an undo is streaming. */
  streaming: boolean;
  undoOutcome: UndoOutcome | null;
}

interface BacktrackActions {
  runAgent(agent: AgentId, mode: RunMode): void;
  answerApproval(runId: string, actionId: string, approved: boolean): void;
  resetWorld(): void;
  requestUndo(text: string): Promise<void>;
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
  const [streaming, setStreaming] = useState(false);
  const [undoOutcome, setUndoOutcome] = useState<UndoOutcome | null>(null);
  const stream = useRef<AbortController | null>(null);
  // Responses can arrive out of order while events stream; only the newest read is applied.
  const readGeneration = useRef(0);

  const refresh = useCallback(async (from: ApiClient) => {
    const generation = ++readGeneration.current;
    try {
      const [nextGraph, nextWorld] = await Promise.all([from.graph(), from.world()]);
      if (generation !== readGeneration.current) return;
      setGraph(nextGraph);
      setWorld(nextWorld);
      setConnection('ok');
    } catch (error) {
      if (generation !== readGeneration.current) return;
      setConnection('error');
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
          if (event.type === 'error') toast.error(event.message);
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

  const actions = useMemo<BacktrackActions>(
    () => ({
      runAgent(agent, mode) {
        void consume((signal) => (client as ApiClient).runAgent({ agent, mode }, signal));
      },
      answerApproval(runId, actionId, approved) {
        client
          ?.approval({ runId, actionId, approved })
          .then(({ ok }) => {
            if (!ok)
              toast.error(
                `Approval for ${actionId} was not accepted: the run is no longer waiting.`,
              );
          })
          .catch((error: unknown) => toast.error(messageOf(error)));
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
            toast.success('World reset to the seed.');
            return refresh(client);
          })
          .catch((error: unknown) => toast.error(messageOf(error)));
      },
      async requestUndo(text) {
        if (!client) return;
        try {
          setUndoOutcome(await client.undo({ text }));
          void refresh(client);
        } catch (error) {
          toast.error(messageOf(error));
        }
      },
    }),
    [client, consume, refresh],
  );

  const value = useMemo<BacktrackContextValue>(
    () => ({
      state: { session, graph, world, connection, streaming, undoOutcome },
      actions,
      meta: { source: client?.kind ?? null, tenant },
    }),
    [session, graph, world, connection, streaming, undoOutcome, actions, client, tenant],
  );

  return <BacktrackContext value={value}>{children}</BacktrackContext>;
}
