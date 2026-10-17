'use client';

/**
 * The three non-plan outcomes of an undo request (UndoOutcome). Each says only what the engine
 * returned: a memory of earlier plans (Q13), the reason nothing needs undoing, or the closest
 * recorded changes when the words matched no action.
 */
import type { UndoOutcome } from '@backtrack/core/contracts';
import { CircleSlash, History, SearchX, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBacktrack } from './BacktrackProvider';
import { StatusBadge } from './StatusBadge';

type Outcome<K extends UndoOutcome['kind']> = Extract<UndoOutcome, { kind: K }>;

const when = (ts: number) =>
  new Date(ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** "update_address (seq 2)" from the graph snapshot, or the bare id if the graph lacks it. */
function useActionName(actionId: string): string {
  const { state } = useBacktrack();
  const node = state.graph?.nodes.find((n) => n.id === actionId);
  return node?.tool ? `${node.tool} (seq ${node.seq})` : actionId;
}

function Heading({ icon: Icon, children }: { icon: typeof History; children: React.ReactNode }) {
  return (
    <h4 className="flex items-center gap-2 font-medium">
      <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
      {children}
    </h4>
  );
}

export function MemoryCard({ outcome }: { outcome: Outcome<'memory'> }) {
  const name = useActionName(outcome.actionId);
  return (
    <section aria-label="Undone before" className="flex flex-col gap-2">
      <Heading icon={History}>Undone before</Heading>
      <p className="text-sm">
        <span className="font-mono">{name}</span> is already undone, so there is nothing to plan.
        The graph remembers {outcome.priorPlans.length === 1 ? 'the plan' : 'the plans'} that did it
        (Q13):
      </p>
      <ul className="flex flex-col gap-2">
        {outcome.priorPlans.map((p) => (
          <li key={p.id} className="flex flex-col gap-0.5 rounded-md border bg-bg p-2">
            <span className="flex items-center gap-2 text-xs">
              <span className="font-mono">{p.id}</span>
              <span className="text-fg-muted">on {when(p.ts)}</span>
              <StatusBadge status={p.status} className="ml-auto" />
            </span>
            <span className="text-fg-muted text-sm">{p.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NoneCard({ outcome }: { outcome: Outcome<'none'> }) {
  const name = useActionName(outcome.actionId);
  return (
    <section aria-label="No plan needed" className="flex flex-col gap-2">
      <Heading icon={CircleSlash}>No plan needed</Heading>
      <p className="font-mono text-fg-muted text-xs">{name}</p>
      <p className="text-sm">{outcome.reason}</p>
    </section>
  );
}

export function UnknownCard({
  outcome,
  onPick,
  disabled,
}: {
  outcome: Outcome<'unknown'>;
  onPick: (actionId: string) => void;
  disabled: boolean;
}) {
  return (
    <section aria-label="No matching action" className="flex flex-col gap-2">
      <Heading icon={SearchX}>No matching action</Heading>
      <p className="text-sm">
        Nothing recorded matches “{outcome.query}”.
        {outcome.candidates.length > 0
          ? ' The closest recorded changes:'
          : ' No change has been recorded yet.'}
      </p>
      {outcome.candidates.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {outcome.candidates.map((c) => (
            <li key={c.id}>
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={disabled}
                onClick={() => onPick(c.id)}
                className="w-full justify-start font-normal"
              >
                <Undo2 aria-hidden className="text-fg-muted" />
                <span className="truncate font-mono text-code">{c.label}</span>
                <span className="ml-auto text-fg-muted text-xs">seq {c.seq}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
