'use client';

/**
 * The layout from PLAN §7.3: top bar, then graph / run stream + undo / world at 40 / 35 / 25
 * from 1280 px; graph and run stream at 50 / 50 with the world in a drawer from 1024 px;
 * one stacked column below that, graph first.
 */
import { useBacktrack } from './BacktrackProvider';
import { GraphView, graphCounts } from './GraphView';
import { Pane, PaneBody } from './Pane';
import { RunStream } from './RunStream';
import { useTime } from './TimeProvider';
import { TimeScrubber } from './TimeScrubber';
import { TopBar } from './TopBar';
import { UndoConsole } from './UndoConsole';
import { WorldPanel } from './WorldPanel';

export function Shell() {
  const { state } = useBacktrack();
  const counts = graphCounts(state.graph);
  // The world pane names the read it shows: the live world, or the scrubber's frame.
  const { world } = useTime();
  const entities = world?.entities.length;
  const worldRoute =
    world?.asOfSeq === null || world?.asOfSeq === undefined
      ? 'GET /api/world'
      : `GET /api/world?asOfSeq=${world.asOfSeq}`;

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <a
        href="#main"
        className="sr-only rounded-md bg-surface-2 px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to the panels
      </a>
      <TopBar />
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
          source={entities === undefined ? null : `${worldRoute} · ${entities} entities`}
          className="lg:hidden xl:flex"
        >
          <PaneBody>
            <WorldPanel />
          </PaneBody>
          <div className="shrink-0 border-t bg-surface p-4">
            <TimeScrubber />
          </div>
        </Pane>
      </main>
    </div>
  );
}
