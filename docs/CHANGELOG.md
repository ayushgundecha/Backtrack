# Changelog

One line per completed task, newest first. Format: `BT-0xx — what changed (how it was verified)`.

- BT-050 — CI runs lint, typecheck and test against a FalkorDB service container (green on main 9e00483)
- BT-004 — FalkorDB spike proving constraints, params, traversal, algorithms, copy (`pnpm spike`; see docs/spike-results.md)
- BT-003 — Frozen contracts (types, events, api, fixtures) and golden fixtures (`pnpm test`)
- BT-002 — docker compose for FalkorDB + Browser (`pnpm db:up`)
- BT-001 — Repository scaffold: pnpm workspace, strict TS, Biome, Vitest, CI, MIT (`pnpm lint && pnpm typecheck && pnpm test`)
