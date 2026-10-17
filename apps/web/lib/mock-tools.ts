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

export function displayOf(type: string, state: EntityState): string {
  switch (type) {
    case 'customer':
      return String(state.name);
    case 'ticket':
    case 'email':
      return String(state.subject);
    case 'message':
      return `${state.channel} message`;
    case 'event':
      return String(state.title);
    case 'credit':
      return `Credit of ${state.amount}`;
    default:
      return String(state.id);
  }
}

const ref = (type: string, state: EntityState): EntityRef => ({
  type,
  key: String(state.id),
  display: displayOf(type, state),
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

const openTicketOf = (world: WorldReader, customerId: string): EntityState | undefined =>
  world
    .all('ticket')
    .filter((t) => t.customerId === customerId && t.status === 'open')
    .at(-1);

const create = (type: string, state: EntityState, kind: 'create' | 'external' = 'create') =>
  ({ kind, entity: ref(type, state), field: null, before: null, after: state }) as EffectDraft;

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
      const order = need(world, 'order', text(args, 'orderId'));
      const address = text(args, 'address');
      return {
        result: {
          orderId: order.id,
          previousAddress: order.address,
          address,
          summary: `Shipping address for ${order.id} changed from ${order.address} to ${address}.`,
          customerNote: `Your order ${order.id} will now be delivered to ${address}.`,
        },
        reads: [ref('order', order)],
        writes: [
          {
            kind: 'update',
            entity: ref('order', order),
            field: 'address',
            before: order.address,
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
      const order = need(world, 'order', mentioned(/ord_\d+/, subject, body));
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
          ...ticket,
          announcement: `Order ${order.id} for ${customer.name} was re-routed; tracking in ${ticket.id}.`,
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
      const ticket = need(world, 'ticket', mentioned(/tkt_\d+/, body));
      const message = { id: world.nextKey('message'), channel, text: body, ticketId: ticket.id };
      return {
        result: { id: message.id, channel, ticketId: ticket.id },
        reads: [ref('ticket', ticket)],
        writes: [
          create('message', message),
          {
            kind: 'update',
            entity: ref('ticket', ticket),
            field: 'thread',
            before: ticket.thread ?? null,
            after: message.id,
          },
        ],
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
      const order = need(world, 'order', mentioned(/ord_\d+/, subject, body));
      const ticket = openTicketOf(world, String(customer.id));
      const email = {
        id: world.nextKey('email'),
        to: customer.id,
        toAddress: customer.email,
        subject,
        body,
        status: 'sent',
      };
      return {
        result: { id: email.id, status: email.status, toAddress: email.toAddress },
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
      const ticket = need(world, 'ticket', text(args, 'ticketId'));
      const event = {
        id: world.nextKey('event'),
        ticketId: ticket.id,
        title: `Follow up on ${ticket.subject}`,
        when: text(args, 'when'),
        status: 'scheduled',
      };
      return {
        result: { id: event.id, when: event.when },
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
      const customer = need(world, 'customer', text(args, 'customerId'));
      const ticket = openTicketOf(world, String(customer.id));
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0)
        throw new ToolError('Credit amount must be positive');
      const credit = {
        id: world.nextKey('credit'),
        customerId: customer.id,
        ticketId: ticket?.id ?? null,
        amount,
        reason: text(args, 'reason'),
        status: 'active',
      };
      return {
        result: { id: credit.id, amount },
        reads: [ref('customer', customer), ...(ticket ? [ref('ticket', ticket)] : [])],
        writes: [create('credit', credit)],
      };
    },
  },
};

/** The mitigation for a sent email: a correction left as a draft for a human to send. */
export function correctionDraft(world: WorldReader, sent: EntityState): EffectDraft {
  return create('email', {
    id: world.nextKey('email'),
    to: sent.to,
    toAddress: sent.toAddress,
    subject: `Correction: ${sent.subject}`,
    body: 'Please disregard our previous email; a teammate will follow up with the correct details.',
    status: 'draft',
  });
}
