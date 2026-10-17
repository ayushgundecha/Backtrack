# Backtrack — engineering plan

The working plan for the hackathon build: product thesis, graph model, query catalogue, tool catalogues, architecture and UI spec, standards, work breakdown, risks and verification. Contracts live in code (`packages/core/src/contracts`); proven FalkorDB behaviour lives in `docs/spike-results.md`.

---

## 1. The product and why it wins

**One line:** Backtrack — the undo button for AI agents.

**The scene the user lives:** an ops agent fixes a customer's order in six steps. The graph grows as it works. Before sending an email the agent pauses itself: "this would lock in 3 reversible changes" (a graph query decided that, not a hand-written rule). The address it chose was wrong. ⌘Z, "undo the address change". A plan card: four steps in reverse dependency order, one irreversible (the email) with a mitigation. Drag depth 1→3 and a billing agent's credit appears, with its path. Rehearse on a forked graph, see the diff, confirm. The world reverts item by item on screen. Click anything: why it happened, what it read, who wrote that, the exact Cypher.

**Uniqueness (verified Oct 2026):** LangGraph time travel, Claude Code rewind, AgentRewind (arXiv Aug 2026) and Rubrik Agent Rewind all restore *state* (files, context, snapshots). Restate/Temporal sagas compensate *linearly on failure inside one workflow*. Nobody offers human-chosen undo of an arbitrary past action with transitive, cross-agent dependents derived from data reads/writes, with blast radius, gating and rehearsal. Problem urgency: Replit (Jul 2025) and PocketOS (Apr 2026) incidents, both "no confirmation step, no clean rollback".

**Why FalkorDB is not decoration:** undo order, blast radius, cross-agent cascade, gate, conflict detection and explanation are all reachability questions over `DEPENDS_ON`. `GRAPH.COPY` makes rehearsal a one-liner. Graph-per-tenant makes isolation structural. Native algorithms (PageRank, betweenness, WCC, SPpaths) are exposed as agent tools.

**Grounding to cite in README:** W3C PROV (activity/entity/agent, used/generated/derivedFrom) and the Saga pattern.

---

## 2. Alignment with the official WeMakeDevs guide (judging signals)

| Guide says | Backtrack does |
|---|---|
| Graph must do work no other store could; graph-as-KV "reads immediately as weak" | Every headline feature is a traversal; the README has the "why not a log" argument |
| Demo move: same question at depth 1 then depth 4, a distant dependency appears with its path | Depth slider on the blast-radius chip, live Q1 re-query; billing credit appears at depth 3 |
| Fixed tool catalogue; the model never writes Cypher; args validated against the graph | Both agents use fixed tools; `resolve_action` validates before any plan |
| Four honest outcomes: with path / from memory / not in graph / unknown entity | Undo console returns exactly these four as distinct cards |
| Return the path with the answer (`nodes(path)`) | Q1/Q2 return hops and via; explain drawer renders rows |
| Validate the model's sentence against result rows; fall back to a row-built sentence | `validateSummary()` |
| Memory is more nodes; read before acting; return dates | UndoPlan/Policy nodes; `recall` (Q13) with dates; ops agent calls it before modifying |
| Trace per tool call: tool, args, ms, rows | Trace strip on every call |
| Direction and parallel-edge pitfalls; tenant = graph not WHERE | Per-query review; `bt:<tenant>`; tenant switcher |

---

## 3. Scope (P0 ships or there is no submission)

**P0 — the demo scene end to end (replay mode):** scaffold, contracts, spike, graph client + bootstrap, world in graph, recorder with `DEPENDS_ON`, six ops tools, replay engine, undo engine (Q1–Q3, Q6, Q14), gate (Q4) with approval, billing agent + Q7 cascade, full web panel per §7, engine tests, CI, README.

**P1 — what wins:** live LLM mode via OpenRouter with budget guard, Vercel + FalkorDB Cloud deploy, time scrubber, rehearsal fork (Q15), policies "never again" (Q5), `recall` memory tool (Q13), stdio MCP server, algorithm tools (Q8–Q11) with UI buttons, explain drawer polish, demo GIF, video, blog.

**P2 — if lanes are idle:** tenant switcher, MCP client inside the local undo agent, mock-model replay through `ToolLoopAgent`, "Run both agents" concurrency button, Playwright E2E, policy suggestions.

**CUT:** MCP over HTTP self-call, vector "undo by description", real external integrations, field-level dependencies (README future work).

**Freeze 18:00 IST Sunday** for code; after that only docs, video, submission.

---

## 4. Graph model (frozen contract)

Graph per tenant `bt:<tenant>` (`bt:demo` default, `bt:test` for tests, `bt:acme` for isolation demo).

| Label | Properties |
|---|---|
| `Agent` | `id, name, version` |
| `User` | `id, name` (human; default `ayush`) |
| `Run` | `id, kind(agent\|undo), agent_id, status(running\|paused\|done\|failed\|undone), goal, started_at, ended_at, messages(json string), pending_action_id, model` |
| `Step` | `id, index, thought, ts` |
| `Action` | `id, seq(int), tool, args(json), result(json), ts, kind(do\|undo\|mitigation), reversible(bool), inverse_tool, mitigation_tool, status(pending\|done\|undone\|blocked\|denied)` |
| `Effect` | `id, kind(create\|update\|delete\|external), field, before(json\|null), after(json), ts` |
| `Entity` | `type, key, display, state(json string)` |
| `UndoPlan` | `id, root_action_id, ts, status(proposed\|rehearsed\|executed\|partial\|conflict), summary, depth` |
| `Policy` | `id, rule, kind(block\|confirm\|warn), tool, created_from_plan_id, ts` |
| `Counter` | `id:'seq', n` |
| `Meta` | `bootstrapped, seeded_at, llm_calls_day, llm_calls_count` |

Edges: `(Agent)-[:RAN]->(Run)`, `(Run)-[:HAS]->(Step)`, `(Step)-[:NEXT]->(Step)`, `(Step)-[:DID]->(Action)`, `(Action)-[:CAUSED]->(Effect)-[:ON]->(Entity)`, `(Action)-[:READ]->(Entity)`, `(Action)-[:DEPENDS_ON {weight:1, via:'read'|'write'}]->(Action)`, `(Action)-[:UNDOES]->(Action)`, `(UndoPlan)-[:ROOT]->(Action)`, `(UndoPlan)-[:REVERTS {order}]->(Action)`, `(UndoPlan)-[:COULD_NOT_REVERT {mitigation}]->(Action)`, `(UndoPlan)-[:CONFLICT {reason}]->(Action)`, `(User)-[:APPROVED {ts,reason}|:DENIED]->(Action)`, `(User)-[:REQUESTED]->(UndoPlan)`, `(User)-[:SET]->(Policy)`, `(Policy)-[:ON_TOOL]->(Agent)`, `(Policy)-[:APPLIES_TO]->(Entity)`, `(Policy)-[:BLOCKED]->(Action)`.

**Invariants (README):** (1) `DEPENDS_ON` points to a strictly smaller `seq`, so `seq DESC` over the dependent set is a reverse topological order. (2) Every Effect has `before`/`after`, so undo is a restore: idempotent, correct under write-after-write. (3) Traversals exclude `status='undone'` and `kind<>'do'`: undo-the-undo is impossible. (4) Reads/writes come from what the tool implementation touched, never from LLM args. (5) `DEPENDS_ON` links only to the latest prior `done` writer per entity (transitivity covers the rest). (6) Tenant is a graph, not a filter.

**Bootstrap** (idempotent, gated on `Meta`, triggered by `/api/reset`, never on import): indexes on `Action.id`, `Run.id`, `UndoPlan.id`, `Entity(type,key)` → `constraintCreate(UNIQUE, NODE, …)` each → poll `CALL db.constraints()` until OPERATIONAL → indexes `Action.seq`, `Action.tool`, `Action.status`, `Entity.type` → `MERGE (:Counter {id:'seq'}) ON CREATE SET n=0` → seed.

**Record path:** one Cypher statement per action (no multi-statement transactions): bump counter, CREATE Step/Action/Effects, MERGE Entities + SET state, READ edges, DEPENDS_ON derivation. Return scalars only. Params: stringify nested JSON.

**Verified FalkorDB facts (do not re-research; extend the spike instead):** `algo.betweenness({nodeLabels, relationshipTypes}) YIELD node, score`; `algo.wcc({…}) YIELD node, componentId`; `algo.pageRank('Label','REL') YIELD node, score`; `algo.SPpaths({sourceNode, targetNode, relTypes, weightProp, relDirection, pathCount, maxLen}) YIELD path, pathWeight`; `algo.bfs(start, depth, rel) YIELD nodes, edges`; `graph.copy(dest)`; `graph.constraintCreate(UNIQUE, NODE, label, ...props)` requires an exact-match index first; `EXISTS{}` undocumented → pattern predicates; unreferenced relationships only existence-checked → bind and reference `WHERE ID(e) >= 0`; `roQuery` for reads; `{ params }` for parameters.

---

## 5. Query catalogue (`graph/queries.cypher`; each has an "answers:" comment; the README embeds all)

Q1 downstream closure with paths (`*1..$depth`, hops, via) · Q2 undo plan (`seq DESC`) · Q3 blast-radius summary · Q4 gate lock-in · Q5 policy check (pattern predicates) · Q6 explain (thought, reads, writers, trace) · Q7 cross-agent dependents · Q8 load-bearing (`pageRank`) · Q9 hinges (`betweenness`) · Q10 independent clusters (`wcc`) · Q11 path between two actions (`SPpaths`, incoming, weight) · Q12 entity history across runs/agents · Q13 recall (prior plans/policies about an entity or tool, dated) · Q14 conflict check (`state == after`) · Q15 rehearsal diff (fork vs live).

Each is a typed function in `packages/core/src/graph/queries.ts` returning `QueryResult<T> = { rows, cypher, params, ms }`. `graph/queries.cypher` is generated from these functions by a script so README and code never drift.

---

## 6. Tool catalogues (the model never writes Cypher)

**Ops agent (world tools, each returns `{ result, reads, writes }`):** `lookup_order`, `update_address` (restore-before), `create_ticket` (→ soft delete), `post_message` (→ delete), `send_email` (**irreversible**, mitigation `draft_correction_email`), `schedule_followup` (→ cancel), plus `recall` (Q13) and `blast_radius` (Q3) as self-check tools.

**Billing agent:** `list_open_tickets` (graph query), `lookup_ticket`, `apply_credit` (→ `revoke_credit`).

**Graph tools (undo agent + MCP server, one definition):** `list_actions`, `resolve_action`, `plan_undo` (depth), `rehearse_undo`, `execute_undo` (`confirmed:true`), `explain_action`, `entity_history`, `recall`, `load_bearing`, `hinge_actions`, `independent_clusters`, `path_between`, `set_policy`. Schemas: flat objects of primitives/enums/optionals.

---

## 7. Architecture and UI/UX spec

### 7.1 Repository
```
backtrack/
  AGENTS.md  CLAUDE.md  README.md  LICENSE(MIT)  docker-compose.yml  .env.example  pnpm-workspace.yaml
  docs/      PLAN.md (this file) · CONTRACTS.md · spike-results.md · why-a-graph.md · demo-script.md · judge-qa.md · later.md
  graph/     queries.cypher (generated) · model.md (Mermaid)
  fixtures/  world-seed.json · ops-run.json · billing-run.json
  packages/core/src
    contracts/   types.ts (EntityRef, EffectDraft, ToolResult, ToolDefinition, ActionRecord, UndoPlan, QueryResult, RunEvent) · events.ts (SSE event union) · api.ts (route request/response zod schemas)
    graph/       client.ts · bootstrap.ts · queries.ts · cypher.ts (tagged helper, param stringify)
    world/       seed.ts · store.ts
    sdk/         registry.ts · recorder.ts · gate.ts · undo.ts · policies.ts · validate.ts
    agents/      tools.ops.ts · tools.billing.ts · tools.graph.ts · replay.ts · llm.ts · ops.ts · billing.ts · undo.ts
    index.ts
  packages/core/test   *.test.ts (vitest, against bt:test)
  packages/mcp-server  src/index.ts (stdio)
  apps/web             Next.js 16 App Router, Tailwind, shadcn/ui, framer-motion, react-force-graph-2d
    app/api/{graph,world,history,reset,agent,approval,undo,rehearse}/route.ts
    app/page.tsx · components/{TopBar,GraphView,BlastChip,RunStream,StepCard,TraceStrip,ApprovalCard,UndoConsole,PlanCard,WorldPanel,TimeScrubber,ExplainDrawer}.tsx
    lib/{api.ts (typed client from contracts), mock.ts (fixture-backed client for NEXT_PUBLIC_MOCK=1)}
  .github/workflows/ci.yml
```

### 7.2 Key mechanisms
- **Gate = graph-driven approval.** AI SDK 7 `toolApproval` is a function: for irreversible tools run Q5 then Q4; return `'user-approval'` with reason "would lock in 3 reversible changes: update_address, create_ticket, post_message", else `'approved'`; policy block → `'denied'`. UI shows the native `approval-requested` part; Approve/Deny call `addToolApprovalResponse` and write `(User)-[:APPROVED|DENIED]->(Action)`. Replay implements the same pause via the `RunEvent` contract (`approval.requested` → `/api/approval`).
- **Replay = fixture through the real recorder** with 400 ms pacing, emitting the same `RunEvent`s the LLM path emits. Default on the live URL. (P2: mock model through `ToolLoopAgent`.)
- **World in the graph** (`Entity.state`) because Vercel functions are stateless; `/api/reset` rebuilds with fixed ids (`cust_42`, `ord_1001`…), protected by `RESET_TOKEN`.
- **Undo execution:** own `Run {kind:'undo'}`; per action in `seq DESC`: Q14 conflict check → restore `before` (internal) or mitigation (external) → undo Action with `UNDOES` → original `undone`; plan `executed|partial|conflict`. Paced ~500 ms per step for the audience.
- **Rehearsal:** `graph.copy('bt:demo:fork:<planId>')` → execute on fork → Q15 diff → `GRAPH.DELETE` fork → diff card before Confirm.
- **LLM:** `@openrouter/ai-sdk-provider@3` + `ai@7`; primary `nvidia/nemotron-3-super-120b-a12b:free`, `extraBody.models` fallbacks `google/gemma-4-31b-it:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`; `temperature 0`; `stopWhen` 8 steps; daily counter on `Meta` (limit 40) → graceful "budget used, showing replay"; log `response.model`. Free-model list rotates: re-check `GET https://openrouter.ai/api/v1/models` (pricing 0 + `tools`) on day of.
- **Connections:** FalkorDB client cached on `globalThis`, `error` listener, lazy reconnect on failed ping; FalkorDB Cloud free has no TLS → host/port/user/pass. Routes: Node runtime, `maxDuration = 300`.

### 7.3 UI/UX spec
**User:** an engineer/ops lead running agents that act. Integration is three lines (`defineTool`, `withBacktrack`); they get this panel plus MCP tools.

**Visual language:** dark control-room: near-black navy, soft panel surfaces, one accent (electric blue) for selection, amber pending/approval, red irreversible, green reverted. Inter + JetBrains Mono. shadcn/ui primitives. No decorative gradients, no stock art. Design tokens in `app/globals.css`; light theme supported via tokens but dark is default.

**Layout (desktop, top bar + 3 columns 40/35/25):**
- **Top bar:** wordmark + tagline; "FalkorDB · bt:demo" connection dot; `Run ops agent` (replay) · `Live LLM` (budget-guarded) · `Run billing agent` · `Reset world`; tenant switch (P2).
- **Left — Graph.** Action nodes: circles colored by tool family (read grey, write blue, create teal, external red); status ring: done solid, pending pulsing amber, undone dashed grey, blocked/denied red. Entities: diamonds with labels. Agents: colored hulls/labels. `DEPENDS_ON` thick with arrows; `CAUSED→ON` thin. Nodes spring in as the run streams. Click an Action: downstream closure lights, rest dims to 20%, particles flow along dependency edges; **Blast chip** "4 actions · 1 irreversible · 3 entities" with **depth slider 1–5** re-running Q1. Hover tooltip: tool, args, seq, status.
- **Center — Run stream + Undo console.** Agent header (name, run id, status pill, model badge). Step cards: thought (italic), tool chip + args, result one-liner, collapsible **trace strip** "Cypher · 3 ms · 2 rows". **Approval card** (amber) inline with the graph's reason; Approve/Deny. **Undo console** below: input ("undo the address change…"), **⌘Z anywhere** focuses it with the last action prefilled. Outcome cards: *Plan* (ordered checklist ↩/⚠, 👥 cross-agent line, Rehearse/Confirm), *Memory* ("undone before on …"), *Nothing depends*, *Unknown action* (3 closest candidates). On Confirm the checklist ticks in sync with graph nodes turning dashed and world fields flashing green.
- **Right — World panel.** Orders/Customers/Tickets/Messages/Calendar/Emails compact cards; demo order pinned. Change flashes blue; revert flashes green with "restored"; creates slide in; deletes collapse. **Time scrubber** below: one tick per action; drag shows the world at that seq and dims later graph nodes; "Now" snaps back.
- **Explain drawer** (right sheet): header (tool, seq, agent, run, time); Why; Read (→ "written by update_address at seq 2"); Changed (before → after); Depends on / Depended on by; Path chips; Cypher block with copy.

**States:** empty ("Nothing recorded yet. Run the ops agent."), skeletons, error toasts with the real message, budget banner, mobile stack that does not break. **Motion:** one animation per change, <400 ms, only the pending pulse loops. **Copy:** every number on screen names the query that produced it. **Accessibility:** keyboard reachable, visible focus, 4.5:1 contrast, reduced-motion respected.

---

## 8. Engineering standards

- TypeScript strict, ESM, `zod@4` schemas shared by tools, MCP, API and UI. ESLint + Prettier; `pnpm typecheck && pnpm lint && pnpm test` must pass before any issue is closed.
- **Contracts are frozen after the foundations milestone.** Changing `packages/core/src/contracts/*` requires a `decision` issue explaining why, and updating dependants in the same change.
- **Area ownership** (say what and why when touching another area): core = `packages/core/{graph,world,sdk}`, test; web = `apps/web`; agents = `packages/core/agents`, `packages/mcp-server`, fixtures; docs = `README.md`, `docs/`, `graph/model.md`, media; infra = `.github`, `docker-compose.yml`, deploy config.
- **Spike before relying** on any FalkorDB behaviour not in `docs/spike-results.md`; append results there.
- **No model-written Cypher. No LLM-supplied ids trusted.** Parameterized queries only. Reads/writes from tool implementations.
- Every query function: "answers:" comment, returns `QueryResult`, has a test against `bt:test` with the fixture graph.
- Commits: `BT-0xx: imperative summary` (one or few per issue), pushed to `main` (trunk-based; rebase before push; small commits). Judges read history.
- Definition of done per issue: acceptance criteria met, tests added where the issue says, closing the tracker issue with what was verified and how, and a one-line entry appended to `docs/CHANGELOG.md`.
- Stop and ask (comment on the issue) when credentials are needed, a contract must change, or UX is ambiguous. Never invent credentials or deploy targets.

---

## 9. Showcase plan

**README outline:** tagline + 30 s GIF → the problem (two incidents, "rewind restores state, not consequences") → what Backtrack does (act/remember/relate/trace table) → live URL + 60 s walkthrough → graph model (Mermaid + tables + invariants) → the 15 queries with "answers:" and row screenshots → why a graph, not a log (depth-1 vs depth-4) → architecture + SDK snippet → MCP setup (Claude Desktop/Cursor JSON) → local setup/env/deploy → tracks 1 & 2 with the coverage table → alignment with the official guide (§2) → honest limitations + future work → built with AI assistance (Claude Code, Amp; what was generated vs decided and written by Ayush) → MIT.

**Hackathon coverage table (README):** follow connections (Q1/Q2) · remember across sessions (run 2 links into run 1, `Run.messages`, Q12/Q13, policies) · share state (shared tenant graph, billing discovers ops' ticket, Q7) · people/projects/decisions (`User` edges, Steps' thoughts, UndoPlan/Policy provenance) · path behind an answer (Q6 + highlighted path) · T1 multi-hop, algorithms as tools, MCP, graph-driven actions, explainable · T2 episodic/semantic/procedural memory, persistent history, handoffs, concurrency (demonstrated, not stress-tested), per-tenant graphs.

**Video (2:45):** 0:00 two incident headlines → 0:15 tagline over empty panel → 0:25 run ops agent, graph grows, trace ticks → 0:55 gate card with the graph's reason, Approve → 1:10 ⌘Z, "undo the address change", plan card; depth 1→3 reveals billing credit with path → 1:35 Rehearse diff → Confirm, world reverts, correction draft appears → 2:05 scrubber → 2:15 explain drawer with Cypher → 2:25 "never again" policy blocks a re-run → 2:35 end card: model diagram, tracks, repo. Recorded by Ayush 19:15–20:15 with replay mode; LLM take only if budget allows after 12:30.

**Blog (side prize):** "I built an undo button for AI agents on a graph": the incidents, why rewind ≠ undo, the PROV model, the three queries that matter, the gate as an approval function, what FalkorDB made easy (GRAPH.COPY, multigraph, algorithms), what I would do next. 1,200 words, 6 screenshots.

**Submission form:** tracks 1 & 2; one-liner; 150-word description; repo, live, video URLs; AI disclosure sentence; solo.

**Judge Q&A (`docs/judge-qa.md`, Ayush writes answers in his words):** why not a log · why derive dependencies from reads/writes · why seq-desc is topological · human edits between runs (conflict) · what cannot be undone · why graph per tenant · why the model never writes Cypher · field-level dependencies · gate vs "ask before every email" · what breaks at 10k actions (indexes, depth bound).

---

## 10. Work breakdown. Priorities P0–P2, estimates in minutes, deps are hard blockers. Tracked in `.beads/`.

### E0 Foundations (sequential)
- **BT-001** Repo scaffold — P0, 40m. pnpm workspace; strict TS; ESLint/Prettier; vitest; MIT; `.gitignore`; `.env.example` (`OPENROUTER_API_KEY, FALKORDB_HOST, FALKORDB_PORT, FALKORDB_USERNAME, FALKORDB_PASSWORD, RESET_TOKEN, NEXT_PUBLIC_MOCK`); `AGENTS.md`, `CLAUDE.md`, `docs/PLAN.md`; scripts `db:up, spike, demo:replay, demo:undo, typecheck, lint, test, gen:queries`. **AC:** `pnpm i && pnpm typecheck && pnpm lint && pnpm test` pass; pushed.
- **BT-002** docker-compose FalkorDB + Browser — P0, 15m, deps 001. **AC:** `pnpm db:up` then Browser at :3000 and `redis-cli -p 6379 ping`.
- **BT-003** Contracts + fixtures — P0, 60m, deps 001. `contracts/types.ts`, `events.ts` (RunEvent: `run.started|step|action.recorded|approval.requested|approval.resolved|undo.step|run.finished|error`), `api.ts` (every route's request/response zod), `docs/CONTRACTS.md`, `fixtures/*.json` validated by schemas (ops run: lookup→update_address→create_ticket→post_message→send_email[gate]→schedule_followup; billing run: list_open_tickets→lookup_ticket→apply_credit). **AC:** `pnpm test` includes fixture validation; doc lists all routes.
- **BT-004** FalkorDB spike — P0, 45m, deps 002. Script proves: index→constraint OPERATIONAL, 2 actions + DEPENDS_ON, Q1 with `nodes(path)`, `wcc`, `pageRank`, `SPpaths` with weight, `copy`+delete, param stringify. Results in `docs/spike-results.md`. **AC:** all green; deviations documented.

### E1 Graph layer 
- **BT-010** `graph/client.ts` — P0, 45m, deps 004. Singleton on globalThis, tenant handle, `query/roQuery` → `QueryResult`, error listener, reconnect. **AC:** tests for param stringify and reconnect-on-ping.
- **BT-011** `graph/bootstrap.ts` — P0, 45m, deps 010. Idempotent per §4. **AC:** running twice is a no-op; `db.constraints()` OPERATIONAL.
- **BT-012** `world/seed.ts`, `store.ts` — P0, 40m, deps 011. Fixed ids from `fixtures/world-seed.json`. **AC:** `getEntity('order','ord_1001').address` equals seed.
- **BT-013** `graph/queries.ts` Q1–Q7, Q12–Q14 — P0, 120m, deps 011. **AC:** each has "answers:" comment and a test on a fixture-built graph; `pnpm gen:queries` writes `graph/queries.cypher`.
- **BT-014** Q8–Q11 algorithm queries — P1, 45m, deps 013. **AC:** tests assert shapes; weight on `DEPENDS_ON`.
- **BT-015** Q15 rehearsal diff — P1, 30m, deps 013.

### E2 SDK engine 
- **BT-020** `sdk/registry.ts` `defineTool` — P0, 40m, deps 003. **AC:** zod schema → AI SDK tool conversion typed; reversible/irreversible exclusive.
- **BT-021** `sdk/recorder.ts` — P0, 90m, deps 012, 020. Single-statement write + DEPENDS_ON (read & write, latest writer). **AC:** tests: read-after-write, write-after-write, latest-only, cross-run, `seq` monotonic.
- **BT-022** `sdk/undo.ts` `planUndo` — P0, 60m, deps 013, 021. Q2+Q3+Q7, depth param, four outcomes. **AC:** tests for each outcome.
- **BT-023** `executeUndo` — P0, 90m, deps 022. Undo Run, `seq DESC`, Q14, restore before, mitigation, `UNDOES/REVERTS/COULD_NOT_REVERT/CONFLICT`, pacing hook. **AC:** tests: order, conflict → partial, undo-the-undo refused, idempotent re-run.
- **BT-024** `sdk/gate.ts` — P0, 45m, deps 013, 021. Approval function (Q5→Q4) + `User` APPROVED/DENIED writes. **AC:** test: 3 reversible upstream → `user-approval` with reason text.
- **BT-025** `rehearseUndo` — P1, 60m, deps 023, 015. **AC:** live graph unchanged; fork deleted; diff equals later real change.
- **BT-026** `sdk/policies.ts` — P1, 45m, deps 024. `set_policy`, enforcement, `BLOCKED`. **AC:** test: blocked action recorded, agent sees denial.
- **BT-027** `sdk/validate.ts` — P1, 30m, deps 022. `validateSummary`. **AC:** rejects invented ids, falls back to template.

### E3 Agents, replay, LLM, MCP 
- **BT-030** `agents/tools.ops.ts` — P0, 90m, deps 020, 012. Six tools + inverses + mitigation; `{result, reads, writes}`. **AC:** unit test per tool; `send_email` marked irreversible.
- **BT-031** `agents/tools.billing.ts` — P0, 40m, deps 030.
- **BT-032** `agents/replay.ts` + CLIs — P0, 90m, deps 021, 030, 003. Fixture → recorder, 400 ms pacing, emits `RunEvent`s, pauses on gate until `/api/approval` or CLI flag. **AC:** `pnpm demo:replay` builds the graph; `pnpm demo:undo <id>` reverts; Browser screenshot committed to `docs/media/`.
- **BT-033** `agents/tools.graph.ts` — P0, 90m, deps 022, 023. All graph tools with flat schemas, `resolve_action`. **AC:** schema snapshot test; unknown id → `unknown` outcome.
- **BT-034** `agents/llm.ts` — P1, 45m, deps 003. OpenRouter provider, fallbacks, daily counter on `Meta`, model logging. **AC:** unit test for counter; manual smoke deferred to Ayush (budget).
- **BT-035** `agents/ops.ts` ToolLoopAgent — P1, 60m, deps 030, 024, 034. `toolApproval` = gate; `Run.messages` persistence; instructions call `recall` first. **AC:** compiles; dry-run with mock model; ≤3 live runs by Ayush after 12:30.
- **BT-036** `agents/undo.ts` — P1, 45m, deps 033, 027, 034. Four-outcome instructions; `validateSummary` on final text.
- **BT-037** `agents/billing.ts` — P1, 30m, deps 031, 035.
- **BT-038** `packages/mcp-server` stdio — P1, 45m, deps 033. **AC:** `npx @backtrack/mcp-server` lists tools in MCP inspector; README snippet.
- **BT-039** mock-model replay through ToolLoopAgent — P2, 60m, deps 035, 032.
- **BT-03A** `recall` tool + ops instructions — P1, 30m, deps 013, 035.

### E4 Web app 
- **BT-040** Next.js scaffold + design tokens + shell — P0, 90m, deps 003. Tailwind, shadcn, fonts, dark tokens, top bar, 3-column layout, `lib/api.ts` typed client, `lib/mock.ts` fixture-backed. **AC:** renders mock run; Lighthouse a11y ≥ 90.
- **BT-041** API routes — P0, 90m, deps 032, 022, 023, 024, 012. `graph, world, history, reset(token), agent(SSE replay|llm), approval, undo, rehearse`; Node runtime; `maxDuration`. **AC:** route tests with the contracts' schemas.
- **BT-042** GraphView + BlastChip + depth slider — P0, 150m, deps 040. Per §7.3. **AC:** click highlights closure; slider re-queries; 60 fps with 200 nodes.
- **BT-043** RunStream + StepCard + TraceStrip + ApprovalCard — P0, 120m, deps 040. **AC:** streams fixture; approval resolves via mock then real route.
- **BT-044** UndoConsole + PlanCard + outcome cards + ⌘Z — P0, 120m, deps 040. **AC:** four outcomes render; confirm ticks in sync with events.
- **BT-045** WorldPanel with flash transitions — P0, 90m, deps 040. **AC:** blue on change, green on revert, create/delete transitions.
- **BT-046** ExplainDrawer — P0, 90m, deps 040. **AC:** shows why/read/changed/depends/path/Cypher copy.
- **BT-047** TimeScrubber — P1, 90m, deps 045, 041. **AC:** frames equal Effects fold; later nodes dim.
- **BT-048** States + mobile + a11y pass — P1, 60m, deps 042–046.
- **BT-049** Visual polish + motion audit + screenshots — P1, 90m, deps 048, 041. **AC:** matches §7.3 motion/copy rules; 8 screenshots to `docs/media/`.
- **BT-04A** Wire web to real API (`NEXT_PUBLIC_MOCK=0`) and fix diffs — P0, 60m, deps 041, 042–046.
- **BT-04B** Algorithm buttons (load-bearing, hinges, clusters, path between) — P1, 60m, deps 014, 046.
- **BT-04C** Tenant switcher — P2, 30m, deps 04A.

### E5 Infra 
- **BT-050** CI workflow (falkordb service; typecheck, lint, test) — P0, 45m, deps 001. **AC:** green on main.
- **BT-051** **Owner: Ayush.** OpenRouter key; FalkorDB Cloud free instance; Vercel project; fill `.env` and Vercel env — P0, 20m.
- **BT-052** Deploy to Vercel + smoke + pre-warm script — P1, 60m, deps 051, 04A. **AC:** live URL runs the replay demo; `vercel logs` clean.
- **BT-053** Public-URL hardening: reset token, basic rate limit, payload caps — P1, 45m, deps 041.
- **BT-054** Playwright E2E of the demo script (replay) — P2, 90m, deps 04A.

### E6 Showcase 
- **BT-060** README v1 from §9 with placeholders — P0, 60m, deps 003. **AC:** all sections present; coverage + guide tables.
- **BT-061** `graph/model.md` Mermaid + `docs/why-a-graph.md` — P0, 45m, deps 003.
- **BT-062** README v2: queries embedded from `queries.cypher`, screenshots, live URL — P0, 60m, deps 013, 049, 052.
- **BT-063** `docs/demo-script.md` shot list + recording checklist — P1, 30m.
- **BT-064** Blog draft — P1, 90m, deps 062.
- **BT-065** Submission text + AI disclosure + social thread — P1, 30m, deps 062.
- **BT-066** `docs/judge-qa.md` questions (answers by Ayush) — P1, 20m.
- **BT-067** Stranger test from README on a clean clone; fix findings — P0, 45m, deps 062, 04A.
- **BT-068** Demo GIF (30 s) — P1, 30m, deps 049.

### E7 Owner: Ayush
- **BT-070** Review and walk every query; edit "answers:" comments in own words — P0, 60m, deps 013.
- **BT-071** LLM smoke ≤3 runs after 12:30; pick primary model; note in README — P1, 30m, deps 035, 051.
- **BT-072** Record video — P0, 60m, deps 067.
- **BT-073** Submit form, both tracks — P0, 20m, deps 072.

---

## 11. Risk register

| Risk | Mitigation |
|---|---|
| Parallel workstreams collide on files | Area ownership; contracts frozen after E0; trunk with rebase; small commits |
| Contract gaps discovered mid-build | `decision` issues; arbitrated at the two daily checkpoints |
| Free model ignores tool path | replay default; temperature 0; flat schemas; `resolve_action`; fallbacks |
| 50 req/day | counter on `Meta`; smoke ≤3 runs; LLM video take after 12:30 only |
| FalkorDB Cloud quirks | spike first; singleton client; local Docker fallback in video |
| Vercel cold start/duration | replay ≈ 20 s streamed; pre-warm; `maxDuration 300` |
| UI quality drift between workstreams | §7.3 is the spec; BT-049 audit; shadcn tokens |
| Scope creep | §3 is law; new ideas → `docs/later.md` |

---

## 12. Verification (definition of done)

- `pnpm spike` green; `pnpm test` green locally and in CI.
- Terminal: `pnpm demo:replay` then `pnpm demo:undo <update_address id>` → order cancel_event → delete_message → close_ticket → restore address; `send_email` under COULD_NOT_REVERT with mitigation; world shows original address; originals `undone` in Browser.
- Gate: approval card before `send_email` with the reason text; Approve continues; Deny records DENIED and no retry.
- Undo-the-undo refused; second run links into run 1; conflict (manual `SET` between run and undo) yields `partial` with a CONFLICT edge.
- Web local and live: the §9 video script end to end in replay; depth 1→3 reveals the billing credit with its path; scrubber frames match Effects; rehearsal diff equals the real change and the fork is gone (`db.list()`).
- People and decisions: `MATCH (u:User)-[r]->(x) RETURN type(r), labels(x)` shows APPROVED, REQUESTED, SET.
- Stranger test passes from README alone; README contains model, all queries, algorithms, tracks, setup, live URL, AI disclosure; video uploaded; form submitted with tracks 1 and 2.
