import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/graph/bootstrap.js';
import { testGraph } from './helpers.js';

const g = testGraph();

const schema = async () => ({
  constraints: (
    await g.read<{ label: string; properties: string[]; status: string }>(
      'CALL db.constraints() YIELD label, properties, status RETURN label, properties, status ORDER BY label',
    )
  ).rows,
  indexes: (await g.read<{ n: number }>('CALL db.indexes() YIELD label RETURN count(label) AS n'))
    .rows[0]?.n,
  nodes: (await g.read<{ n: number }>('MATCH (n) RETURN count(n) AS n')).rows[0]?.n,
});

describe('bootstrap', () => {
  beforeAll(async () => {
    await g.drop();
  });

  it('creates unique constraints that become OPERATIONAL, the counter, actors and Meta', async () => {
    expect(await bootstrap(g)).toEqual({ created: true });
    const { constraints } = await schema();
    expect(constraints.map((c) => `${c.label}(${c.properties.join(',')})`)).toEqual([
      'Action(id)',
      'Entity(type,key)',
      'Policy(id)',
      'Run(id)',
      'UndoPlan(id)',
    ]);
    expect(constraints.every((c) => c.status === 'OPERATIONAL')).toBe(true);
    const { rows } = await g.read<{ n: number; agents: string[]; user: string; done: boolean }>(
      `MATCH (c:Counter {id: 'seq'}), (m:Meta {id: 'meta'}), (u:User)
       MATCH (a:Agent)
       RETURN c.n AS n, collect(a.id) AS agents, u.id AS user, m.bootstrapped AS done`,
    );
    expect(rows[0]?.n).toBe(0);
    expect(rows[0]?.agents.sort()).toEqual(['backtrack', 'billing-agent', 'ops-agent']);
    expect(rows[0]?.user).toBe('ayush');
    expect(rows[0]?.done).toBe(true);
  });

  it('is a no-op the second time', async () => {
    const before = await schema();
    expect(await bootstrap(g)).toEqual({ created: false });
    expect(await schema()).toEqual(before);
  });
});
