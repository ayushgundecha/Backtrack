# Judge Q&A

The ten questions from `docs/PLAN.md` §9 that judges are likely to ask. **The answers are Ayush's, in his own words.** Under each question are pointers to the files, queries and facts that back an answer; they are reminders, not the answer.

Queries are referred to by their number and name from `docs/PLAN.md` §5 (text in `graph/queries.cypher`, generated from `packages/core/src/graph/queries.ts`).

---

## 1. Why not a log?

Pointers:
- `docs/why-a-graph.md`: undo order, blast radius, cross-agent cascade, gate, conflict and explanation are all reachability over `DEPENDS_ON`; the recursive-SQL comparison.
- Q1 downstream closure (`DEPENDS_ON*1..N`, `length(p)`, `nodes(p)`) and the depth-1 vs depth-3 demo: `apply_credit` appears at hop 3 with its path.
- `GRAPH.COPY` rehearsal (Q15 rehearsal diff) and graph-per-tenant; algorithms Q8–Q11 as agent tools.
- `docs/spike-results.md`: what was proven on FalkorDB.

**Answer (Ayush):**

> _To be written by Ayush._

---

## 2. Why derive dependencies from reads and writes?

Pointers:
- Invariant 4 (`graph/model.md`): reads and writes come from the tool implementation, never from model arguments; `AGENTS.md` rules 1 and 2.
- `ToolResult` in `packages/core/src/contracts/types.ts`: every tool returns `{ result, reads, writes }`.
- DEPENDS_ON derivation (`graph/model.md`): latest prior `done` writer per entity, `via: 'read' | 'write'`, one statement per action (`packages/core/src/sdk/recorder.ts`, BT-021 tests: read-after-write, write-after-write, latest-only, cross-run).
- The cross-agent case: the billing agent never referenced the ops agent, yet `apply_credit` depends on `post_message` because it read the ticket.

**Answer (Ayush):**

> _To be written by Ayush._

---

## 3. Why is `seq DESC` a topological order?

Pointers:
- Invariant 1: `DEPENDS_ON` always points to a strictly smaller `seq`, so the edges cannot form a cycle and reverse `seq` respects every edge.
- `Counter {id: 'seq'}` is bumped inside the single record statement, so `seq` is monotonic per tenant graph (BT-021 test: `seq` monotonic).
- Q2 undo plan orders the Q1 closure by `seq DESC`; the golden plan: revoke_credit, cancel_event, draft_correction_email, delete_message, close_ticket, restore_address.

**Answer (Ayush):**

> _To be written by Ayush._

---

## 4. What if a human edited the data between the run and the undo?

Pointers:
- Q14 conflict check: before each step, compare the entity's current `state` with the Effect's `after`.
- On mismatch: the step is skipped, `(UndoPlan)-[:CONFLICT {reason}]->(Action)` is written, the plan ends `partial` (or `conflict`); `undo.step` event with status `conflict`.
- Invariant 2: undo is a restore of `before`; together with Q14 it never overwrites a value someone else set since.
- `docs/PLAN.md` §12: manual `SET` between run and undo yields `partial` with a CONFLICT edge; BT-023 test "conflict → partial".

**Answer (Ayush):**

> _To be written by Ayush._

---

## 5. What cannot be undone?

Pointers:
- `send_email` is irreversible (external effect); the plan records `(UndoPlan)-[:COULD_NOT_REVERT {mitigation}]->(Action)` and runs `draft_correction_email` (an email with status `draft`).
- The gate exists for exactly this: Q5 policy check then Q4 gate lock-in, before the irreversible call ("would lock in 3 reversible changes: update_address, create_ticket, post_message").
- Read-only actions have nothing to revert (not plan steps). Undo and mitigation actions cannot themselves be undone (invariant 3).
- Anything that did not go through a Backtrack tool is invisible until Q14 notices it.

**Answer (Ayush):**

> _To be written by Ayush._

---

## 6. Why one graph per tenant?

Pointers:
- Invariant 6 and `AGENTS.md` rule 7: tenant is a graph (`bt:<tenant>`), never a `WHERE` filter; `graphName()` in `packages/core/src/graph/client.ts`.
- `DEPENDS_ON` derivation cannot cross tenants; there is no tenant predicate to forget.
- Fork and delete are one command each (`GRAPH.COPY` for rehearsal, `GRAPH.DELETE` for the fork and for reset).
- `bt:demo`, `bt:test`, `bt:acme` (isolation demo via `--tenant acme` on the CLIs; the panel's tenant switcher was cut).

**Answer (Ayush):**

> _To be written by Ayush._

---

## 7. Why does the model never write Cypher?

Pointers:
- `AGENTS.md` rule 1: fixed tool catalogue, parameterized queries only; every query is a named function with an `answers:` comment and a test.
- `resolve_action` validates ids against the graph before any plan; unknown id → the "unknown action" outcome with three candidates (BT-033).
- `validateSummary()` (`packages/core/src/sdk/validate.ts`): the model's sentence is checked against result rows, with a row-built fallback.
- Flat tool schemas (primitives, enums, optionals) for free models; the same definitions serve the undo agent and the MCP server.

**Answer (Ayush):**

> _To be written by Ayush._

---

## 8. Why not field-level dependencies?

Pointers:
- `docs/later.md`: `DEPENDS_ON {field}` needs per-tool field maps; entity-level is explainable and sufficient for the demo.
- `Effect.field` is already recorded, so the data for a field-level version exists.
- Entity-level is conservative: it can add a step that did not strictly need reverting, never hide one that did; the user sees every step before confirming.
- README "Limitations and future work".

**Answer (Ayush):**

> _To be written by Ayush._

---

## 9. Why a graph gate instead of "ask before every email"?

Pointers:
- `packages/core/src/sdk/gate.ts`: Q5 policy check then Q4 gate lock-in; returns `approved`, `user-approval` or `denied` (`GateDecision` in `types.ts`).
- The reason is built from Q4 rows ("would lock in 3 reversible changes: …"), so the prompt says what is at stake, not just that a tool is risky.
- Approve and deny are recorded as `(User)-[:APPROVED {ts, reason}]` / `[:DENIED]` edges; policies (`Policy`, `BLOCKED`) make "never again" a graph fact.
- Same approval function in live LLM mode (AI SDK `toolApproval`) and replay (`approval.requested` → `/api/approval`).

**Answer (Ayush):**

> _To be written by Ayush._

---

## 10. What breaks at 10k actions?

Pointers:
- Bootstrap indexes: unique `Action.id`, `Run.id`, `UndoPlan.id`, `Entity(type, key)`; plain indexes `Action.seq`, `Action.tool`, `Action.status`, `Entity.type` (`docs/PLAN.md` §4, `packages/core/src/graph/bootstrap.ts`).
- Depth bound: clamped to 1–10 and written as an integer literal (`docs/spike-results.md`); the UI slider is 1–5.
- Invariant 5: only the latest prior writer per entity is linked, so fan-in per action stays small.
- What is not bounded: whole-graph algorithms (Q8–Q10) and the graph snapshot sent to the UI. No load test has been run; do not quote numbers that were not measured.

**Answer (Ayush):**

> _To be written by Ayush._
