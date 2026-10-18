'use client';

/**
 * Right column: the world the agents act on, read from WorldSnapshot. The demo order and its
 * customer are pinned; everything else sits in tabs. Each change between two reads of
 * GET /api/world shows once (docs/design-system.md, motion): a changed field flashes accent for
 * 600 ms; a field an undo step put back flashes green and says "restored" for 2 s; new records
 * slide in (240 ms); removed records collapse (200 ms). Reduced motion keeps the colors and the
 * "restored" label but drops the movement.
 */
import type { WorldSnapshot } from '@backtrack/core/contracts';
import { cn } from 'cn';
import { AnimatePresence, motion } from 'framer-motion';
import { History, Pin, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { stopLabel } from '@/lib/time-travel';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { type ActiveFlash, type Flashes, useWorldFlashes } from '@/lib/use-world-flashes';
import { entityId } from '@/lib/world-diff';
import { useBacktrack } from './BacktrackProvider';
import { ErrorState } from './EmptyState';
import { useTime } from './TimeProvider';

type WorldEntity = WorldSnapshot['entities'][number];

const DEMO_ORDER = 'ord_1001';
const SUPPORT_TYPES = ['ticket', 'message', 'event', 'email', 'credit'];
const EASE = [0.2, 0.8, 0.2, 1] as const;

/** Fields worth a glance per type; the explain drawer shows the full state. */
const glance: Record<string, string[]> = {
  order: ['address', 'status', 'total'],
  customer: ['email', 'tier'],
  ticket: ['status', 'thread'],
  message: ['channel', 'text'],
  event: ['when', 'status'],
  email: ['toAddress', 'status'],
  credit: ['amount', 'status'],
};

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

function Field({ name, value, flash }: { name: string; value: unknown; flash?: ActiveFlash }) {
  return (
    <div className="contents">
      <dt className="text-fg-muted">{name}</dt>
      {/* The key restarts the flash animation when a newer change lands on the same field. */}
      <dd
        key={flash?.token ?? 'still'}
        className={cn(
          '-mx-1 flex min-w-0 items-center gap-2 rounded-sm px-1',
          flash && `flash-${flash.kind}`,
        )}
      >
        {value === null || value === undefined ? (
          <span className="text-fg-muted">empty</span>
        ) : (
          <span className="truncate font-mono">{show(value)}</span>
        )}
        {flash?.kind === 'restored' ? (
          <span className="flex shrink-0 items-center gap-1 text-green">
            <RotateCcw aria-hidden className="size-3" />
            Restored
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function EntityCard({ entity, flashes }: { entity: WorldEntity; flashes?: Flashes[string] }) {
  const fields = glance[entity.type] ?? [];
  // A change to a field the card does not show still gets one flash, on the whole card.
  const hidden = Object.entries(flashes ?? {}).filter(([field]) => !fields.includes(field));
  const cardFlash = hidden.reduce<ActiveFlash | undefined>(
    (latest, [, f]) => (!latest || f.token > latest.token ? f : latest),
    undefined,
  );
  return (
    <article className="relative flex flex-col gap-1.5 rounded-lg border bg-surface p-3">
      {cardFlash ? (
        <span
          key={cardFlash.token}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 rounded-lg',
            `flash-${cardFlash.kind}`,
          )}
        />
      ) : null}
      <h4 className="relative flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate font-medium">{entity.display}</span>
        <span className="shrink-0 font-mono text-fg-muted text-xs">
          {entity.type}:{entity.key}
        </span>
      </h4>
      <dl className="relative grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {fields.map((field) => (
          <Field key={field} name={field} value={entity.state[field]} flash={flashes?.[field]} />
        ))}
      </dl>
    </article>
  );
}

function EntityList({
  entities,
  empty,
  flashes,
}: {
  entities: WorldEntity[];
  empty: string;
  flashes: Flashes;
}) {
  const reduced = useReducedMotion();
  if (entities.length === 0) return <p className="py-2 text-fg-muted text-sm">{empty}</p>;
  return (
    <ul className="flex flex-col">
      {/* initial={false}: what is already there on load or on a tab switch does not slide in. */}
      <AnimatePresence initial={false}>
        {entities.map((entity) => (
          <motion.li
            key={entityId(entity)}
            // Spacing is padding, not gap, so a collapsing card takes its spacing with it.
            className="overflow-hidden pb-2"
            initial={reduced ? false : { opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0, height: 'auto' }}
            exit={{
              opacity: 0,
              height: 0,
              paddingBottom: 0,
              transition: { duration: reduced ? 0 : 0.2, ease: EASE },
            }}
            transition={{ duration: reduced ? 0 : 0.24, ease: EASE }}
          >
            <EntityCard entity={entity} flashes={flashes[entityId(entity)]} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

/** One sentence for screen readers per batch of flashes, from the same data as the colors. */
function announce(flashes: Flashes): string {
  return Object.entries(flashes)
    .map(([entity, fields]) => {
      const restored = Object.entries(fields).filter(([, f]) => f.kind === 'restored');
      const changed = Object.entries(fields).filter(([, f]) => f.kind === 'changed');
      return [
        changed.length > 0 ? `${entity} changed: ${changed.map(([k]) => k).join(', ')}` : '',
        restored.length > 0 ? `${entity} restored: ${restored.map(([k]) => k).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('. ');
    })
    .join('. ');
}

/** Body of the world panel, shared by the right column and the 1024–1279 px drawer. */
export function WorldPanel() {
  const { state, actions, meta } = useBacktrack();
  // The scrubber's frame while scrubbed, the live world at now (TimeProvider decides).
  const time = useTime();
  const { world } = time;
  const flashes = useWorldFlashes(world, state.session);
  if (!world && state.loadError) {
    return (
      <ErrorState
        title={`Could not read the world in bt:${meta.tenant}`}
        message={state.loadError}
        onRetry={actions.retry}
        announce={false}
      />
    );
  }
  if (!world) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the world"
        className="h-40 rounded-lg bg-surface-2"
      />
    );
  }

  const order = world.entities.find((e) => e.type === 'order' && e.key === DEMO_ORDER);
  const customer = world.entities.find(
    (e) => e.type === 'customer' && e.key === order?.state.customerId,
  );
  const ofType = (...types: string[]) => world.entities.filter((e) => types.includes(e.type));
  const support = ofType(...SUPPORT_TYPES);

  return (
    <div className="flex flex-col gap-4">
      <p aria-live="polite" className="sr-only">
        {announce(flashes)}
      </p>
      {time.asOfSeq !== null ? <PastBanner /> : null}
      <section aria-labelledby="world-pinned" className="flex flex-col gap-2">
        <h3 id="world-pinned" className="flex items-center gap-1.5 text-fg-muted text-xs">
          <Pin aria-hidden className="size-3" />
          Demo order
        </h3>
        {order ? <EntityCard entity={order} flashes={flashes[entityId(order)]} /> : null}
        {customer ? <EntityCard entity={customer} flashes={flashes[entityId(customer)]} /> : null}
      </section>
      <Tabs defaultValue="support">
        <TabsList className="w-full">
          <TabsTrigger value="support">Support {support.length}</TabsTrigger>
          <TabsTrigger value="orders">Orders {ofType('order').length}</TabsTrigger>
          <TabsTrigger value="customers">Customers {ofType('customer').length}</TabsTrigger>
        </TabsList>
        <TabsContent value="support">
          <EntityList
            entities={support}
            flashes={flashes}
            empty="No tickets, messages, events, emails or credits yet."
          />
        </TabsContent>
        <TabsContent value="orders">
          <EntityList entities={ofType('order')} flashes={flashes} empty="No orders." />
        </TabsContent>
        <TabsContent value="customers">
          <EntityList entities={ofType('customer')} flashes={flashes} empty="No customers." />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Says which point in time the cards show. It names the frame that is on screen (its own
 * asOfSeq), not the stop being asked for, so a slow read never labels the wrong world.
 */
function PastBanner() {
  const { world, stops, scrubTo } = useTime();
  const shown = world?.asOfSeq ?? null;
  const stop =
    shown === null ? null : (stops.find((s) => s.kind !== 'now' && s.asOfSeq === shown) ?? null);
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-surface-2 px-3 py-2 text-sm">
      <History aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
      <p className="min-w-0 flex-1">
        {shown === null ? (
          'Reading the past world…'
        ) : (
          <>
            {stop ? stopLabel(stop) : `After seq ${shown}`}.{' '}
            <span className="text-fg-muted">Every later change is rolled back to its before.</span>
          </>
        )}
      </p>
      <Button variant="secondary" size="xs" onClick={() => scrubTo(null)}>
        Now
      </Button>
    </div>
  );
}
