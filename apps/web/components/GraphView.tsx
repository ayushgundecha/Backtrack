'use client';

/**
 * Left column. Until the force-directed view lands (BT-042) this renders the same GraphSnapshot
 * as an ordered ledger: every Action in seq order, grouped by run, with its DEPENDS_ON targets,
 * and the entities the actions touched. The encoding already follows the graph spec (circle color
 * = tool family, ring = status, diamond = entity) so the swap is visual, not structural.
 */
import type { GraphSnapshot } from '@backtrack/core/contracts';
import { cn } from 'cn';
import { Diamond, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { agentName, familyDotClass, familyOf } from '@/lib/tools';
import { useBacktrack } from './BacktrackProvider';
import { EmptyState } from './EmptyState';
import { StatusBadge } from './StatusBadge';

type GraphNode = GraphSnapshot['nodes'][number];

// Status rings are outlines, not box-shadow rings, so the pending pulse (a box-shadow) can
// animate around the ring instead of replacing it.
const ringClass: Record<string, string> = {
  pending: 'outline-2 outline-offset-2 outline-amber pending-pulse',
  undone: 'outline-2 outline-dashed outline-grey-node outline-offset-2 opacity-60',
  blocked: 'outline-2 outline-offset-2 outline-red',
  denied: 'outline-2 outline-offset-2 outline-red',
};

/** Counts for the pane header, taken from the snapshot so the number names its source. */
export function graphCounts(graph: GraphSnapshot | null) {
  if (!graph) return null;
  const actions = graph.nodes.filter((n) => n.label === 'Action').length;
  const dependencies = graph.links.filter((l) => l.type === 'DEPENDS_ON').length;
  return { actions, dependencies };
}

function ActionRow({ node, dependsOn }: { node: GraphNode; dependsOn: number[] }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="w-6 shrink-0 text-right font-mono text-code text-fg-muted">{node.seq}</span>
      <span
        aria-hidden
        className={cn(
          'size-3 shrink-0 rounded-full',
          familyDotClass[familyOf(node.tool)],
          ringClass[node.status ?? ''],
        )}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-code">{node.title}</span>
      {dependsOn.length > 0 ? (
        <span className="hidden shrink-0 text-fg-muted text-xs sm:inline">
          depends on <span className="font-mono">{dependsOn.join(', ')}</span>
        </span>
      ) : null}
      <StatusBadge status={node.status ?? 'done'} />
    </li>
  );
}

function Skeleton() {
  // Static on purpose: the pending pulse is the only looping animation in the product.
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the graph"
      className="flex flex-col gap-2"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-8 rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

export function GraphView() {
  const { state, actions, meta } = useBacktrack();
  const { graph } = state;
  if (!graph) return <Skeleton />;

  const actionNodes = graph.nodes
    .filter((n) => n.label === 'Action')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  if (actionNodes.length === 0) {
    return (
      <EmptyState title="Nothing recorded yet. Run the ops agent.">
        <Button
          size="lg"
          disabled={meta.source === null || state.streaming}
          onClick={() => actions.runAgent('ops-agent', 'replay')}
        >
          <Play aria-hidden />
          Run ops agent
        </Button>
      </EmptyState>
    );
  }

  const seqOf = new Map(actionNodes.map((n) => [n.id, n.seq ?? 0]));
  const dependsOn = new Map<string, number[]>();
  for (const link of graph.links) {
    if (link.type !== 'DEPENDS_ON') continue;
    const targets = dependsOn.get(link.source) ?? [];
    targets.push(seqOf.get(link.target) ?? 0);
    dependsOn.set(link.source, targets);
  }
  const runs = graph.nodes.filter((n) => n.label === 'Run');
  const entities = graph.nodes.filter((n) => n.label === 'Entity');

  return (
    <div className="flex flex-col gap-6">
      {runs.map((run) => {
        const rows = actionNodes.filter((n) => n.runId === run.id);
        if (rows.length === 0) return null;
        return (
          <section
            key={run.id}
            aria-label={`${agentName[run.agentId ?? ''] ?? run.agentId} run ${run.id}`}
          >
            <h3 className="flex items-baseline gap-2 border-b pb-2 font-medium text-sm">
              {agentName[run.agentId ?? ''] ?? run.agentId}
              <span className="font-mono font-normal text-fg-muted text-xs">{run.id}</span>
            </h3>
            <ol className="divide-y">
              {rows.map((node) => (
                <ActionRow
                  key={node.id}
                  node={node}
                  dependsOn={(dependsOn.get(node.id) ?? []).sort((a, b) => a - b)}
                />
              ))}
            </ol>
          </section>
        );
      })}
      {entities.length > 0 ? (
        <section aria-labelledby="graph-entities">
          <h3 id="graph-entities" className="border-b pb-2 font-medium text-sm">
            Entities touched
          </h3>
          <ul className="flex flex-wrap gap-2 pt-3">
            {entities.map((e) => (
              <li
                key={e.id}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs',
                  e.status === 'deleted' && 'border-dashed text-fg-muted',
                )}
              >
                <Diamond aria-hidden className="size-3 text-fg-muted" />
                {e.id}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
