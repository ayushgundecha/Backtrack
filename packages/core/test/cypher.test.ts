import { describe, expect, it } from 'vitest';
import { cypher, depth, parseJson, stableStringify, toParams } from '../src/graph/cypher.js';

describe('cypher helpers', () => {
  it('clamps depth into 1..10 and truncates fractions', () => {
    expect(depth(0).value).toBe(1);
    expect(depth(3.9).value).toBe(3);
    expect(depth(99).value).toBe(10);
    expect(depth(Number.NaN).value).toBe(1);
  });

  it('interpolates only depth literals', () => {
    expect(cypher`MATCH p = (a)<-[:DEPENDS_ON*1..${depth(4)}]-(b) RETURN p`).toBe(
      'MATCH p = (a)<-[:DEPENDS_ON*1..4]-(b) RETURN p',
    );
    const injected = '1]-() DETACH DELETE (a) //' as unknown as ReturnType<typeof depth>;
    expect(() => cypher`MATCH (a)-[*1..${injected}]-() RETURN a`).toThrow(TypeError);
  });

  it('stableStringify sorts keys at every level and drops undefined', () => {
    const a = stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } });
    const b = stableStringify({ a: { d: [{ y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('toParams keeps primitives, stringifies nested values, maps undefined to null', () => {
    const params = toParams({
      id: 'act_1',
      seq: 3,
      ok: true,
      tags: ['a', 'b'],
      args: { orderId: 'ord_1001', nested: { x: 1 } },
      list: [{ k: 1 }],
      missing: undefined,
    });
    expect(params).toEqual({
      id: 'act_1',
      seq: 3,
      ok: true,
      tags: ['a', 'b'],
      args: '{"nested":{"x":1},"orderId":"ord_1001"}',
      list: '[{"k":1}]',
      missing: null,
    });
  });

  it('parseJson passes null through and parses strings', () => {
    expect(parseJson(null)).toBeNull();
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('null')).toBeNull();
  });
});
