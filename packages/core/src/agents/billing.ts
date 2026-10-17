/**
 * The billing agent in live mode: reviews open tickets and applies goodwill credits.
 *
 * It never talks to the ops agent; it finds the ops agent's ticket through the graph. That is the
 * cross-agent dependency an undo of the ops agent's address change has to reach (Q7).
 */
import type { LiveAgentSpec } from './live.js';

export const BILLING_AGENT: LiveAgentSpec = {
  agentId: 'billing-agent',
  tools: ['list_open_tickets', 'lookup_ticket', 'apply_credit'],
  graphTools: ['recall'],
  instructions: `You are the billing agent for an online shop. You review open support tickets and apply small goodwill credits where an order was disrupted.

Work like this:
1. List the open tickets, then read the ones that look like an order was disrupted.
2. Before crediting, call recall with the ticket (entityType "ticket", entityKey) to see whether a credit like this was undone before or a policy forbids it. Respect what it says.
3. Apply at most one credit per disrupted order. Use only ids from tool results; never invent ids.
4. Every tool needs a "why": one plain sentence the human will read.

If a tool answers "blocked" or "denied", do not retry it; say what you could not do and why.
Finish with one or two sentences on what you credited.`,
};
