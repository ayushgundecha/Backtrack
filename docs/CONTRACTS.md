# Contracts

The single source of truth is code: `packages/core/src/contracts/`. This page is the map.

| File | What it defines |
|---|---|
| `types.ts` | `EntityRef`, `EffectDraft`/`EffectRecord`, `ToolResult` (what every tool returns: result + reads + writes), `ActionRecord`, `UndoStep`/`UndoPlan`/`UndoOutcome` (the four outcomes), `BlastRadius`, `GateDecision`, `Policy`, `QueryResult`/`Trace` (every read carries its Cypher), `GraphSnapshot`, `WorldSnapshot`, `Explain` |
| `events.ts` | `RunEvent`: the SSE stream emitted by both replay and LLM runs and by undo execution |
| `api.ts` | Every HTTP route of `apps/web` with request and response schemas |
| `fixtures.ts` | `WorldSeed` and `RunFixture` (golden runs; `{ "$ref": "steps.N.result.path" }` references earlier results) |

## Rules
- Changing a contract is a design decision: open a `decision` issue in the tracker, explain the why, update dependants in the same change.
- Nested JSON is stored in the graph as a string (`args`, `state`, `before`, `after`) and parsed at the edge.
- Variable-length depth is an integer literal in the query text (see `docs/spike-results.md`); everything else is a parameter.
- Reads and writes of an action come from the tool implementation, never from model-supplied arguments.

## Routes (see `api.ts` for schemas)
`GET /api/graph` · `GET /api/world?asOfSeq=` · `GET /api/actions` · `GET /api/explain?actionId=` · `POST /api/reset` · `POST /api/agent` (SSE) · `POST /api/approval` · `POST /api/undo` · `POST /api/undo/execute` (SSE) · `POST /api/rehearse` · `GET /api/plan?planId=` · `POST /api/policy` · `GET /api/algo?name=`

## Events (see `events.ts`)
`run.started` → `step` → `action.recorded` … `approval.requested` → `approval.resolved` … `run.finished`; undo: `undo.step` × n → `undo.finished`; `action.blocked`; `error`.
