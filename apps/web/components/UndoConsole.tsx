'use client';

/**
 * Center column, bottom: ask for an undo in plain words and see which of the four honest
 * outcomes the engine returned. Rehearse, confirm and ⌘Z arrive with the full console (BT-044).
 */
import type { UndoOutcome } from '@backtrack/core/contracts';
import { ShieldAlert, Undo2, Users } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useBacktrack } from './BacktrackProvider';

function Outcome({ outcome }: { outcome: UndoOutcome }) {
  switch (outcome.kind) {
    case 'plan': {
      const { plan } = outcome;
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{plan.summary}</p>
          <ol className="flex flex-col gap-1">
            {plan.steps.map((step) => (
              <li key={step.order} className="flex items-center gap-2 font-mono text-code">
                {step.mode === 'mitigation' ? (
                  <ShieldAlert
                    aria-label="Irreversible, mitigated"
                    className="size-4 shrink-0 text-red"
                  />
                ) : (
                  <Undo2 aria-label="Reverted" className="size-4 shrink-0 text-fg-muted" />
                )}
                <span className="truncate">{step.label}</span>
              </li>
            ))}
          </ol>
          {plan.crossAgent.map((c) => (
            <p key={c.actionId} className="flex items-center gap-2 text-fg-muted text-sm">
              <Users aria-hidden className="size-4" />
              Reaches {c.agentId}: <span className="font-mono">{c.tool}</span>, {c.hops} hops away
            </p>
          ))}
        </div>
      );
    }
    case 'memory':
      return (
        <p className="text-sm">
          This was undone before
          {outcome.priorPlans[0]
            ? ` by ${outcome.priorPlans[0].id} (${outcome.priorPlans[0].status})`
            : ''}
          .
        </p>
      );
    case 'none':
      return <p className="text-sm">{outcome.reason}</p>;
    case 'unknown':
      return (
        <div className="flex flex-col gap-2 text-sm">
          <p>No recorded action matches “{outcome.query}”. The closest changes:</p>
          <ul className="flex flex-col gap-1">
            {outcome.candidates.map((c) => (
              <li key={c.id} className="font-mono text-code">
                {c.label} <span className="text-fg-muted">seq {c.seq}</span>
              </li>
            ))}
          </ul>
        </div>
      );
  }
}

export function UndoConsole() {
  const { state, actions } = useBacktrack();
  const [text, setText] = useState('');
  const [planning, setPlanning] = useState(false);
  const hasActions = (state.graph?.nodes ?? []).some((n) => n.label === 'Action');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!text.trim()) return;
    setPlanning(true);
    await actions.requestUndo(text.trim());
    setPlanning(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <label htmlFor="undo-request" className="text-fg-muted text-xs">
          Describe what to undo
        </label>
        <div className="flex gap-2">
          <input
            id="undo-request"
            name="undo-request"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="undo the address change…"
            className="h-9 min-w-0 flex-1 rounded-lg border bg-bg px-3 text-sm placeholder:text-fg-muted"
          />
          <Button
            type="submit"
            size="lg"
            variant="secondary"
            disabled={!hasActions || planning || !text.trim()}
          >
            <Undo2 aria-hidden />
            {planning ? 'Planning…' : 'Plan undo'}
          </Button>
        </div>
      </form>
      <div aria-live="polite">
        {state.undoOutcome ? (
          <div className="max-h-72 overflow-y-auto rounded-lg border bg-surface p-3">
            <Outcome outcome={state.undoOutcome} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
