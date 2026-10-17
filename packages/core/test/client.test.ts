import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, openTenant, PING_AFTER_IDLE_MS } from '../src/graph/client.js';
import { toParams } from '../src/graph/cypher.js';

const g = openTenant('test');

beforeEach(async () => {
  await g.drop();
});
afterAll(async () => {
  await g.drop();
  await closeDb();
});

describe('graph client', () => {
  it('round-trips nested values passed as JSON-string parameters', async () => {
    const args = { orderId: 'ord_1001', address: '221B Baker Street', lines: [{ n: 1 }] };
    await g.write('CREATE (:Action {id: $id, args: $args})', toParams({ id: 'act_1', args }));
    const { rows, cypher, params, ms } = await g.read<{ args: string }>(
      'MATCH (a:Action {id: $id}) RETURN a.args AS args',
      { id: 'act_1' },
    );
    expect(JSON.parse(rows[0]?.args ?? 'null')).toEqual(args);
    // Evidence travels with every result so the UI can show it.
    expect(cypher).toContain('MATCH (a:Action');
    expect(params).toEqual({ id: 'act_1' });
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('read() goes through GRAPH.RO_QUERY, so the server refuses writes', async () => {
    await expect(g.read("CREATE (:Action {id: 'nope'})")).rejects.toThrow();
    const { rows } = await g.write<{ n: number }>('MATCH (a:Action) RETURN count(a) AS n');
    expect(rows[0]?.n).toBe(0);
  });

  it('reuses one client across calls', async () => {
    const a = await getDb();
    await g.write('RETURN 1');
    const b = await getDb();
    expect(b).toBe(a);
  });

  it('reconnects when the cached client was closed underneath it', async () => {
    const before = await getDb();
    await before.close(); // simulate a dropped connection the cache does not know about
    const { rows } = await g.write<{ x: number }>('RETURN 1 AS x');
    expect(rows[0]?.x).toBe(1);
    expect(await getDb()).not.toBe(before);
  });

  it('pings an idle client and replaces it when the ping fails', async () => {
    const before = await getDb();
    await before.close();
    const cache = (globalThis as unknown as { __backtrackFalkor: { lastOkAt: number } })
      .__backtrackFalkor;
    cache.lastOkAt = Date.now() - PING_AFTER_IDLE_MS - 1; // pretend it has been idle
    const after = await getDb();
    expect(after).not.toBe(before);
    expect(await (await after.connection).ping()).toBe('PONG');
  });
});
