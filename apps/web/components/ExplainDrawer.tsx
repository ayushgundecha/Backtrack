'use client';

/**
 * Explain drawer (PLAN §7.3): why an action happened, what it read and who wrote that, what it
 * changed, what it depends on and what depends on it, its dependency path, and the Cypher behind
 * it. Every line is a field of the Explain contract (GET /api/explain, Q6) except the path, which
 * is the Q1 closure the graph view asked for; when there is none, the drawer says how to get one
 * instead of drawing a path the graph did not return.
 *
 * Non-modal on purpose: the graph stays usable, and picking another action re-targets the drawer.
 */
import type { Explain } from '@backtrack/core/contracts';
import { cn } from 'cn';
import { ArrowRight, Check, Copy, Crosshair } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { brief, pathView, writerOf } from '@/lib/explain-view';
import type { PathHop } from '@/lib/graph-model';
import { agentName } from '@/lib/tools';
import { useBacktrack } from './BacktrackProvider';
import { useSelection } from './SelectionProvider';
import { StatusBadge } from './StatusBadge';

type Load =
  | { state: 'loading'; actionId: string }
  | { state: 'ready'; actionId: string; explain: Explain }
  | { state: 'error'; actionId: string; message: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Fixed locale and UTC: the same timestamp reads the same on every machine and in screenshots.
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});

function useExplain(actionId: string | null): Load | null {
  const { actions, state } = useBacktrack();
  const [load, setLoad] = useState<Load | null>(null);
  // Re-read when the action's status changes (an undo turns it undone) while the drawer is open.
  const status = state.graph?.nodes.find((n) => n.id === actionId)?.status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `status` re-reads on a status change
  useEffect(() => {
    if (!actionId) {
      setLoad(null);
      return;
    }
    let current = true;
    setLoad((prev) =>
      prev?.actionId === actionId && prev.state === 'ready' ? prev : { state: 'loading', actionId },
    );
    actions
      .explain(actionId)
      .then((explain) => current && setLoad({ state: 'ready', actionId, explain }))
      .catch(
        (error: unknown) =>
          current && setLoad({ state: 'error', actionId, message: messageOf(error) }),
      );
    return () => {
      current = false;
    };
  }, [actions, actionId, status]);
  return load;
}

export function ExplainDrawer() {
  const { explainId, closeExplain } = useSelection();
  const load = useExplain(explainId);

  return (
    <Sheet open={explainId !== null} onOpenChange={(open) => !open && closeExplain()} modal={false}>
      <SheetContent
        side="right"
        // Full width on phones, 440 px beside the graph from 640 px. Important beats the base
        // sheet's own data-[side] width rules, which would otherwise win at equal specificity.
        className="w-full! max-w-none! gap-0 sm:w-[440px]! sm:max-w-[440px]!"
        // Clicks on the graph pick another action to explain; they must not close the drawer.
        onInteractOutside={(event) => {
          const target = event.target as Element | null;
          if (target?.closest('[data-graph-canvas], [data-explain-keep-open]')) {
            event.preventDefault();
          }
        }}
      >
        {load?.state === 'ready' ? (
          <ExplainBody explain={load.explain} />
        ) : (
          <>
            <SheetHeader className="border-b pr-12">
              <SheetTitle>Explain</SheetTitle>
              <SheetDescription>
                {load?.state === 'error' ? (
                  <span className="text-red">{load.message}</span>
                ) : (
                  'Asking the graph…'
                )}
              </SheetDescription>
            </SheetHeader>
            {load?.state === 'error' ? null : (
              <div role="status" aria-busy="true" className="flex flex-col gap-3 p-4">
                <div className="h-16 rounded-lg bg-surface-2" />
                <div className="h-24 rounded-lg bg-surface-2" />
                <div className="h-32 rounded-lg bg-surface-2" />
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  source,
  children,
}: {
  title: string;
  /** Where the section's content comes from, e.g. "Q6 reads". */
  source?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <h3 className="flex items-baseline justify-between gap-2 font-medium text-sm">
        {title}
        {source ? (
          <span className="font-mono font-normal text-fg-muted text-xs">{source}</span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}

/** An action named by the graph; activating it explains that action. */
function ActionChip({
  actionId,
  tool,
  seq,
}: {
  actionId: string;
  tool: string | null;
  seq: number | null;
}) {
  const { openExplain } = useSelection();
  return (
    <button
      type="button"
      onClick={() => openExplain(actionId)}
      className="inline-flex items-center gap-1.5 rounded-md border bg-surface-2 px-2 py-0.5 font-mono text-xs hover:border-accent"
      title={`Explain ${actionId}`}
    >
      {tool ?? actionId}
      {seq !== null ? <span className="text-fg-muted">seq {seq}</span> : null}
    </button>
  );
}

function PathChips({ path }: { path: PathHop[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1">
      {path.map((hop, i) => (
        <li
          key={hop.kind === 'action' ? hop.id : `${hop.text}-${i}`}
          className="flex items-center gap-1"
        >
          {i > 0 ? <ArrowRight aria-label="then" className="size-3 text-fg-muted" /> : null}
          {hop.kind === 'action' ? (
            <ActionChip actionId={hop.id} tool={hop.tool} seq={hop.seq} />
          ) : (
            <span className="rounded-md border px-2 py-0.5 font-mono text-xs">{hop.text}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function ExplainBody({ explain }: { explain: Explain }) {
  const { state, meta } = useBacktrack();
  const selection = useSelection();
  const { action } = explain;
  const toolOf = (id: string) => state.graph?.nodes.find((n) => n.id === id)?.tool ?? id;
  const path = pathView(action.id, selection.closure);

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle className="flex items-baseline gap-2">
          <span className="font-mono">{action.tool}</span>
          <span className="font-mono font-normal text-fg-muted text-xs">seq {action.seq}</span>
          <StatusBadge status={action.status} className="ml-1 self-center" />
        </SheetTitle>
        <SheetDescription className="flex flex-col gap-0.5 text-xs">
          <span>
            {agentName[action.agentId] ?? action.agentId} · run{' '}
            <span className="font-mono">{action.runId}</span> · {timeFormat.format(action.ts)} UTC
          </span>
          <span className={cn(!action.reversible && 'text-red')}>
            {action.kind !== 'do'
              ? `A ${action.kind} step recorded by Backtrack.`
              : action.reversible
                ? `Reversible${action.inverseTool ? ` with ${action.inverseTool}` : ''}.`
                : `Irreversible${action.mitigationTool ? `; mitigation ${action.mitigationTool}` : ''}.`}
          </span>
        </SheetDescription>
      </SheetHeader>

      {/* Keyed by action: explaining another action starts at its top, not mid-scroll. */}
      <div key={action.id} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Section title="Why" source="Step.thought">
          {explain.thought ? (
            <p className="text-fg italic">{explain.thought}</p>
          ) : (
            <p className="text-fg-muted">No thought was recorded for this step.</p>
          )}
          {Object.keys(action.args).length > 0 ? (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs [overflow-wrap:anywhere]">
              {JSON.stringify(action.args, null, 2)}
            </pre>
          ) : null}
        </Section>

        <Section title="Read" source={`${explain.reads.length} READ`}>
          {explain.reads.length === 0 ? (
            <p className="text-fg-muted">It read nothing from the world.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {explain.reads.map((read) => {
                const writer = writerOf(read, explain, state.graph);
                return (
                  <li key={read.entity} className="flex flex-col gap-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-code">{read.entity}</span>
                      {writer ? (
                        <span className="flex items-center gap-1.5 text-fg-muted text-xs">
                          written by
                          <ActionChip {...writer} />
                        </span>
                      ) : (
                        <span className="text-fg-muted text-xs">
                          no earlier recorded action wrote it
                        </span>
                      )}
                    </p>
                    <details className="text-xs">
                      <summary className="cursor-pointer text-fg-muted">What it saw</summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1.5 font-mono [overflow-wrap:anywhere]">
                        {JSON.stringify(read.saw, null, 2)}
                      </pre>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Changed" source={`${explain.effects.length} CAUSED`}>
          {explain.effects.length === 0 ? (
            <p className="text-fg-muted">It changed nothing.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {explain.effects.map((effect) => (
                <li key={effect.id} className="flex flex-col gap-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={cn(
                        'rounded-sm border px-1.5 text-xs',
                        effect.kind === 'external' && 'border-red/60 text-red',
                      )}
                    >
                      {effect.kind}
                    </span>
                    <span className="font-mono text-code">
                      {effect.entity.type}:{effect.entity.key}
                      {effect.field ? `.${effect.field}` : ''}
                    </span>
                  </p>
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-xs">
                    <span className="min-w-0 break-all text-fg-muted">{brief(effect.before)}</span>
                    <ArrowRight aria-label="became" className="size-3 shrink-0 text-fg-muted" />
                    <span className="min-w-0 break-all">{brief(effect.after)}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Depends on" source="DEPENDS_ON out">
          {explain.dependsOn.length === 0 ? (
            <p className="text-fg-muted">
              No DEPENDS_ON edges: it builds on no earlier recorded action.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {explain.dependsOn.map((d) => (
                <ActionChip key={d.actionId} {...d} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Depended on by" source="DEPENDS_ON in">
          {explain.dependedOnBy.length === 0 ? (
            <p className="text-fg-muted">No later action depends on it.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {explain.dependedOnBy.map((d) => (
                <ActionChip key={d.actionId} {...d} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Path"
          source={path.kind === 'no-selection' ? undefined : `Q1 · depth ${path.depth}`}
        >
          {path.kind === 'root' ? (
            path.members.length === 0 ? (
              <p className="text-fg-muted">Nothing depends on it within depth {path.depth}.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {path.members.map((m) => (
                  <li key={m.actionId} className="flex flex-col gap-1">
                    <span className="text-fg-muted text-xs">
                      {m.tool} seq {m.seq}, {m.hops} {m.hops === 1 ? 'hop' : 'hops'}
                    </span>
                    <PathChips path={m.path} />
                  </li>
                ))}
              </ul>
            )
          ) : path.kind === 'member' ? (
            <>
              <span className="text-fg-muted text-xs">
                From the selected {toolOf(path.rootId)}, {path.member.hops}{' '}
                {path.member.hops === 1 ? 'hop' : 'hops'}
              </span>
              <PathChips path={path.member.path} />
            </>
          ) : path.kind === 'no-plan' ? (
            <p className="text-fg-muted">{path.note}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-fg-muted">
                {path.kind === 'outside'
                  ? `Not reached from the selected ${toolOf(path.rootId)} within depth ${path.depth}.`
                  : 'Select it in the graph to see the paths that depend on it.'}
              </p>
              {action.kind === 'do' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-explain-keep-open
                  onClick={() => selection.select(action.id)}
                >
                  <Crosshair aria-hidden />
                  Select in graph
                </Button>
              ) : null}
            </div>
          )}
        </Section>

        <Section title="Cypher" source={meta.source === 'mock' ? 'mock trace' : 'GET /api/explain'}>
          <CypherBlock trace={explain.trace} />
        </Section>
      </div>
    </>
  );
}

function CypherBlock({ trace }: { trace: Explain['trace'] }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(trace.cypher);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error(`Could not copy the Cypher: ${messageOf(error)}`);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-fg-muted text-xs">
        <span className="font-mono">
          {trace.ms} ms · {trace.rows} {trace.rows === 1 ? 'row' : 'rows'}
        </span>
        <Button variant="secondary" size="sm" onClick={copy} aria-live="polite">
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? 'Copied' : 'Copy Cypher'}
        </Button>
      </div>
      <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
        <code>{trace.cypher}</code>
      </pre>
      {Object.keys(trace.params).length > 0 ? (
        <p className="font-mono text-fg-muted text-xs">params {JSON.stringify(trace.params)}</p>
      ) : null}
    </div>
  );
}
