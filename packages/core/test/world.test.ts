import { beforeAll, describe, expect, it } from 'vitest';
import { stableStringify } from '../src/graph/cypher.js';
import { loadSeed } from '../src/world/seed.js';
import {
  applyEffect,
  getEntity,
  listByType,
  nextKey,
  setEntity,
  worldSnapshot,
} from '../src/world/store.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();

describe('world seed and store', () => {
  beforeAll(async () => {
    await fresh(g);
  });

  it('seeds 10 customers and 20 orders with fixed ids and canonical JSON state', async () => {
    expect(await listByType(g, 'customer')).toHaveLength(10);
    expect(await listByType(g, 'order')).toHaveLength(20);
    const order = await getEntity(g, 'order', 'ord_1001');
    expect(order?.address).toBe(loadSeed().orders[0]?.address);
    expect(order?.customerId).toBe('cust_42');
    const { rows } = await g.read<{ state: string; display: string }>(
      "MATCH (e:Entity {type: 'order', key: 'ord_1001'}) RETURN e.state AS state, e.display AS display",
    );
    expect(rows[0]?.state).toBe(stableStringify(order));
    expect(rows[0]?.display).toBe('order ord_1001');
  });

  it('round-trips setEntity/getEntity, and null means deleted', async () => {
    const order = await getEntity(g, 'order', 'ord_1002');
    if (!order) throw new Error('seed missing ord_1002');
    await setEntity(g, { type: 'order', key: 'ord_1002' }, { ...order, status: 'delivered' });
    expect((await getEntity(g, 'order', 'ord_1002'))?.status).toBe('delivered');
    await setEntity(g, { type: 'ticket', key: 'tkt_99' }, null);
    expect(await getEntity(g, 'ticket', 'tkt_99')).toBeNull();
    const world = await worldSnapshot(g);
    expect(world.entities.some((e) => e.key === 'tkt_99')).toBe(false);
  });

  it('gives created entities readable, increasing keys', async () => {
    expect(await nextKey(g, 'message')).toBe('msg_1');
    await setEntity(g, { type: 'message', key: 'msg_1' }, { id: 'msg_1' });
    expect(await nextKey(g, 'message')).toBe('msg_2');
  });

  it('applies effects: field update, whole-state create, delete', () => {
    const base = { id: 'ord_1', address: 'old' };
    expect(
      applyEffect(base, {
        kind: 'update',
        entity: { type: 'order', key: 'ord_1' },
        field: 'address',
        before: 'old',
        after: 'new',
      }),
    ).toEqual({ id: 'ord_1', address: 'new' });
    expect(
      applyEffect(null, {
        kind: 'create',
        entity: { type: 'ticket', key: 'tkt_1' },
        field: null,
        before: null,
        after: { id: 'tkt_1' },
      }),
    ).toEqual({ id: 'tkt_1' });
    expect(
      applyEffect(base, {
        kind: 'delete',
        entity: { type: 'order', key: 'ord_1' },
        field: null,
        before: base,
        after: null,
      }),
    ).toBeNull();
  });
});
