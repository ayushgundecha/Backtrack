'use client';

import type { GraphSnapshot } from '@backtrack/core/contracts';
import { Check, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { approverOf } from '@/lib/run-view';
import type { ApprovalView } from '@/lib/session';
import { useBacktrack } from './BacktrackProvider';

/**
 * The graph-driven gate (Q4): an irreversible call paused because it would lock in reversible
 * changes. The reason is the query's answer, shown verbatim as the event carries it; the panel
 * never rephrases it, so what is on screen is exactly what the graph returned.
 */
export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const { actions, state } = useBacktrack();
  // Disables both buttons while the answer is in flight so one click cannot become two answers.
  const [sending, setSending] = useState<boolean | null>(null);
  const pending = approval.state === 'pending';

  const answer = async (approved: boolean) => {
    setSending(approved);
    const ok = await actions.answerApproval(approval.runId, approval.actionId, approved);
    // On success the card re-renders from approval.resolved; on failure the buttons come back.
    if (!ok) setSending(null);
  };

  return (
    <section
      aria-label={`Approval for ${approval.tool}`}
      className={
        pending
          ? 'flex flex-col gap-3 rounded-lg border border-amber/70 bg-amber/5 p-3'
          : 'flex flex-col gap-3 rounded-lg border bg-surface-2/40 p-3'
      }
    >
      <div className="flex items-center gap-2">
        {pending ? (
          <span aria-hidden className="pending-pulse size-2 shrink-0 rounded-full bg-amber" />
        ) : (
          <ShieldAlert aria-hidden className="size-4 shrink-0 text-fg-muted" />
        )}
        <h4 className="font-medium text-sm">{pending ? 'Approval needed' : 'Approval answered'}</h4>
        <span className="ml-auto text-fg-muted text-xs">Gate · Q4 lock-in</span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm">
          <code className="font-mono text-code">{approval.tool}</code> cannot be undone. The graph
          says it
        </p>
        <p className="border-amber/60 border-l-2 pl-2.5 font-medium text-fg text-sm">
          {approval.reason}
        </p>
      </div>
      {pending ? (
        <div className="flex flex-wrap gap-2">
          <Button size="lg" disabled={sending !== null} onClick={() => answer(true)}>
            <Check aria-hidden />
            {sending === true ? 'Approving…' : 'Approve'}
          </Button>
          <Button
            size="lg"
            variant="destructive"
            disabled={sending !== null}
            onClick={() => answer(false)}
          >
            <X aria-hidden />
            {sending === false ? 'Denying…' : 'Deny'}
          </Button>
        </div>
      ) : (
        <Answered approval={approval} graph={state.graph} />
      )}
    </section>
  );
}

/**
 * "Approved by Ayush": the name is the User node's (V3) and the muted line names the edge that
 * records the answer (V4) once the graph has it. Without a User node the id is shown as an id.
 */
function Answered({ approval, graph }: { approval: ApprovalView; graph: GraphSnapshot | null }) {
  const approved = approval.state === 'approved';
  const who = approval.by ? approverOf(graph, approval.by, approval.actionId, approved) : null;
  const name = who ? (who.name ?? `user ${who.userId}`) : 'a human';
  const Icon = approved ? Check : X;
  return (
    <div className="flex flex-col gap-0.5">
      <p className={`flex items-center gap-1.5 text-sm ${approved ? 'text-green' : 'text-red'}`}>
        <Icon aria-hidden className="size-4 shrink-0" />
        {approved ? `Approved by ${name}.` : `Denied by ${name}. ${approval.tool} was not run.`}
      </p>
      {who?.recorded ? (
        // No ligatures, so `->` reads as typed; wraps only between the edge and the route.
        <p className="pl-5.5 font-mono text-fg-muted text-xs [font-variant-ligatures:none]">
          <span className="[overflow-wrap:anywhere]">
            {`(:User {id: '${who.userId}'})-[:${approved ? 'APPROVED' : 'DENIED'}]->(:Action)`}
          </span>{' '}
          <span className="whitespace-nowrap">· GET /api/graph</span>
        </p>
      ) : null}
    </div>
  );
}
