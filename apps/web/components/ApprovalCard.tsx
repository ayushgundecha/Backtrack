'use client';

import { Check, ShieldAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ApprovalView } from '@/lib/session';
import { useBacktrack } from './BacktrackProvider';

/**
 * The graph-driven gate (Q4): an irreversible call paused because it would lock in reversible
 * changes. The reason is the query's answer, shown verbatim; the human decides.
 */
export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const { actions } = useBacktrack();
  const answer = (approved: boolean) =>
    actions.answerApproval(approval.runId, approval.actionId, approved);

  return (
    <section
      aria-label={`Approval for ${approval.tool}`}
      className="flex flex-col gap-3 rounded-lg border border-amber/70 bg-amber/5 p-3"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert aria-hidden className="size-4 text-amber" />
        <h4 className="font-medium text-sm">
          {approval.state === 'pending' ? 'Approval needed' : 'Approval answered'}
        </h4>
        <code className="ml-auto font-mono text-code text-fg-muted">{approval.tool}</code>
      </div>
      <p className="text-sm">
        <span className="font-mono">{approval.tool}</span> cannot be undone. It {approval.reason}.
      </p>
      {approval.state === 'pending' ? (
        <div className="flex gap-2">
          <Button size="lg" onClick={() => answer(true)}>
            <Check aria-hidden />
            Approve
          </Button>
          <Button size="lg" variant="destructive" onClick={() => answer(false)}>
            <X aria-hidden />
            Deny
          </Button>
        </div>
      ) : (
        <p className={approval.state === 'approved' ? 'text-green text-sm' : 'text-red text-sm'}>
          {approval.state === 'approved'
            ? 'Approved by you.'
            : 'Denied by you. The call was not made.'}
        </p>
      )}
    </section>
  );
}
