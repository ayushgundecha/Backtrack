'use client';

/**
 * Top bar: which tenant graph the panel reads and writes, and the switch to another one
 * (PLAN §7.3, BT-04C). A tenant is a FalkorDB graph of its own (`bt:<tenant>`), so switching
 * swaps the whole panel onto another graph; nothing is filtered. The tenant lives in the URL
 * (`?tenant=acme`) so a reload or a shared link opens the same graph.
 */
import { Check, ChevronsUpDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { graphName, KNOWN_TENANTS, tenantHref, tenantProblem } from '@/lib/tenant';
import { useBacktrack } from './BacktrackProvider';

export function TenantSwitch() {
  const { state, meta } = useBacktrack();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { input: useId(), error: useId(), help: useId() };
  const mock = meta.source === 'mock';

  const dot =
    mock || state.connection === 'connecting'
      ? 'bg-grey-node'
      : state.connection === 'ok'
        ? 'bg-green'
        : 'bg-red';
  const status = mock
    ? 'not connected, showing mock data'
    : { connecting: 'connecting', ok: 'connected', error: 'unreachable' }[state.connection];

  const go = (tenant: string) => {
    setOpen(false);
    setName('');
    setProblem(null);
    if (tenant !== meta.tenant) router.push(tenantHref(tenant));
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const wanted = name.trim();
    const why = tenantProblem(wanted);
    setProblem(why);
    if (!why) go(wanted);
  };

  // A run or an undo streams from this tenant's graph; switching mid-stream would abandon it.
  const busy = state.streaming;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          className="gap-2 px-2 font-normal text-fg-muted"
          // Starts with the visible text so speech input ("click FalkorDB") finds it.
          aria-label={`FalkorDB · ${graphName(meta.tenant)}, ${status}. Switch tenant`}
          title={busy ? 'Switch tenants once the run or undo has finished' : undefined}
        >
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
          <span className="hidden md:inline">FalkorDB · {graphName(meta.tenant)}</span>
          <ChevronsUpDown aria-hidden className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium text-sm">Tenant</h2>
          <p id={ids.help} className="text-fg-muted text-xs">
            Each tenant is its own FalkorDB graph,{' '}
            <span className="whitespace-nowrap font-mono">{graphName('<tenant>')}</span>. Agents,
            history and undo plans never cross between them. A new name starts a fresh graph from
            the seeded world.
          </p>
        </div>
        <ul aria-label="Tenants" className="flex flex-col gap-1">
          {[...new Set([meta.tenant, ...KNOWN_TENANTS])].map((tenant) => {
            const current = tenant === meta.tenant;
            return (
              <li key={tenant}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-current={current ? 'true' : undefined}
                  onClick={() => go(tenant)}
                  className="w-full justify-start font-mono font-normal"
                >
                  <Check aria-hidden className={current ? 'text-accent' : 'invisible'} />
                  {graphName(tenant)}
                </Button>
              </li>
            );
          })}
        </ul>
        <form onSubmit={submit} noValidate className="flex flex-col gap-1.5 border-t pt-3">
          <label htmlFor={ids.input} className="text-fg-muted text-xs">
            Another tenant
          </label>
          <div className="flex gap-2">
            <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg border bg-bg pl-2 focus-within:ring-2 focus-within:ring-ring">
              <span aria-hidden className="font-mono text-fg-muted text-sm">
                bt:
              </span>
              <input
                id={ids.input}
                name="tenant"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                maxLength={32}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (problem) setProblem(null);
                }}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? ids.error : ids.help}
                placeholder="team-name"
                className="h-full min-w-0 flex-1 bg-transparent pr-2 font-mono text-sm outline-none placeholder:text-fg-muted"
              />
            </div>
            <Button type="submit" size="sm" variant="secondary">
              Switch
            </Button>
          </div>
          {problem ? (
            <p id={ids.error} role="alert" className="text-red text-xs">
              {problem}
            </p>
          ) : null}
        </form>
      </PopoverContent>
    </Popover>
  );
}
