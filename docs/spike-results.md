# FalkorDB spike results

Run with `pnpm spike` (creates and drops graph `bt:spike`). Verified on `falkordb/falkordb:latest` (Oct 18, 2026) with the `falkordb@6.8.0` Node client. Anything the product relies on is proven here first; add a check before relying on new behaviour.

| Behaviour | Result | Consequence for the code |
|---|---|---|
| `CREATE INDEX` then `GRAPH.CONSTRAINT CREATE … UNIQUE` | OPERATIONAL within ~100 ms; duplicate insert rejected with `unique constraint violation on node of type Action` | `ensureUnique()` creates the index first, then the constraint, then `waitForConstraints()` polls `CALL db.constraints()` |
| JSON string as a parameter | round-trips unchanged | `args`, `state`, `before`, `after` are stored as JSON strings and parsed on read; never pass nested maps as params |
| Variable-length bound from a parameter (`*1..$depth`) | **server error** `Encountered unhandled type in inlined properties` | depth is clamped to 1..10 and interpolated as an integer literal; every other value stays a parameter |
| `MATCH p = …<-[:DEPENDS_ON*1..5]-… RETURN length(p), [n IN nodes(p) \| n.tool]` | returns hops and the route; depth 1 hides the second hop | Q1 returns `hops` and `via`; the depth slider re-runs Q1 |
| `algo.wcc({nodeLabels, relationshipTypes}) YIELD node, componentId` | works | Q10 independent clusters |
| `algo.pageRank('Action','DEPENDS_ON') YIELD node, score` | works, positional string args | Q8 load-bearing actions |
| `algo.betweenness({nodeLabels, relationshipTypes}) YIELD node, score` | works; a2 (the middle) scores 1 | Q9 hinge actions |
| `algo.betweenness` repeated on the 9-action golden graph | **sampled by default**: the same graph scored post_message/create_ticket 8/4 on 18 of 25 runs and 10/5 on 7, and in a full test run the two swapped places once; with `samplingSize: 10000, samplingSeed: 7` all 25 runs gave 12/6 | Q9 passes an explicit sample size and seed so the hinge ranking is repeatable |
| `algo.SPpaths({sourceNode, targetNode, relTypes, weightProp, relDirection, pathCount}) YIELD path, pathWeight` | works; `weightProp` is required so every `DEPENDS_ON` carries `weight: 1` | Q11 path between two actions |
| Pattern predicate in `WHERE (a)-[:DEPENDS_ON]->(:Action {id:…})` | works | Q5 uses pattern predicates; `EXISTS {}` is not used |
| Counting relationships | bind and reference the relationship (`WHERE ID(e) >= 0`) | all counting queries bind their relationships |
| `GRAPH.COPY` via `graph.copy(dest)`, then `GRAPH.DELETE` of the fork | copy contains the same nodes; delete removes it; source untouched | undo rehearsal runs on `bt:<tenant>:fork:<planId>` and deletes it afterwards |
| `graph.roQuery` for reads | works | every agent-facing read uses `read()` (RO_QUERY) |
| Single-statement record (`FOREACH (i IN range(0, size($l)-1) \| MERGE (e {type: $t[i]}) …)`, sentinel `UNWIND range(0, size($l))`, `OPTIONAL MATCH` on a null property, `ORDER BY` + `head(collect(w))`, `FOREACH (w IN CASE WHEN x IS NULL THEN [] ELSE [x] END \| MERGE …)`) | all work; empty lists keep the row alive; the null sentinel matches nothing; one edge per writer | the recorder writes Action, Effects, Entity state, READ and DEPENDS_ON in one statement (BT-021) |
| `algo.SPpaths({…, relDirection: 'incoming', maxLen: 10})` from a root to a dependent | returns the route root → … → dependent; `outgoing` in that direction returns nothing | Q11 `path_between(from: root, to: dependent)` uses `incoming`, so the path reads in the same order as Q1's `via` |
