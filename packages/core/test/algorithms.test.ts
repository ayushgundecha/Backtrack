import { beforeAll, describe, expect, it } from 'vitest';
import { q8LoadBearing, q9Hinges, q10Clusters, q11PathBetween } from '../src/graph/queries.js';
import { buildGolden } from './golden.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
let id: Record<string, string>;

describe('algorithm queries on the golden demo graph', () => {
  beforeAll(async () => {
    await fresh(g);
    id = await buildGolden(g);
  });

  it('Q8 PageRank: everything rests on update_address, then the ticket chain', async () => {
    const { rows } = await q8LoadBearing(g, { limit: 3 });
    expect(rows.map((r) => r.tool)).toEqual(['update_address', 'create_ticket', 'post_message']);
    expect(rows[0]).toMatchObject({ agentId: 'ops-agent', status: 'done' });
    expect(rows.every((r) => typeof r.score === 'number' && r.score > 0)).toBe(true);
    expect(rows[0]?.score).toBeGreaterThanOrEqual(rows[1]?.score ?? 0);
  });

  it('Q9 betweenness: post_message is the hinge between the ops chain and everything after it', async () => {
    const { rows } = await q9Hinges(g, { limit: 9 });
    expect(rows.slice(0, 2).map((r) => r.tool)).toEqual(['post_message', 'create_ticket']);
    expect(rows[0]?.score).toBeGreaterThan(rows[1]?.score ?? 0);
    // Leaves sit on no path between other actions.
    expect(rows.find((r) => r.tool === 'apply_credit')?.score).toBe(0);
  });

  it('Q10 WCC: the eight connected actions form one cluster, the seed-only lookup is alone', async () => {
    const { rows } = await q10Clusters(g, {});
    expect(rows.map((r) => r.size)).toEqual([8, 1]);
    expect(rows[1]?.actions.map((a) => a.tool)).toEqual(['lookup_order']);
    expect(rows[0]?.actions[0]?.tool).toBe('update_address');
  });

  it('Q11 SPpaths: the route from update_address to the billing credit, weighted', async () => {
    const { rows } = await q11PathBetween(g, {
      from: id.update_address as string,
      to: id.apply_credit as string,
    });
    expect(rows[0]).toEqual({
      ids: [id.update_address, id.create_ticket, id.post_message, id.apply_credit],
      tools: ['update_address', 'create_ticket', 'post_message', 'apply_credit'],
      pathWeight: 3,
    });
    const none = await q11PathBetween(g, {
      from: id.apply_credit as string,
      to: id.lookup_order as string,
    });
    expect(none.rows).toEqual([]);
  });
});
