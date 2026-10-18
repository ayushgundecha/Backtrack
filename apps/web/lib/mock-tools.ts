/**
 * MOCK ONLY. In-browser stand-ins for the world tools in packages/core/agents, written to match
 * the tool table in the engine design notes: same reads, same writes, same reversibility.
 * Like the real tools they are pure: they report what they read and what they would write, and the
 * mock recorder decides whether and when the writes are applied (e.g. after an approval).
 */
import type { AgentId, EffectDraft, EntityRef } from '@backtrack/core/contracts';

export type EntityState = Record<string, unknown>;

/** Read access to the live mock world. `nextKey` peeks at the next id without reserving it. */
export interface WorldReader {
  get(type: string, key: string): EntityState | null;
  all(type: string): EntityState[];
  nextKey(type: string): string;
}

export interface ToolOutput {
  result: Record<string, unknown>;
  reads: EntityRef[];
  writes: EffectDraft[];
}

export type UndoMode = 'restore' | 'inverse' | 'mitigation';

export interface ToolSpec {
  agentId: AgentId;
  reversible: boolean;
  inverseTool: string | null;
  mitigationTool: string | null;
  /** restore = put a field back; inverse = remove what was created; mitigation = cannot revert. */
  undoMode: UndoMode | null;
  /** Words in an undo request that point at this tool ("undo the address change"). */
  keywords: string[];
  run(args: Record<string, unknown>, world: WorldReader): ToolOutput;
}

/** A tool refused its arguments (unknown id, missing reference). The message is shown verbatim. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** World entity keys are a per-type counter: tkt_1, msg_1, evt_1, eml_1, cr_1. */
export const keyPrefix: Record<string, string> = {
  ticket: 'tkt',
  message: 'msg',
  event: 'evt',
  email: 'eml',
  credit: 'cr',
};

/**
 * What the world panel calls an entity, from its current state ("Rahul Mehta", "#ops message").
 * Mirrors `titleOf` in packages/core/src/world/types.ts.
 */
export function worldTitle(type: string, state: EntityState): string {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  switch (type) {
    case 'customer':
      return str(state.name) ?? refDisplay(type, String(state.id));
    case 'ticket':
    case 'email':
      return str(state.subject) ?? refDisplay(type, String(state.id));
    case 'message':
      return str(state.channel) ? `${state.channel} message` : refDisplay(type, String(state.id));
    case 'event':
      return str(state.title) ?? refDisplay(type, String(state.id));
    case 'credit':
      return typeof state.amount === 'number'
        ? `Credit of ${state.amount}`
        : refDisplay(type, String(state.id));
    default:
      return String(state.id);
  }
}

/**
 * How effects, plan steps and graph nodes name an entity: by type and id ("order ord_1001"), the
 * way the recorder stores `Entity.display` (`displayOf` in packages/core/src/world/types.ts).
 */
export const refDisplay = (type: string, key: string) => `${type} ${key}`;

const ref = (type: string, state: EntityState): EntityRef => ({
  type,
  key: String(state.id),
  display: refDisplay(type, String(state.id)),
});

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolError(`Missing argument "${name}"`);
  return value;
}

function need(world: WorldReader, type: string, key: string): EntityState {
  const state = world.get(type, key);
  if (!state) throw new ToolError(`No ${type} with id ${key}`);
  return state;
}

/** Tools that take free text find the id it mentions, the way the real tools validate references. */
function mentioned(pattern: RegExp, ...sources: string[]): string {
  for (const source of sources) {
    const match = pattern.exec(source);
    if (match) return match[0];
  }
  throw new ToolError(`Expected an id matching ${pattern} in "${sources.join(' ')}"`);
}

/** Open tickets of a customer (optionally for one order); more than one is ambiguous, as in core. */
function openTicketOf(
  world: WorldReader,
  customerId: string,
  orderId?: string,
): EntityState | null {
  const matches = world
    .all('ticket')
    .filter(
      (t) =>
        t.status === 'open' &&
        t.customerId === customerId &&
        (orderId === undefined || t.orderId === orderId),
    );
  if (matches.length > 1) {
    const ids = matches.map((t) => t.id).join(', ');
    throw new ToolError(`${customerId} has ${matches.length} open tickets (${ids}); pass ticketId`);
  }
  return matches[0] ?? null;
}

/** The order a call is about: given explicitly, or the one its text mentions; it must be theirs. */
function orderOf(
  world: WorldReader,
  customer: EntityState,
  args: Record<string, unknown>,
  ...texts: string[]
): EntityState {
  const id = optional(args, 'orderId') ?? mentioned(/ord_\d+/, ...texts);
  const order = need(world, 'order', id);
  if (order.customerId !== customer.id) {
    throw new ToolError(`${id} belongs to ${order.customerId}, not ${customer.id}`);
  }
  return order;
}

const create = (type: string, state: EntityState, kind: 'create' | 'external' = 'create') =>
  ({ kind, entity: ref(type, state), field: null, before: null, after: state }) as EffectDraft;

function optional(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// Results, texts and reads below mirror packages/core/src/agents/tools.ops.ts and
// tools.billing.ts word for word: test/parity.test.ts fails when the two drift apart.
export const tools: Record<string, ToolSpec> = {
  lookup_order: {
    agentId: 'ops-agent',
    reversible: true,
    inverseTool: null,
    mitigationTool: null,
    undoMode: null,
    keywords: [],
    run(args, world) {
      const order = need(world, 'order', text(args, 'orderId'));
      const customer = need(world, 'customer', String(order.customerId));
      return {
        result: { order, customer },
        reads: [ref('order', order), ref('customer', customer)],
        writes: [],
      };
    },
  },

  update_address: {
    agentId: 'ops-agent',
    reversible: true,
    inverseTool: 'restore_address',
    mitigationTool: null,
    undoMode: 'restore',
    keywords: ['address', 'shipping', 'delivery', 'reroute', 'update_address'],
    run(args, world) {
      const orderId = text(args, 'orderId');
      const order = need(world, 'order', orderId);
      const address = text(args, 'address');
      const previous = order.address;
      if (order.status !== 'processing') {
        throw new ToolError(`${orderId} is already ${order.status}; its address cannot change`);
      }
      if (previous === address) throw new ToolError(`${orderId} already ships to ${address}`);
      return {
        result: {
          orderId,
          previous,
          address,
          summary: `Shipping address of ${orderId} changed from ${previous} to ${address}`,
          customerNote: `The delivery address for your order ${orderId} is now ${address}. Reply to this email if that is not right.`,
        },
        reads: [ref('order', order)],
        writes: [
          {
            kind: 'update',
            entity: ref('order', order),
            field: 'address',
            before: previous,
            after: address,
          },
        ],
      };
    },
  },

  create_ticket: {
    agentId: 'ops-agent',
    reversible: true,
    inverseTool: 'close_ticket',
    mitigationTool: null,
    undoMode: 'inverse',
    keywords: ['ticket', 'support', 'case', 'create_ticket'],
    run(args, world) {
      const customer = need(world, 'customer', text(args, 'customerId'));
      const subject = text(args, 'subject');
      const body = text(args, 'body');
      const order = orderOf(world, customer, args, subject, body);
      const ticket = {
        id: world.nextKey('ticket'),
        customerId: customer.id,
        orderId: order.id,
        subject,
        body,
        status: 'open',
        thread: null,
      };
      return {
        result: {
          id: ticket.id,
          customerId: ticket.customerId,
          orderId: ticket.orderId,
          subject,
          status: ticket.status,
          announcement: `Opened ${ticket.id} for ${customer.name} on ${ticket.orderId}: ${subject}`,
        },
        reads: [ref('customer', customer), ref('order', order)],
        writes: [create('ticket', ticket)],
      };
    },
  },

  post_message: {
    agentId: 'ops-agent',
    reversible: true,
    inverseTool: 'delete_message',
    mitigationTool: null,
    undoMode: 'inverse',
    keywords: ['message', 'post', 'channel', 'announcement', 'post_message'],
    run(args, world) {
      const channel = text(args, 'channel');
      const body = text(args, 'text');
      const about = optional(args, 'ticketId') ?? mentioned(/tkt_\d+/, body);
      const ticket = need(world, 'ticket', about);
      const message = { id: world.nextKey('message'), channel, text: body, ticketId: about };
      const writes: EffectDraft[] = [create('message', message)];
      // The first message starts the ticket's thread; later ones leave it alone.
      if ((ticket.thread ?? null) === null) {
        writes.push({
          kind: 'update',
          entity: ref('ticket', ticket),
          field: 'thread',
          before: null,
          after: message.id,
        });
      }
      return {
        result: { id: message.id, channel, ticketId: about },
        reads: [ref('ticket', ticket)],
        writes,
      };
    },
  },

  send_email: {
    agentId: 'ops-agent',
    reversible: false,
    inverseTool: null,
    mitigationTool: 'draft_correction_email',
    undoMode: 'mitigation',
    keywords: ['email', 'mail', 'send_email'],
    run(args, world) {
      const customer = need(world, 'customer', text(args, 'to'));
      const subject = text(args, 'subject');
      const body = text(args, 'body');
      const order = orderOf(world, customer, args, subject, body);
      const ticket = openTicketOf(world, String(customer.id), String(order.id));
      const email = {
        id: world.nextKey('email'),
        to: customer.id,
        toAddress: customer.email,
        subject,
        body: ticket ? `${body}\n\nReference: ${ticket.id}` : body,
        status: 'sent',
      };
      return {
        result: {
          id: email.id,
          to: email.to,
          toAddress: email.toAddress,
          subject,
          status: email.status,
        },
        reads: [
          ref('customer', customer),
          ref('order', order),
          ...(ticket ? [ref('ticket', ticket)] : []),
        ],
        writes: [create('email', email, 'external')],
      };
    },
  },

  schedule_followup: {
    agentId: 'ops-agent',
    reversible: true,
    inverseTool: 'cancel_event',
    mitigationTool: null,
    undoMode: 'inverse',
    keywords: ['followup', 'follow', 'calendar', 'event', 'reminder', 'schedule_followup'],
    run(args, world) {
      const ticketId = text(args, 'ticketId');
      const ticket = need(world, 'ticket', ticketId);
      if (ticket.status !== 'open') throw new ToolError(`${ticketId} is ${ticket.status}`);
      const when = text(args, 'when');
      const event = {
        id: world.nextKey('event'),
        ticketId,
        title: optional(args, 'title') ?? `Follow up: ${ticket.subject}`,
        when,
        status: 'scheduled',
      };
      return {
        result: { id: event.id, ticketId, title: event.title, when },
        reads: [ref('ticket', ticket)],
        writes: [create('event', event)],
      };
    },
  },

  list_open_tickets: {
    agentId: 'billing-agent',
    reversible: true,
    inverseTool: null,
    mitigationTool: null,
    undoMode: null,
    keywords: [],
    run(_args, world) {
      const open = world.all('ticket').filter((t) => t.status === 'open');
      return {
        result: {
          tickets: open.map(({ id, customerId, orderId, subject }) => ({
            id,
            customerId,
            orderId,
            subject,
          })),
        },
        reads: open.map((t) => ref('ticket', t)),
        writes: [],
      };
    },
  },

  lookup_ticket: {
    agentId: 'billing-agent',
    reversible: true,
    inverseTool: null,
    mitigationTool: null,
    undoMode: null,
    keywords: [],
    run(args, world) {
      const ticket = need(world, 'ticket', text(args, 'ticketId'));
      return { result: ticket, reads: [ref('ticket', ticket)], writes: [] };
    },
  },

  apply_credit: {
    agentId: 'billing-agent',
    reversible: true,
    inverseTool: 'revoke_credit',
    mitigationTool: null,
    undoMode: 'inverse',
    keywords: ['credit', 'refund', 'goodwill', 'apply_credit'],
    run(args, world) {
      const customerId = text(args, 'customerId');
      const customer = need(world, 'customer', customerId);
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0)
        throw new ToolError('Credit amount must be positive');
      const reason = text(args, 'reason');
      // A credit always settles a ticket, so it is traceable to the change that caused it.
      const given = optional(args, 'ticketId');
      const ticket = given ? need(world, 'ticket', given) : openTicketOf(world, customerId);
      if (!ticket)
        throw new ToolError(`${customerId} has no open ticket; a credit must settle one`);
      if (ticket.customerId !== customerId || ticket.status !== 'open') {
        throw new ToolError(`${ticket.id} is not an open ticket of ${customerId}`);
      }
      const credit = {
        id: world.nextKey('credit'),
        customerId,
        ticketId: ticket.id,
        amount,
        reason,
        status: 'active',
      };
      return {
        result: { id: credit.id, customerId, ticketId: credit.ticketId, amount, reason },
        reads: [ref('customer', customer), ref('ticket', ticket)],
        writes: [create('credit', credit)],
      };
    },
  },
};

/**
 * The mitigation for a sent email (draft_correction_email): a correction to the same recipient,
 * left as a draft for a human. It reads the email it corrects, as the core tool does.
 */
export function correctionDraft(world: WorldReader, sent: EntityState): ToolOutput {
  const draft = {
    id: world.nextKey('email'),
    to: sent.to,
    toAddress: sent.toAddress,
    subject: `Correction: ${sent.subject}`,
    body: `Our earlier email "${sent.subject}" described a change that has since been reverted, so please disregard it. We will be in touch with the correct details.`,
    status: 'draft',
  };
  return {
    result: {
      id: draft.id,
      corrects: sent.id,
      to: draft.to,
      subject: draft.subject,
      status: draft.status,
    },
    reads: [ref('email', sent)],
    writes: [create('email', draft)],
  };
}
