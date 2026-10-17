# Changelog

One line per completed task, newest first. Format: `BT-0xx — what changed (how it was verified)`.

- BT-024 — sdk/gate.ts: policies (Q5) then lock-in (Q4) decide approve / ask / deny with a row-built reason; approvals are User edges; sdk/run.ts gates and records every tool call (`pnpm test`: gate.test.ts, run.test.ts)
- BT-023 — executeUndo: an undo Run per plan, Q14 conflict check, restore or mitigation, UNDOES/REVERTS/COULD_NOT_REVERT/CONFLICT, idempotent re-run (`pnpm test`: undo.test.ts)
- BT-022 — planUndo returns the four outcomes (plan, memory, none, unknown) from Q1/Q2/Q3/Q7 and persists the plan (`pnpm test`: undo.test.ts on the golden graph)
- BT-013 — Q1–Q7 and Q12–Q14 as typed, named queries; `pnpm gen:queries` writes graph/queries.cypher (`pnpm test`: queries.test.ts on the golden demo graph, plus a staleness check on the generated file)
- BT-021 — sdk/recorder.ts records each action in one Cypher statement with DEPENDS_ON to the latest earlier writer; pending actions commit after approval (`pnpm test`: recorder.test.ts, 8 cases on bt:test)
- BT-020 — sdk/registry.ts: defineTool with mutually exclusive reversible/irreversible classes, ToolRegistry, conversion to ai@7 tools (`pnpm test`: registry.test.ts; tsc checks the types)
- BT-012 — world/seed.ts seeds 10 customers and 20 orders with fixed ids; world/store.ts reads state, folds Effects for as-of snapshots, applies effects (`pnpm test`: world.test.ts)
- BT-011 — graph/bootstrap.ts: idempotent indexes → UNIQUE constraints (polled to OPERATIONAL) → secondary indexes → Counter, agents, user, Meta; queries.ts holds every statement (`pnpm test`: bootstrap.test.ts runs it twice)
- BT-066 — docs/judge-qa.md: the ten judge questions with pointers and blanks for Ayush's answers (proofread against PLAN §9)
- BT-063 — docs/demo-script.md: timed 2:45 shot list with voice-over draft and a pre-flight checklist (proofread against PLAN §9)
- BT-061 — graph/model.md (Mermaid ER of every label and edge, invariants) and docs/why-a-graph.md (depth 1 vs 3 argument) (Mermaid parsed with mermaid 11)
- BT-060 — README v1 with every PLAN §9 section, coverage and guide tables, marked placeholders (reviewed against PLAN and the engine design)
- BT-010 — graph client pings idle connections, reconnects after a closed client; cypher.ts adds the depth-only tag, canonical JSON and toParams (`pnpm test`: client.test.ts, cypher.test.ts against bt:test)
- BT-050 — CI runs lint, typecheck and test against a FalkorDB service container (green on main 9e00483)
- BT-004 — FalkorDB spike proving constraints, params, traversal, algorithms, copy (`pnpm spike`; see docs/spike-results.md)
- BT-003 — Frozen contracts (types, events, api, fixtures) and golden fixtures (`pnpm test`)
- BT-002 — docker compose for FalkorDB + Browser (`pnpm db:up`)
- BT-001 — Repository scaffold: pnpm workspace, strict TS, Biome, Vitest, CI, MIT (`pnpm lint && pnpm typecheck && pnpm test`)
