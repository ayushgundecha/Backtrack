/**
 * Spike: prove every FalkorDB behaviour Backtrack relies on, against the local instance.
 * Run: pnpm spike   (graph bt:spike is created and dropped)
 * Findings are copied into docs/spike-results.md.
 */
import { closeDb, listGraphs, openTenant } from '../src/graph/client.js';

const log = (label: string, v: unknown) =>
  console.log(`\n== ${label}\n`, typeof v === 'string' ? v : JSON.stringify(v, null, 2));

const g = openTenant('spike');
await g.drop();

// 1. Index → unique constraint → OPERATIONAL
await g.ensureUnique('Action', 'id');
await g.ensureUnique('Entity', 'type', 'key');
await g.waitForConstraints();
log(
  'constraints',
  (
    await g.read(
      'CALL db.constraints() YIELD type, label, properties, status RETURN type, label, properties, status',
    )
  ).rows,
);

// 2. Counter + three actions + DEPENDS_ON with weight; params incl. JSON strings
await g.write(`MERGE (c:Counter {id:'seq'}) ON CREATE SET c.n = 0`);
for (const [id, tool, args] of [
  ['a1', 'update_address', JSON.stringify({ orderId: 'ord_1001' })],
  ['a2', 'create_ticket', JSON.stringify({ customerId: 'cust_42' })],
  ['a3', 'post_message', JSON.stringify({ channel: '#ops' })],
] as const) {
  await g.write(
    `MATCH (c:Counter {id:'seq'}) SET c.n = c.n + 1
     CREATE (a:Action {id: $id, tool: $tool, args: $args, seq: c.n, status: 'done', kind: 'do', reversible: true})
     RETURN a.seq AS seq`,
    { id, tool, args },
  );
}
await g.write(
  `MATCH (a2:Action {id:'a2'}), (a1:Action {id:'a1'}) CREATE (a2)-[:DEPENDS_ON {weight: 1, via: 'read'}]->(a1)`,
);
await g.write(
  `MATCH (a3:Action {id:'a3'}), (a2:Action {id:'a2'}) CREATE (a3)-[:DEPENDS_ON {weight: 1, via: 'read'}]->(a2)`,
);
log(
  'args round-trip (JSON string param)',
  (await g.read(`MATCH (a:Action {id:'a1'}) RETURN a.args AS args, a.seq AS seq`)).rows,
);

// 3. Q1 shape: downstream closure with paths.
// FINDING: a parameter is NOT accepted as a variable-length bound (`*1..$depth` → server error
// "Encountered unhandled type in inlined properties"). The depth must be a validated integer literal.
const depthLiteral = (d: number) => Math.min(10, Math.max(1, Math.trunc(d)));
const q1 = await g.read(
  `MATCH p = (root:Action {id: $id})<-[:DEPENDS_ON*1..${depthLiteral(5)}]-(d:Action)
   WHERE d.status = 'done'
   RETURN d.id AS id, d.tool AS tool, length(p) AS hops, [n IN nodes(p) | n.tool] AS via
   ORDER BY d.seq DESC`,
  { id: 'a1' },
);
log('Q1 downstream closure (literal depth + nodes(path))', q1);

// 3b. Does a depth of 1 hide a3? (the depth-1 vs depth-4 demo move)
const q1d1 = await g.read(
  `MATCH p = (root:Action {id: $id})<-[:DEPENDS_ON*1..${depthLiteral(1)}]-(d:Action) RETURN d.id AS id ORDER BY d.seq DESC`,
  { id: 'a1' },
);
log('Q1 at depth 1', q1d1.rows);

// 4. Algorithms
log(
  'algo.wcc',
  (
    await g.read(
      `CALL algo.wcc({nodeLabels: ['Action'], relationshipTypes: ['DEPENDS_ON']}) YIELD node, componentId RETURN node.id AS id, componentId`,
    )
  ).rows,
);
log(
  'algo.pageRank',
  (
    await g.read(
      `CALL algo.pageRank('Action', 'DEPENDS_ON') YIELD node, score RETURN node.id AS id, score ORDER BY score DESC`,
    )
  ).rows,
);
log(
  'algo.betweenness',
  (
    await g.read(
      `CALL algo.betweenness({nodeLabels: ['Action'], relationshipTypes: ['DEPENDS_ON']}) YIELD node, score RETURN node.id AS id, score ORDER BY score DESC`,
    )
  ).rows,
);
log(
  'algo.SPpaths a3 -> a1 (incoming over DEPENDS_ON, weight)',
  (
    await g.read(
      `MATCH (s:Action {id:'a3'}), (t:Action {id:'a1'})
       CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: ['DEPENDS_ON'], weightProp: 'weight', relDirection: 'outgoing', pathCount: 1})
       YIELD path, pathWeight
       RETURN [n IN nodes(path) | n.id] AS hops, pathWeight`,
    )
  ).rows,
);

// 5. Pattern predicate in WHERE (we avoid EXISTS {} subqueries)
log(
  'pattern predicate',
  (await g.read(`MATCH (a:Action) WHERE (a)-[:DEPENDS_ON]->(:Action {id:'a1'}) RETURN a.id AS id`))
    .rows,
);

// 6. Parallel-edge pitfall: bind and reference the relationship when counting
log(
  'bound relationship count',
  (
    await g.read(
      `MATCH (a:Action)-[e:DEPENDS_ON]->(b:Action) WHERE ID(e) >= 0 RETURN count(e) AS edges`,
    )
  ).rows,
);

// 7. GRAPH.COPY → list → delete fork
const forkG = await g.copyTo('spike:fork:1');
const graphs = await listGraphs();
log(
  `graphs after copy (${forkG.name})`,
  graphs.filter((n) => n.startsWith('bt:spike')),
);
log('fork has the same actions', (await forkG.read(`MATCH (a:Action) RETURN count(a) AS n`)).rows);
await forkG.drop();
log(
  'graphs after fork delete',
  (await listGraphs()).filter((n) => n.startsWith('bt:spike')),
);

// 8. Unique constraint actually enforced
try {
  await g.write(`CREATE (:Action {id:'a1', tool:'dup'})`);
  log('UNIQUE enforcement', 'FAILED: duplicate was accepted');
} catch (e) {
  log('UNIQUE enforcement', `OK, rejected: ${(e as Error).message}`);
}

// 9. Single-statement record pattern (BT-021). The recorder writes one action in one statement,
// so it relies on: FOREACH over range() with list-parameter indexing inside MERGE/CREATE; a
// sentinel UNWIND row so empty lists keep the statement alive; OPTIONAL MATCH on a null property
// (the sentinel) matching nothing; ORDER BY + head(collect()) for "latest writer"; FOREACH over a
// one-element node list for conditional MERGE of a relationship; CASE inside SET.
await g.write(
  `UNWIND range(1, 3) AS i
   CREATE (:Entity {type: 'ticket', key: 'tkt_' + toString(i), state: 'null'})`,
);
const rec = await g.write(
  `MATCH (c:Counter {id:'seq'}) SET c.n = c.n + 1
   WITH c.n AS seq
   CREATE (a:Action {id: $id, seq: seq, status: 'done', kind: 'do'})
   WITH a, seq
   FOREACH (i IN range(0, size($types) - 1) |
     MERGE (e:Entity {type: $types[i], key: $keys[i]})
     SET e.state = $states[i]
     CREATE (a)-[:CAUSED]->(:Effect {id: $id + '_' + toString(i)})-[:ON]->(e))
   WITH a, seq
   UNWIND range(0, size($depTypes)) AS i
   OPTIONAL MATCH (e:Entity {type: $depTypes[i], key: $depKeys[i]})<-[:ON]-(:Effect)<-[:CAUSED]-(w:Action)
   WHERE w.seq < seq AND w.status = 'done'
   WITH a, seq, i, w ORDER BY w.seq DESC
   WITH a, seq, i, head(collect(w)) AS latest
   WITH a, seq, latest, collect($depVia[i]) AS vias
   FOREACH (w IN CASE WHEN latest IS NULL THEN [] ELSE [latest] END |
     MERGE (a)-[d:DEPENDS_ON]->(w)
     SET d.weight = 1, d.via = CASE WHEN 'read' IN vias THEN 'read' ELSE 'write' END)
   WITH seq, collect(latest.id) AS deps
   RETURN seq, deps`,
  {
    id: 'a4',
    types: ['ticket', 'ticket'],
    keys: ['tkt_1', 'tkt_9'],
    states: ['{"a":1}', '{"b":2}'],
    depTypes: [],
    depKeys: [],
    depVia: [],
  },
);
log('record a4 (writes tkt_1 and new tkt_9; no deps; empty lists survive)', rec.rows);
const rec2 = await g.write(
  `MATCH (c:Counter {id:'seq'}) SET c.n = c.n + 1
   WITH c.n AS seq
   CREATE (a:Action {id: $id, seq: seq, status: 'done', kind: 'do'})
   WITH a, seq
   UNWIND range(0, size($depTypes)) AS i
   OPTIONAL MATCH (e:Entity {type: $depTypes[i], key: $depKeys[i]})<-[:ON]-(:Effect)<-[:CAUSED]-(w:Action)
   WHERE w.seq < seq AND w.status = 'done'
   WITH a, seq, i, w ORDER BY w.seq DESC
   WITH a, seq, i, head(collect(w)) AS latest
   WITH a, seq, latest, collect($depVia[i]) AS vias
   FOREACH (w IN CASE WHEN latest IS NULL THEN [] ELSE [latest] END |
     MERGE (a)-[d:DEPENDS_ON]->(w)
     SET d.weight = 1, d.via = CASE WHEN 'read' IN vias THEN 'read' ELSE 'write' END)
   WITH seq, collect(latest.id) AS deps
   RETURN seq, deps`,
  {
    id: 'a5',
    depTypes: ['ticket', 'ticket', 'ticket'],
    depKeys: ['tkt_1', 'tkt_9', 'tkt_2'],
    depVia: ['read', 'write', 'read'],
  },
);
log('record a5 (reads tkt_1, writes tkt_9 → one edge to a4, via read)', rec2.rows);
log(
  'a5 dependency edges',
  (
    await g.read(
      `MATCH (:Action {id:'a5'})-[d:DEPENDS_ON]->(w:Action) RETURN w.id AS writer, d.via AS via, d.weight AS weight`,
    )
  ).rows,
);
log(
  'tkt_9 created by MERGE inside FOREACH with indexed params',
  (await g.read(`MATCH (e:Entity {key:'tkt_9'}) RETURN e.state AS state`)).rows,
);

await g.drop();
await closeDb();
console.log('\nspike complete');
