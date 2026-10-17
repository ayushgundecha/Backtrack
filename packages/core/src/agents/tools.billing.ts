/**
 * The billing agent's world tools.
 *
 * Billing never talks to ops: it discovers work from the shared world in the graph (the open
 * tickets ops left behind). Because every tool records what it read, that handoff through shared
 * state becomes DEPENDS_ON edges across agents, which is how undoing an ops change finds the
 * billing credit that was built on it (Q7).
 */
import { z } from 'zod';
import { defineInverse } from '../sdk/inverse.js';
import { type AnyToolDefinition, defineTool } from '../sdk/registry.js';
import { listByType, nextKey } from '../world/store.js';
import { type Credit, ref } from '../world/types.js';
import { created, findOpenTicket, loadEntity } from './shared.js';

export const listOpenTickets = defineTool({
  name: 'list_open_tickets',
  description:
    'List the support tickets that are open right now, whichever agent opened them. Start here to find work.',
  input: z.object({}),
  effect: 'read',
  async run({ g }) {
    const open = (await listByType(g, 'ticket')).filter((t) => t.status === 'open');
    return {
      result: {
        tickets: open.map(({ id, customerId, orderId, subject }) => ({
          id,
          customerId,
          orderId,
          subject,
        })),
      },
      // Every listed ticket is read: the listing (and what billing does next) depends on each.
      reads: open.map((t) => ref('ticket', t.id)),
      writes: [],
    };
  },
});

export const lookupTicket = defineTool({
  name: 'lookup_ticket',
  description: 'Read one support ticket: customer, order, subject, body, status and thread.',
  input: z.object({ ticketId: z.string().describe('Ticket id, e.g. tkt_1') }),
  effect: 'read',
  async run({ g }, { ticketId }) {
    const ticket = await loadEntity(g, 'ticket', ticketId);
    return { result: ticket.state, reads: [ticket.ref], writes: [] };
  },
});

export const applyCredit = defineTool({
  name: 'apply_credit',
  description:
    'Apply a goodwill credit to a customer against one of their open tickets. Undo revokes it.',
  input: z.object({
    customerId: z.string().describe('Customer to credit, e.g. cust_42'),
    amount: z.number().positive().describe('Credit amount in the order currency'),
    reason: z.string().min(3).describe('Why the credit is given'),
    ticketId: z
      .string()
      .optional()
      .describe("Open ticket the credit settles; defaults to the customer's only open ticket"),
  }),
  effect: 'reversible',
  inverse: 'revoke_credit',
  undoMode: 'inverse',
  async run({ g }, { customerId, amount, reason, ticketId }) {
    const customer = await loadEntity(g, 'customer', customerId);
    // A credit always settles a ticket, so it is traceable to the change that caused it.
    const ticket = ticketId
      ? await loadEntity(g, 'ticket', ticketId)
      : await findOpenTicket(g, customerId);
    if (!ticket) throw new Error(`${customerId} has no open ticket; a credit must settle one`);
    if (ticket.state.customerId !== customerId || ticket.state.status !== 'open') {
      throw new Error(`${ticket.state.id} is not an open ticket of ${customerId}`);
    }
    const id = await nextKey(g, 'credit');
    const credit: Credit = {
      id,
      customerId,
      ticketId: ticket.state.id,
      amount,
      reason,
      status: 'active',
    };
    return {
      result: { id, customerId, ticketId: credit.ticketId, amount, reason },
      reads: [customer.ref, ticket.ref],
      writes: [created(ref('credit', id), credit)],
    };
  },
});

export const revokeCredit = defineInverse(
  'revoke_credit',
  'Revoke the credit the given action applied.',
);

/** What the billing agent may call. */
export const billingTools: AnyToolDefinition[] = [listOpenTickets, lookupTicket, applyCredit];

/** Run only by the undo engine. */
export const billingCompensations: AnyToolDefinition[] = [revokeCredit];
