# Working in this repository

Conventions for anyone (and any coding assistant) contributing to Backtrack. The engineering plan is `docs/PLAN.md`; contracts are `packages/core/src/contracts/` (map in `docs/CONTRACTS.md`); verified FalkorDB behaviour is `docs/spike-results.md`.

## Commands
```
pnpm db:up            # FalkorDB + Browser (http://localhost:3000) via docker compose
pnpm spike            # prove FalkorDB behaviours against the local instance
pnpm demo:replay      # record the golden ops run into bt:demo
pnpm demo:undo <id>   # plan and execute an undo from the terminal
pnpm dev              # web panel
pnpm typecheck && pnpm lint && pnpm test
```

## Rules that do not bend
1. **The model never writes Cypher.** Agents choose from a fixed tool catalogue; arguments are validated against the graph (`resolve_action`) before any query runs. Parameterized queries only.
2. **Reads and writes come from the tool implementation**, never from model-supplied arguments. Every tool returns `{ result, reads, writes }`.
3. **Every query is a named function** in `packages/core/src/graph/queries.ts` with a one-line `answers:` comment, returns `{ rows, cypher, params, ms }`, and has a test against graph `bt:test`. `graph/queries.cypher` is generated from it (`pnpm gen:queries`); never edit the generated file.
4. **Spike before relying.** Any FalkorDB behaviour not listed in `docs/spike-results.md` gets a check added to `scripts/spike.ts` first.
5. **Contracts are frozen.** Changing `packages/core/src/contracts/*` requires a `decision` issue with the reason, and updating every dependant in the same change.
6. **Nothing on screen claims what the graph cannot back.** Counts, order, warnings and explanations come from query rows; the UI can show the Cypher behind each.
7. **Tenant is a graph** (`bt:<tenant>`), never a `WHERE` filter.
8. Nested JSON is stored as a string in the graph; variable-length depth is a clamped integer literal (see spike results).

## Workflow
- Work is tracked in `.beads/` (`bd ready`, `bd show <id>`, `bd close <id> --reason "..."`). Each issue carries acceptance criteria; it is done when they are met, the quality gates pass, and a line is added to `docs/CHANGELOG.md`.
- Ownership by area: `packages/core/{graph,world,sdk}` and tests · `apps/web` · `packages/core/agents`, `packages/mcp-server`, `fixtures` · `README.md`, `docs/`, `graph/model.md`, media · `.github`, deploy config. Touching another area is fine when the issue says so; say what and why in the commit.
- Commits: `BT-0xx: imperative summary`, small, rebased on `main`, pushed often.
- If something needs credentials, a contract change or a product decision, leave a comment on the issue and move on; do not guess.
- New ideas go to `docs/later.md`, not into scope.

## Design and UI work
The UI spec is `docs/PLAN.md` §7.3 and the tokens are `docs/design-system.md` (overrides the generated proposal in `design-system/backtrack/`). For any issue in `apps/web`, use the project skills in `.agents/skills/` in this order:
1. `ui-ux-pro-max` — before building a screen or component, run `python3 .agents/skills/ui-ux-pro-max/scripts/search.py "<what you are building>" --domain ux` (and `--domain style|typography|chart` as needed) and apply the guidance; the design-system baseline is already persisted under `design-system/backtrack/`.
2. `frontend-design` — read it before any visual decision; avoid the generic tells it lists (gradient-accent stats, one highlighted word, all-caps labels, scattered entrance animations).
3. `web-design-guidelines` — run its review against every component before closing the issue (accessibility, forms, motion, dark mode).
4. `vercel-react-best-practices` and `vercel-composition-patterns` — for component structure, data loading and performance.
Non-negotiables from the spec: one accent color for selection, amber for pending/approval, red for irreversible, green for reverted; one animation per change under 400 ms, only the pending pulse loops; every number on screen names the query that produced it; reduced motion respected; 4.5:1 contrast; keyboard reachable with visible focus.

## Stack (approved dependencies)
pnpm 12 · TypeScript 5 strict · Biome · Vitest · `falkordb` · `zod` 4 · `ai` 7 + `@openrouter/ai-sdk-provider` 3 · `@modelcontextprotocol/sdk` · Next.js 16 (App Router) · Tailwind · shadcn/ui · framer-motion · `react-force-graph-2d`. Anything else: note it in the issue first.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
