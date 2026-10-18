'use client';

import {
  FlaskConical,
  type LucideIcon,
  Play,
  Receipt,
  RotateCcw,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useBacktrack } from './BacktrackProvider';
import { TenantSwitch } from './TenantSwitch';
import { WorldDrawer } from './WorldDrawer';

/** Labels collapse to icons below 1024 px; the accessible name stays the full label. */
function BarButton({
  icon: Icon,
  label,
  variant = 'secondary',
  ...props
}: {
  icon: LucideIcon;
  label: string;
  variant?: 'default' | 'secondary';
} & Omit<React.ComponentProps<typeof Button>, 'variant' | 'children'>) {
  return (
    <Button variant={variant} size="lg" aria-label={label} {...props}>
      <Icon aria-hidden />
      <span className="hidden lg:inline">{label}</span>
    </Button>
  );
}

function ConnectionStatus() {
  const { meta } = useBacktrack();
  const mock = meta.source === 'mock';

  return (
    <div className="flex items-center gap-2">
      <TenantSwitch />
      {mock ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Focusable so keyboard users can read why the data is mock. */}
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: tooltip trigger must be focusable */}
            <span tabIndex={0} className="rounded-full">
              <Badge variant="outline" className="border-border font-normal text-fg-muted">
                <FlaskConical aria-hidden />
                <span className="sr-only sm:not-sr-only">Mock data</span>
              </Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            NEXT_PUBLIC_MOCK=1: a fixture-backed client in the browser. Nothing on screen was read
            from FalkorDB.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function TopBar() {
  const { state, actions, meta } = useBacktrack();
  const idle = meta.source !== null && !state.streaming;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-surface px-3 sm:gap-4 sm:px-4">
      <div className="flex shrink-0 items-center gap-2">
        <Undo2 aria-hidden className="size-5 shrink-0 text-accent" />
        <h1 className="font-semibold text-base">Backtrack</h1>
        <p className="hidden truncate text-fg-muted text-sm xl:block">
          The undo button for AI agents
        </p>
      </div>
      <ConnectionStatus />
      <nav aria-label="Run controls" className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <BarButton
          icon={Play}
          label="Run ops agent"
          variant="default"
          disabled={!idle}
          onClick={() => actions.runAgent('ops-agent', 'replay')}
        />
        {/* Without an OpenRouter key (and in the mock) the server says so and shows the replay. */}
        <BarButton
          icon={Sparkles}
          label="Live LLM"
          disabled={!idle}
          onClick={() => actions.runAgent('ops-agent', 'llm')}
        />
        <BarButton
          icon={Receipt}
          label="Run billing agent"
          disabled={!idle}
          onClick={() => actions.runAgent('billing-agent', 'replay')}
        />
        <BarButton
          icon={RotateCcw}
          label="Reset world"
          disabled={meta.source === null}
          onClick={actions.resetWorld}
        />
        <WorldDrawer />
      </nav>
    </header>
  );
}
