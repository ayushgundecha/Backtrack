# Changelog

One line per completed task, newest first. Format: `BT-0xx — what changed (how it was verified)`.

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
