'use client';

/**
 * The layout from PLAN §7.3: top bar, then graph / run stream + undo / world at 40 / 35 / 25
 * from 1280 px; graph and run stream at 50 / 50 with the world in a drawer from 1024 px;
 * one stacked column below that, graph first.
 */
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBacktrack } from './BacktrackProvider';
import { GraphView, graphCounts } from './GraphView';
import { Pane, PaneBody } from './Pane';
import { RunStream } from './RunStream';
import { TopBar } from './TopBar';
import { UndoConsole } from './UndoConsole';
import { WorldPanel } from './WorldPanel';

export function Shell() {
  const { state, actions, meta } = useBacktrack();
  // A later read failed but an earlier one succeeded: the panes keep the last good read and say so.
  const stale = state.loadError !== null && state.graph !== null;
  const counts = graphCounts(state.graph);
  const entities = state.world?.entities.length;

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <a
        href="#main"
        className="sr-only rounded-md bg-surface-2 px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to the panels
      </a>
      <TopBar />
      {stale ? (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-surface-2 px-4 py-2 text-sm"
        >
          <span>
            Showing the last read of bt:{meta.tenant}; the latest read failed:{' '}
            <span className="font-mono text-code text-fg-muted">{state.loadError}</span>
          </span>
          <Button variant="secondary" size="xs" onClick={actions.retry}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        </div>
      ) : null}
      <main
        id="main"
        className="grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1.75fr)_minmax(0,1.25fr)]"
      >
        <Pane
          id="graph"
          title="Graph"
          source={
            counts
              ? `GET /api/graph · ${counts.actions} actions · ${counts.dependencies} DEPENDS_ON`
              : null
          }
          className="border-b lg:border-r lg:border-b-0"
        >
          <PaneBody>
            <GraphView />
          </PaneBody>
        </Pane>
        <Pane id="run" title="Run" className="border-b lg:border-b-0 xl:border-r">
          <PaneBody>
            <RunStream />
          </PaneBody>
          <div className="shrink-0 border-t bg-surface p-4">
            <UndoConsole />
          </div>
        </Pane>
        <Pane
          id="world"
          title="World"
          source={entities === undefined ? null : `GET /api/world · ${entities} entities`}
          className="lg:hidden xl:flex"
        >
          <PaneBody>
            <WorldPanel />
          </PaneBody>
        </Pane>
      </main>
    </div>
  );
}
