/**
 * The ops agent's world tools, and the compensations the undo engine runs for them.
 *
 * Each tool reads the world through the store and returns `{ result, reads, writes }`; the
 * recorder applies the writes. `reads` is exactly what the tool used to decide what to write, and
 * DEPENDS_ON is derived from it, so the dependency graph is only as honest as these lists
 * (graph/model.md, "Tools and their inverses").
 */
import { z } from 'zod';
import type { EffectDraft } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { parseJson } from '../graph/cypher.js';
import { q14Conflicts } from '../graph/queries.js';
import { defineInverse } from '../sdk/inverse.js';
import { type AnyToolDefinition, defineTool } from '../sdk/registry.js';
import { nextKey } from '../world/store.js';
import {
  type CalendarEvent,
  type Customer,
  type Email,
  type Message,
  ref,
  type Ticket,
} from '../world/types.js';
import {
  changed,
  created,
  findOpenTicket,
  type Loaded,
  loadEntity,
  mentionedId,
} from './shared.js';

/** The customer's order a call is about: given explicitly, or the one its text mentions. */
async function orderOf(
  g: TenantGraph,
  customer: Customer,
  orderId: string | null,
): Promise<Loaded<'order'>> {
  if (!orderId)
    throw new Error(`Which order of ${customer.id}? Pass orderId or mention it (ord_N)`);
  const order = await loadEntity(g, 'order', orderId);
  if (order.state.customerId !== customer.id) {
    throw new Error(`${orderId} belongs to ${order.state.customerId}, not ${customer.id}`);
  }
  return order;
}

export const lookupOrder = defineTool({
  name: 'lookup_order',
  description:
    'Look up an order and the customer it belongs to: items, total, shipping address and status.',
  input: z.object({ orderId: z.string().describe('Order id, e.g. ord_1001') }),
  effect: 'read',
  async run({ g }, { orderId }) {
    const order = await loadEntity(g, 'order', orderId);
    const customer = await loadEntity(g, 'customer', order.state.customerId);
    return {
      result: { order: order.state, customer: customer.state },
      reads: [order.ref, customer.ref],
      writes: [],
    };
  },
});

export const updateAddress = defineTool({
  name: 'update_address',
  description:
    'Change the shipping address of an order that has not shipped yet. Undo restores the previous address.',
  input: z.object({
    orderId: z.string().describe('Order id, e.g. ord_1001'),
    address: z.string().min(5).describe('The full new shipping address'),
  }),
  effect: 'reversible',
  inverse: 'restore_address',
  undoMode: 'restore',
  async run({ g }, { orderId, address }) {
    const order = await loadEntity(g, 'order', orderId);
    const previous = order.state.address;
    if (order.state.status !== 'processing') {
      throw new Error(`${orderId} is already ${order.state.status}; its address cannot change`);
    }
    if (previous === address) throw new Error(`${orderId} already ships to ${address}`);
    return {
      result: {
        orderId,
        previous,
        address,
        // Ready-made text for the next steps (fixtures/ops-run.json): the ticket body and the
        // customer email quote these rather than the model rephrasing the change.
        summary: `Shipping address of ${orderId} changed from ${previous} to ${address}`,
        customerNote: `The delivery address for your order ${orderId} is now ${address}. Reply to this email if that is not right.`,
      },
      reads: [order.ref],
      writes: [changed(order.ref, 'address', previous, address)],
    };
  },
});

export const createTicket = defineTool({
  name: 'create_ticket',
  description:
    "Open a support ticket for a customer's order so the change is tracked. Undo withdraws the ticket.",
  input: z.object({
    customerId: z.string().describe('Customer the ticket is for, e.g. cust_42'),
    subject: z.string().min(3).describe('One-line summary'),
    body: z.string().min(1).describe('What happened and what was done'),
    orderId: z
      .string()
      .optional()
      .describe('Order the ticket is about; defaults to the order id the subject or body mentions'),
  }),
  effect: 'reversible',
  inverse: 'close_ticket',
  undoMode: 'inverse',
  async run({ g }, { customerId, subject, body, orderId }) {
    const customer = await loadEntity(g, 'customer', customerId);
    const order = await orderOf(g, customer.state, orderId ?? mentionedId('ord', subject, body));
    const id = await nextKey(g, 'ticket');
    const ticket: Ticket = {
      id,
      customerId,
      orderId: order.state.id,
      subject,
      body,
      status: 'open',
      thread: null,
    };
    return {
      result: {
        id,
        customerId,
        orderId: ticket.orderId,
        subject,
        status: ticket.status,
        // The ops-channel line the next step posts; it names the ticket so the message links to it.
        announcement: `Opened ${id} for ${customer.state.name} on ${ticket.orderId}: ${subject}`,
      },
      reads: [customer.ref, order.ref],
      writes: [created(ref('ticket', id), ticket)],
    };
  },
});

export const postMessage = defineTool({
  name: 'post_message',
  description:
    'Post a message about a ticket to a team channel; the first message starts the ticket thread. Undo deletes it.',
  input: z.object({
    channel: z
      .string()
      .regex(/^#[\w-]+$/)
      .describe('Channel name, e.g. #ops'),
    text: z.string().min(1).describe('Message text'),
    ticketId: z
      .string()
      .optional()
      .describe('Ticket the message is about; defaults to the ticket id the text mentions'),
  }),
  effect: 'reversible',
  inverse: 'delete_message',
  undoMode: 'inverse',
  async run({ g }, { channel, text, ticketId }) {
    const about = ticketId ?? mentionedId('tkt', text);
    if (!about) throw new Error('Which ticket? Pass ticketId or mention it (tkt_N) in the text');
    const ticket = await loadEntity(g, 'ticket', about);
    const id = await nextKey(g, 'message');
    const message: Message = { id, channel, text, ticketId: about };
    const writes: EffectDraft[] = [created(ref('message', id), message)];
    if (ticket.state.thread === null) writes.push(changed(ticket.ref, 'thread', null, id));
    return { result: { id, channel, ticketId: about }, reads: [ticket.ref], writes };
  },
});

export const sendEmail = defineTool({
  name: 'send_email',
  description:
    'Email a customer about their order. Irreversible: once sent it cannot be taken back, only corrected.',
  input: z.object({
    to: z.string().describe('Customer id to email, e.g. cust_42'),
    subject: z.string().min(3).describe('Email subject'),
    body: z.string().min(1).describe('Email body'),
    orderId: z
      .string()
      .optional()
      .describe('Order the email is about; defaults to the order id the subject or body mentions'),
  }),
  effect: 'irreversible',
  mitigation: 'draft_correction_email',
  async run({ g }, { to, subject, body, orderId }) {
    const customer = await loadEntity(g, 'customer', to);
    const order = await orderOf(g, customer.state, orderId ?? mentionedId('ord', subject, body));
    const ticket = await findOpenTicket(g, to, order.state.id);
    const id = await nextKey(g, 'email');
    const email: Email = {
      id,
      to,
      toAddress: customer.state.email,
      subject,
      body: ticket ? `${body}\n\nReference: ${ticket.state.id}` : body,
      status: 'sent',
    };
    return {
      result: { id, to, toAddress: email.toAddress, subject, status: email.status },
      reads: ticket ? [customer.ref, order.ref, ticket.ref] : [customer.ref, order.ref],
      // `external`: the message has left the system. Undo cannot restore it; it can only run the
      // mitigation, and the gate asks a human before this is recorded.
      writes: [
        { kind: 'external', entity: ref('email', id), field: null, before: null, after: email },
      ],
    };
  },
});

export const scheduleFollowup = defineTool({
  name: 'schedule_followup',
  description: 'Put a follow-up on the calendar for an open ticket. Undo cancels it.',
  input: z.object({
    ticketId: z.string().describe('Ticket to follow up on, e.g. tkt_1'),
    when: z.iso
      .datetime({ offset: true })
      .describe('ISO 8601 date-time with offset, e.g. 2026-10-20T10:00:00+05:30'),
    title: z
      .string()
      .optional()
      .describe('Calendar title; defaults to one built from the ticket subject'),
  }),
  effect: 'reversible',
  inverse: 'cancel_event',
  undoMode: 'inverse',
  async run({ g }, { ticketId, when, title }) {
    const ticket = await loadEntity(g, 'ticket', ticketId);
    if (ticket.state.status !== 'open') throw new Error(`${ticketId} is ${ticket.state.status}`);
    const id = await nextKey(g, 'event');
    const event: CalendarEvent = {
      id,
      ticketId,
      title: title ?? `Follow up: ${ticket.state.subject}`,
      when,
      status: 'scheduled',
    };
    return {
      result: { id, ticketId, title: event.title, when },
      reads: [ticket.ref],
      writes: [created(ref('event', id), event)],
    };
  },
});

// Inverses: one generic restore of every Effect's `before` (sdk/inverse.ts), named per tool so the
// plan reads in the tool's own terms. A create restores to null: the Entity stays, its state goes.
export const restoreAddress = defineInverse(
  'restore_address',
  "Put an order's shipping address back to what it was before the given action.",
);
export const closeTicket = defineInverse(
  'close_ticket',
  'Withdraw the ticket the given action opened.',
);
export const deleteMessage = defineInverse(
  'delete_message',
  'Delete the message the given action posted and unlink it from its ticket.',
);
export const cancelEvent = defineInverse(
  'cancel_event',
  'Cancel the follow-up the given action scheduled.',
);

export const draftCorrectionEmail = defineTool({
  name: 'draft_correction_email',
  description:
    'Mitigate an email that cannot be unsent: draft a correction to the same recipient for a human to review.',
  input: z.object({ actionId: z.string().describe('The recorded send_email action') }),
  effect: 'compensation',
  async run({ g }, { actionId }) {
    // The original is taken from the action's own effects (Q14 rows), not from arguments, so the
    // correction goes to whoever actually received the email, as it was sent.
    const { rows } = await q14Conflicts(g, { actionId });
    const row = rows.find((r) => r.kind === 'external' && r.type === 'email');
    const sent = parseJson<Email>(row?.after);
    if (!row || !sent) throw new Error(`${actionId} sent no email; there is nothing to correct`);
    const id = await nextKey(g, 'email');
    const draft: Email = {
      id,
      to: sent.to,
      toAddress: sent.toAddress,
      subject: `Correction: ${sent.subject}`,
      body: `Our earlier email "${sent.subject}" described a change that has since been reverted, so please disregard it. We will be in touch with the correct details.`,
      status: 'draft',
    };
    return {
      result: { id, corrects: sent.id, to: sent.to, subject: draft.subject, status: draft.status },
      reads: [ref('email', row.key)],
      writes: [created(ref('email', id), draft)],
    };
  },
});

/** What the ops agent may call, in the order the demo uses them. */
export const opsTools: AnyToolDefinition[] = [
  lookupOrder,
  updateAddress,
  createTicket,
  postMessage,
  sendEmail,
  scheduleFollowup,
];

/** Run only by the undo engine, resolved by the `inverse_tool` / `mitigation_tool` names above. */
export const opsCompensations: AnyToolDefinition[] = [
  restoreAddress,
  closeTicket,
  deleteMessage,
  cancelEvent,
  draftCorrectionEmail,
];
