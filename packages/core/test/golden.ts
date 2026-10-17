/**
 * Builds the golden demo graph (ops run then billing run) straight through the recorder, with the
 * reads and writes the real tools produce (see graph/model.md). Query tests run against it.
 */
import type { EffectDraft, EntityRef } from '../src/contracts/types.js';
import type { TenantGraph } from '../src/graph/client.js';
import { type RecordedAction, record, startRun, startStep } from '../src/sdk/recorder.js';

const ref = (type: string, key: string): EntityRef => ({ type, key });
const order = ref('order', 'ord_1001');
const customer = ref('customer', 'cust_42');
const ticket = ref('ticket', 'tkt_1');

const OLD = '14 Marine Drive, Mumbai 400020';
const NEW = '221B Baker Street, London NW1 6XE';
const ticketState = {
  id: 'tkt_1',
  customerId: 'cust_42',
  orderId: 'ord_1001',
  subject: 'Address correction for ord_1001',
  body: `Shipping address changed to ${NEW}`,
  status: 'open',
  thread: null,
};

type Flags = { reversible: boolean; inverseTool: string | null; mitigationTool: string | null };
const READ: Flags = { reversible: true, inverseTool: null, mitigationTool: null };
const inv = (inverseTool: string): Flags => ({
  reversible: true,
  inverseTool,
  mitigationTool: null,
});

interface StepSpec {
  tool: string;
  flags: Flags;
  reads: EntityRef[];
  writes: EffectDraft[];
}

const create = (entity: EntityRef, after: unknown): EffectDraft => ({
  kind: 'create',
  entity,
  field: null,
  before: null,
  after,
});

export const OPS_STEPS: StepSpec[] = [
  { tool: 'lookup_order', flags: READ, reads: [order, customer], writes: [] },
  {
    tool: 'update_address',
    flags: inv('restore_address'),
    reads: [order],
    writes: [{ kind: 'update', entity: order, field: 'address', before: OLD, after: NEW }],
  },
  {
    tool: 'create_ticket',
    flags: inv('close_ticket'),
    reads: [customer, order],
    writes: [create(ticket, ticketState)],
  },
  {
    tool: 'post_message',
    flags: inv('delete_message'),
    reads: [ticket],
    writes: [
      create(ref('message', 'msg_1'), {
        id: 'msg_1',
        channel: '#ops',
        text: 'Re-routed',
        ticketId: 'tkt_1',
      }),
      { kind: 'update', entity: ticket, field: 'thread', before: null, after: 'msg_1' },
    ],
  },
  {
    tool: 'send_email',
    flags: { reversible: false, inverseTool: null, mitigationTool: 'draft_correction_email' },
    reads: [customer, order, ticket],
    writes: [
      {
        kind: 'external',
        entity: ref('email', 'eml_1'),
        field: null,
        before: null,
        after: {
          id: 'eml_1',
          to: 'cust_42',
          status: 'sent',
          subject: 'Updated',
          body: NEW,
          toAddress: 'rahul.mehta@example.com',
        },
      },
    ],
  },
  {
    tool: 'schedule_followup',
    flags: inv('cancel_event'),
    reads: [ticket],
    writes: [
      create(ref('event', 'evt_1'), {
        id: 'evt_1',
        ticketId: 'tkt_1',
        title: 'Follow up',
        when: '2026-10-20T10:00:00+05:30',
        status: 'scheduled',
      }),
    ],
  },
];

export const BILLING_STEPS: StepSpec[] = [
  { tool: 'list_open_tickets', flags: READ, reads: [ticket], writes: [] },
  { tool: 'lookup_ticket', flags: READ, reads: [ticket], writes: [] },
  {
    tool: 'apply_credit',
    flags: inv('revoke_credit'),
    reads: [customer, ticket],
    writes: [
      create(ref('credit', 'cr_1'), {
        id: 'cr_1',
        customerId: 'cust_42',
        ticketId: 'tkt_1',
        amount: 10,
        reason: 'Address correction',
        status: 'active',
      }),
    ],
  },
];

export async function recordRun(
  g: TenantGraph,
  agentId: 'ops-agent' | 'billing-agent',
  steps: StepSpec[],
): Promise<Record<string, RecordedAction>> {
  const { runId } = await startRun(g, { agentId, kind: 'agent', goal: 'golden', mode: 'replay' });
  const out: Record<string, RecordedAction> = {};
  for (const [index, s] of steps.entries()) {
    const { stepId } = await startStep(g, { runId, index, thought: `Run ${s.tool}` });
    out[s.tool] = await record(g, {
      runId,
      stepId,
      agentId,
      tool: s.tool,
      args: {},
      kind: 'do',
      status: 'done',
      ...s.flags,
      outcome: { result: null, reads: s.reads, writes: s.writes },
    });
  }
  return out;
}

/** The ids of the golden actions by tool name. */
export async function buildGolden(g: TenantGraph): Promise<Record<string, string>> {
  const ops = await recordRun(g, 'ops-agent', OPS_STEPS);
  const billing = await recordRun(g, 'billing-agent', BILLING_STEPS);
  return Object.fromEntries(
    Object.entries({ ...ops, ...billing }).map(([tool, rec]) => [tool, rec.action.id]),
  );
}
