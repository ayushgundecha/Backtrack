'use client';

import type { Policy, UndoPlan } from '@backtrack/core/contracts';
import { ShieldBan } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { agentName } from '@/lib/tools';
import { defaultRule, neverAgainRequest, rootStep } from '@/lib/undo';
import { useBacktrack } from './BacktrackProvider';

/**
 * "Never again": turns an executed undo into a block policy. The scope is prefilled from the
 * plan's root action so the rule stops exactly the move that was undone; only the wording and
 * whether to narrow it to the entity are editable. Nothing is recorded without the submit click.
 */
export function NeverAgainForm({ plan, onClose }: { plan: UndoPlan; onClose: () => void }) {
  const { actions } = useBacktrack();
  const root = rootStep(plan);
  const id = useId();
  const entityKey = root?.entity ? `${root.entity.type}:${root.entity.key}` : null;
  const [rule, setRule] = useState(root ? defaultRule(root) : '');
  const [onEntity, setOnEntity] = useState(entityKey !== null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Policy | null>(null);
  if (!root) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const policy = await actions.setPolicy(neverAgainRequest(plan, root, rule, onEntity));
    setSaving(false);
    if (policy) setSaved(policy);
  };

  const agent = agentName[root.agentId] ?? root.agentId;
  if (saved) {
    // Every word here comes from the policy the route returned, not from the form.
    return (
      <section
        aria-label="Policy recorded"
        className="fade-in-0 flex animate-in flex-col gap-1 rounded-md border bg-bg p-3 duration-200"
      >
        <p className="flex items-center gap-2 font-medium text-sm" aria-live="polite">
          <ShieldBan aria-hidden className="size-4 text-red" />
          Policy <span className="font-mono">{saved.id}</span> recorded
        </p>
        <p className="text-sm">{saved.rule}</p>
        <p className="font-mono text-code text-fg-muted">
          {saved.kind} · {saved.tool ?? 'any tool'} ·{' '}
          {saved.agentId ? (agentName[saved.agentId] ?? saved.agentId) : 'any agent'}
          {saved.entity ? ` · ${saved.entity.type}:${saved.entity.key}` : ''}
        </p>
        <p className="text-fg-muted text-xs">
          The gate checks it (Q5) before every later call. Run the {agent} again to see it stop.
        </p>
      </section>
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Never again policy"
      className="fade-in-0 flex animate-in flex-col gap-2.5 rounded-md border bg-bg p-3 duration-200"
    >
      <h5 className="flex items-center gap-2 font-medium text-sm">
        <ShieldBan aria-hidden className="size-4 text-fg-muted" />
        Never again
      </h5>
      <p className="text-fg-muted text-xs">
        Blocks <span className="font-mono">{root.tool}</span> by the {agent}, the move this plan
        undid (seq {root.seq}). The gate checks it (Q5) before every later call; a blocked call is
        recorded but never runs.
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-rule`} className="text-fg-muted text-xs">
          Rule
        </label>
        <input
          id={`${id}-rule`}
          name="rule"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={200}
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          className="h-9 min-w-0 rounded-lg border bg-surface px-3 text-sm"
        />
      </div>
      {entityKey ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onEntity}
            onChange={(e) => setOnEntity(e.target.checked)}
            className="size-4 accent-accent"
          />
          Only when it touches <span className="font-mono text-code">{entityKey}</span>
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving || !rule.trim()}>
          <ShieldBan aria-hidden />
          {saving ? 'Recording…' : 'Record block policy'}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
