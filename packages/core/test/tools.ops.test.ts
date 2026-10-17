import { beforeEach, describe, expect, it } from 'vitest';
import { getEntity, getMany } from '../src/world/store.js';
import { fresh, testGraph } from './helpers.js';
import { keys, newRun } from './tool-harness.js';

const g = testGraph();
const OLD = '14 Marine Drive, Mumbai 400020';
const NEW = '221B Baker Street, London NW1 6XE';

let call: Awaited<ReturnType<typeof newRun>>;

/** The ops run up to the ticket: update_address, then create_ticket for ord_1001. */
async function openTicket() {
  const address = await call('update_address', { orderId: 'ord_1001', address: NEW });
  const ticket = await call('create_ticket', {
    customerId: 'cust_42',
    subject: 'Address correction for ord_1001',
    body: address.out.result.summary,
  });
  return { address, ticket };
}

describe('ops tools', () => {
  beforeEach(async () => {
    await fresh(g);
    call = await newRun(g, 'ops-agent');
  });

  it('lookup_order reads the order and its customer and writes nothing', async () => {
    const { out, rec } = await call('lookup_order', { orderId: 'ord_1001' });
    expect(out.result).toMatchObject({
      order: { id: 'ord_1001', address: OLD, customerId: 'cust_42' },
      customer: { id: 'cust_42', name: 'Rahul Mehta' },
    });
    expect(keys(out.reads)).toEqual(['order:ord_1001', 'customer:cust_42']);
    expect(out.writes).toEqual([]);
    expect(rec.action.reversible).toBe(true);
    await expect(call('lookup_order', { orderId: 'ord_x' })).rejects.toThrow('Unknown order ord_x');
  });

  it('update_address writes one field effect, and restore_address puts the old address back', async () => {
    const { out, rec } = await call('update_address', { orderId: 'ord_1001', address: NEW });
    expect(out.result).toMatchObject({ orderId: 'ord_1001', previous: OLD, address: NEW });
    expect(out.result.summary).toContain(NEW);
    expect(out.result.customerNote).toContain('ord_1001');
    expect(keys(out.reads)).toEqual(['order:ord_1001']);
    expect(out.writes).toEqual([
      expect.objectContaining({ kind: 'update', field: 'address', before: OLD, after: NEW }),
    ]);
    expect(rec.action.inverseTool).toBe('restore_address');
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe(NEW);

    const undo = await call(
      'restore_address',
      { actionId: rec.action.id },
      {
        kind: 'undo',
        undoes: rec.action.id,
      },
    );
    expect(undo.out.result).toEqual({ actionId: rec.action.id, restored: ['order:ord_1001'] });
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe(OLD);

    await expect(call('update_address', { orderId: 'ord_1001', address: OLD })).rejects.toThrow(
      'already ships to',
    );
  });

  it('create_ticket reads customer and order, creates tkt_1, and close_ticket soft-deletes it', async () => {
    const { ticket } = await openTicket();
    expect(ticket.out.result).toMatchObject({ id: 'tkt_1', orderId: 'ord_1001', status: 'open' });
    expect(ticket.out.result.announcement).toContain('tkt_1');
    expect(keys(ticket.out.reads)).toEqual(['customer:cust_42', 'order:ord_1001']);
    expect(ticket.out.writes).toEqual([
      {
        kind: 'create',
        entity: expect.objectContaining({ type: 'ticket', key: 'tkt_1' }),
        field: null,
        before: null,
        after: {
          id: 'tkt_1',
          customerId: 'cust_42',
          orderId: 'ord_1001',
          subject: 'Address correction for ord_1001',
          body: `Shipping address of ord_1001 changed from ${OLD} to ${NEW}`,
          status: 'open',
          thread: null,
        },
      },
    ]);

    await call(
      'close_ticket',
      { actionId: ticket.rec.action.id },
      {
        kind: 'undo',
        undoes: ticket.rec.action.id,
      },
    );
    // Soft delete: the Entity node (and its history) stays, its state becomes null.
    expect(await getMany(g, [{ type: 'ticket', key: 'tkt_1' }])).toEqual([
      expect.objectContaining({ state: null }),
    ]);

    await expect(
      call('create_ticket', { customerId: 'cust_41', subject: 'About ord_1001', body: 'x' }),
    ).rejects.toThrow('ord_1001 belongs to cust_42, not cust_41');
  });

  it('post_message reads the ticket, creates msg_1 and starts the thread; delete_message undoes both', async () => {
    const { ticket } = await openTicket();
    const { out, rec } = await call('post_message', {
      channel: '#ops',
      text: ticket.out.result.announcement,
    });
    expect(out.result).toEqual({ id: 'msg_1', channel: '#ops', ticketId: 'tkt_1' });
    expect(keys(out.reads)).toEqual(['ticket:tkt_1']);
    expect(out.writes).toEqual([
      expect.objectContaining({
        kind: 'create',
        entity: expect.objectContaining({ key: 'msg_1' }),
        after: {
          id: 'msg_1',
          channel: '#ops',
          text: ticket.out.result.announcement,
          ticketId: 'tkt_1',
        },
      }),
      expect.objectContaining({ kind: 'update', field: 'thread', before: null, after: 'msg_1' }),
    ]);
    expect((await getEntity(g, 'ticket', 'tkt_1'))?.thread).toBe('msg_1');

    // A second message is a reply in the thread: it does not move the thread.
    const reply = await call('post_message', { channel: '#ops', text: 'Done', ticketId: 'tkt_1' });
    expect(reply.out.writes.map((w) => w.kind)).toEqual(['create']);

    await call(
      'delete_message',
      { actionId: rec.action.id },
      {
        kind: 'undo',
        undoes: rec.action.id,
      },
    );
    expect(await getEntity(g, 'message', 'msg_1')).toBeNull();
    expect((await getEntity(g, 'ticket', 'tkt_1'))?.thread).toBeNull();

    await expect(call('post_message', { channel: '#ops', text: 'No ticket' })).rejects.toThrow(
      'Which ticket?',
    );
  });

  it('send_email is irreversible: one external effect, and draft_correction_email drafts a correction', async () => {
    await openTicket();
    const { out, rec } = await call('send_email', {
      to: 'cust_42',
      subject: 'Your order ord_1001 address has been updated',
      body: 'The delivery address is now 221B Baker Street.',
    });
    expect(rec.action).toMatchObject({
      reversible: false,
      inverseTool: null,
      mitigationTool: 'draft_correction_email',
    });
    expect(out.result).toMatchObject({ id: 'eml_1', toAddress: 'rahul.mehta@example.com' });
    expect(keys(out.reads)).toEqual(['customer:cust_42', 'order:ord_1001', 'ticket:tkt_1']);
    expect(out.writes).toEqual([
      expect.objectContaining({
        kind: 'external',
        entity: expect.objectContaining({ type: 'email', key: 'eml_1' }),
        before: null,
        after: expect.objectContaining({ status: 'sent', body: expect.stringContaining('tkt_1') }),
      }),
    ]);

    const fix = await call(
      'draft_correction_email',
      { actionId: rec.action.id },
      {
        kind: 'mitigation',
        undoes: rec.action.id,
      },
    );
    expect(keys(fix.out.reads)).toEqual(['email:eml_1']);
    expect(fix.out.result).toMatchObject({ id: 'eml_2', corrects: 'eml_1', status: 'draft' });
    expect(await getEntity(g, 'email', 'eml_2')).toMatchObject({
      to: 'cust_42',
      toAddress: 'rahul.mehta@example.com',
      subject: 'Correction: Your order ord_1001 address has been updated',
      status: 'draft',
    });
    // The sent email stays sent: it left the system.
    expect((await getEntity(g, 'email', 'eml_1'))?.status).toBe('sent');
    const notAnEmail = await call('lookup_order', { orderId: 'ord_1001' });
    await expect(
      call('draft_correction_email', { actionId: notAnEmail.rec.action.id }),
    ).rejects.toThrow('nothing to correct');
  });

  it('schedule_followup reads the ticket and creates evt_1; cancel_event removes it', async () => {
    await openTicket();
    const when = '2026-10-20T10:00:00+05:30';
    const { out, rec } = await call('schedule_followup', { ticketId: 'tkt_1', when });
    expect(out.result).toEqual({
      id: 'evt_1',
      ticketId: 'tkt_1',
      title: 'Follow up: Address correction for ord_1001',
      when,
    });
    expect(keys(out.reads)).toEqual(['ticket:tkt_1']);
    expect(out.writes).toEqual([
      expect.objectContaining({
        kind: 'create',
        after: expect.objectContaining({ id: 'evt_1', status: 'scheduled', when }),
      }),
    ]);

    await call(
      'cancel_event',
      { actionId: rec.action.id },
      {
        kind: 'undo',
        undoes: rec.action.id,
      },
    );
    expect(await getEntity(g, 'event', 'evt_1')).toBeNull();
    await expect(
      call('schedule_followup', { ticketId: 'tkt_1', when: 'tomorrow' }),
    ).rejects.toThrow();
  });
});
