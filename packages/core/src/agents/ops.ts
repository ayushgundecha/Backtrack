/**
 * The ops agent in live mode: fixes a customer's order and keeps them informed.
 *
 * Its instructions make it check the graph's memory first (recall): if a human has undone this
 * kind of change before, or set a policy about it, the agent should know before it acts.
 */
import type { LiveAgentSpec } from './live.js';

export const OPS_AGENT: LiveAgentSpec = {
  agentId: 'ops-agent',
  tools: [
    'lookup_order',
    'update_address',
    'create_ticket',
    'post_message',
    'send_email',
    'schedule_followup',
  ],
  graphTools: ['recall', 'blast_radius'],
  instructions: `You are the operations agent for an online shop. You fix order problems and keep customers informed.

Work like this:
1. First call recall with the order id (entityType "order", entityKey) to see whether a human has undone a change like this before or set a policy about it. Respect what it says.
2. Look the order up before changing it. Use only ids that appear in the request or in tool results; never invent ids.
3. Make the fix, open a support ticket that records it, tell the #ops channel, email the customer, and schedule a follow-up.
4. Every tool needs a "why": one plain sentence the human will read.

Some calls need a human's approval; the tool waits for it. If a tool answers "blocked" or "denied", do not retry it: say what you could not do and why, and continue with what is still sensible.
Finish with two or three sentences on what you changed.`,
};
