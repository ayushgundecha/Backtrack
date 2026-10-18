/**
 * The synthetic world the demo agents act on. It lives in the graph as `Entity.state` (canonical
 * JSON) because the deployment is stateless: there is no other database to keep it in.
 */
import type { EntityRef } from '../contracts/types.js';

export const ENTITY_TYPES = [
  'customer',
  'order',
  'ticket',
  'message',
  'event',
  'email',
  'credit',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface Customer {
  id: string;
  name: string;
  email: string;
  tier: 'standard' | 'gold';
}
export interface Order {
  id: string;
  customerId: string;
  items: string[];
  total: number;
  address: string;
  status: 'processing' | 'shipped' | 'delivered';
}
export interface Ticket {
  id: string;
  customerId: string;
  orderId: string;
  subject: string;
  body: string;
  status: 'open' | 'closed';
  /** Message id of the ops-channel thread about this ticket, once posted. */
  thread: string | null;
}
export interface Message {
  id: string;
  channel: string;
  text: string;
  ticketId: string;
}
export interface CalendarEvent {
  id: string;
  ticketId: string;
  title: string;
  when: string;
  status: 'scheduled';
}
export interface Email {
  id: string;
  to: string;
  toAddress: string;
  subject: string;
  body: string;
  status: 'sent' | 'draft';
}
export interface Credit {
  id: string;
  customerId: string;
  ticketId: string;
  amount: number;
  reason: string;
  status: 'active';
}

export interface EntityStateByType {
  customer: Customer;
  order: Order;
  ticket: Ticket;
  message: Message;
  event: CalendarEvent;
  email: Email;
  credit: Credit;
}

/** Key prefixes for entities the tools create; keys are `<prefix>_<n>` so demo runs are repeatable. */
export const KEY_PREFIX: Record<Exclude<EntityType, 'customer' | 'order'>, string> = {
  ticket: 'tkt',
  message: 'msg',
  event: 'evt',
  email: 'eml',
  credit: 'cr',
};

export const entityKey = (e: Pick<EntityRef, 'type' | 'key'>): string => `${e.type}:${e.key}`;
export const displayOf = (type: string, key: string): string => `${type} ${key}`;

/**
 * What a person calls an entity in its current state ("Rahul Mehta", "#ops message"), for the
 * world panel. Ids stay in `displayOf`, which plan labels and effects use.
 */
export function titleOf(type: string, key: string, state: Record<string, unknown> | null): string {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  if (!state) return displayOf(type, key);
  switch (type) {
    case 'customer':
      return str(state.name) ?? displayOf(type, key);
    case 'ticket':
    case 'email':
      return str(state.subject) ?? displayOf(type, key);
    case 'message':
      return str(state.channel) ? `${state.channel} message` : displayOf(type, key);
    case 'event':
      return str(state.title) ?? displayOf(type, key);
    case 'credit':
      return typeof state.amount === 'number' ? `Credit of ${state.amount}` : displayOf(type, key);
    default:
      return key;
  }
}
export const ref = (type: EntityType, key: string): EntityRef => ({
  type,
  key,
  display: displayOf(type, key),
});
