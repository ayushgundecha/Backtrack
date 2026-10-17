/**
 * Building blocks the world tools share: load an entity or fail with a clear error, find the
 * ticket a call is about, and spell out effects. Everything here reads; nothing writes.
 */
import type { EffectDraft, EntityRef } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { getEntity, listByType } from '../world/store.js';
import { type EntityStateByType, type EntityType, ref } from '../world/types.js';

/** An entity a tool read: the ref goes into `reads`, the state into the decision. */
export interface Loaded<T extends EntityType> {
  ref: EntityRef;
  state: EntityStateByType[T];
}

/** Load one entity, or throw `Unknown <type> <key>`: a model can pass any string as an id. */
export async function loadEntity<T extends EntityType>(
  g: TenantGraph,
  type: T,
  key: string,
): Promise<Loaded<T>> {
  const state = await getEntity(g, type, key);
  if (!state) throw new Error(`Unknown ${type} ${key}`);
  return { ref: ref(type, key), state };
}

/**
 * The one `<prefix>_<n>` id the texts mention (e.g. `ord` in "Address correction for ord_1001"),
 * or null if none. Tools use it as the default for an omitted id, the way a person reads a ticket
 * subject; two different ids are ambiguous and throw rather than guess.
 */
export function mentionedId(prefix: string, ...texts: string[]): string | null {
  const pattern = new RegExp(`\\b${prefix}_\\d+\\b`, 'g');
  const ids = new Set(texts.flatMap((t) => t.match(pattern) ?? []));
  if (ids.size > 1) {
    throw new Error(`Ambiguous: ${[...ids].join(', ')} are all mentioned; pass the id explicitly`);
  }
  return [...ids][0] ?? null;
}

/**
 * The customer's open ticket (for one order, when given), or null if there is none.
 *
 * Other tickets are only matched on owner, order and status, so just the match is recorded as
 * read: it is the ticket the caller builds on, and the one DEPENDS_ON should point through.
 */
export async function findOpenTicket(
  g: TenantGraph,
  customerId: string,
  orderId?: string,
): Promise<Loaded<'ticket'> | null> {
  const matches = (await listByType(g, 'ticket')).filter(
    (t) =>
      t.status === 'open' &&
      t.customerId === customerId &&
      (orderId === undefined || t.orderId === orderId),
  );
  if (matches.length > 1) {
    const ids = matches.map((t) => t.id).join(', ');
    throw new Error(`${customerId} has ${matches.length} open tickets (${ids}); pass ticketId`);
  }
  const [ticket] = matches;
  return ticket ? { ref: ref('ticket', ticket.id), state: ticket } : null;
}

/** A new entity; undoing it restores `before` (null), which soft-deletes it. */
export const created = (entity: EntityRef, after: object): EffectDraft => ({
  kind: 'create',
  entity,
  field: null,
  before: null,
  after,
});

/** One field of an existing entity. */
export const changed = (
  entity: EntityRef,
  field: string,
  before: unknown,
  after: unknown,
): EffectDraft => ({ kind: 'update', entity, field, before, after });
