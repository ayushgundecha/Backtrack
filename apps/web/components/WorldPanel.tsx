'use client';

/**
 * Right column: the world the agents act on, read from WorldSnapshot. The demo order and its
 * customer are pinned; everything else sits in tabs. Flash transitions arrive with BT-045.
 */
import type { WorldSnapshot } from '@backtrack/core/contracts';
import { Pin } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBacktrack } from './BacktrackProvider';

type WorldEntity = WorldSnapshot['entities'][number];

const DEMO_ORDER = 'ord_1001';
const SUPPORT_TYPES = ['ticket', 'message', 'event', 'email', 'credit'];

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

function EntityCard({ entity }: { entity: WorldEntity }) {
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border bg-surface p-3">
      <h4 className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate font-medium">{entity.display}</span>
        <span className="shrink-0 font-mono text-fg-muted text-xs">
          {entity.type}:{entity.key}
        </span>
      </h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {(glance[entity.type] ?? []).map((field) => (
          <div key={field} className="contents">
            <dt className="text-fg-muted">{field}</dt>
            <dd className="truncate font-mono">{show(entity.state[field])}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function EntityList({ entities, empty }: { entities: WorldEntity[]; empty: string }) {
  if (entities.length === 0) return <p className="py-2 text-fg-muted text-sm">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {entities.map((entity) => (
        <li key={`${entity.type}:${entity.key}`}>
          <EntityCard entity={entity} />
        </li>
      ))}
    </ul>
  );
}

/** Body of the world panel, shared by the right column and the 1024–1279 px drawer. */
export function WorldPanel() {
  const { state } = useBacktrack();
  const { world } = state;
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
      <section aria-labelledby="world-pinned" className="flex flex-col gap-2">
        <h3 id="world-pinned" className="flex items-center gap-1.5 text-fg-muted text-xs">
          <Pin aria-hidden className="size-3" />
          Demo order
        </h3>
        {order ? <EntityCard entity={order} /> : null}
        {customer ? <EntityCard entity={customer} /> : null}
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
            empty="No tickets, messages, events, emails or credits yet."
          />
        </TabsContent>
        <TabsContent value="orders">
          <EntityList entities={ofType('order')} empty="No orders." />
        </TabsContent>
        <TabsContent value="customers">
          <EntityList entities={ofType('customer')} empty="No customers." />
        </TabsContent>
      </Tabs>
    </div>
  );
}
