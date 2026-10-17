/**
 * Presentation facts about the tool catalogue (PLAN §6) that the graph snapshot does not carry:
 * which family a tool belongs to (its node color) and which agent owns it.
 */
export type ToolFamily = 'read' | 'write' | 'create' | 'external';

/** read = grey, write = accent, create = teal, external = red (docs/design-system.md, graph encoding). */
export const toolFamily: Record<string, ToolFamily> = {
  lookup_order: 'read',
  update_address: 'write',
  create_ticket: 'create',
  post_message: 'create',
  send_email: 'external',
  schedule_followup: 'create',
  list_open_tickets: 'read',
  lookup_ticket: 'read',
  apply_credit: 'create',
};

export const familyOf = (tool: string | undefined): ToolFamily =>
  (tool && toolFamily[tool]) || 'write';

/** Tailwind classes for a family's fill, kept in one place so the ledger and graph agree. */
export const familyDotClass: Record<ToolFamily, string> = {
  read: 'bg-grey-node',
  write: 'bg-accent',
  create: 'bg-teal',
  external: 'bg-red',
};

export const agentName: Record<string, string> = {
  'ops-agent': 'Ops agent',
  'billing-agent': 'Billing agent',
  backtrack: 'Backtrack',
};
