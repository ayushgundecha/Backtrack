# Backtrack — the undo button for AI agents

> Hackathon build for **Graph Hacks: Context for AI Agents** (WeMakeDevs × FalkorDB), Oct 15–18, 2026. Tracks entered: **1 — Agents That Act on Connected Data** and **2 — Agent Memory and Coordination**. Work in progress; this README is completed as the build lands.

AI agents take real actions: they update records, open tickets, post messages, send emails. When one step is wrong there is no Ctrl+Z. Logs are flat and per-run; they cannot tell you what else depended on that action, in what order to unwind, or which effects can never be reversed.

Backtrack records every action an agent takes as a **cause-and-effect graph in FalkorDB**: what it did, what it changed, what it read before changing it, and which later actions depended on it. Point at any mistake and Backtrack computes a **safe undo plan** by traversing the graph, flags irreversible effects with mitigations, rehearses the plan on a forked graph, and executes it while the world reverts in front of you. Because the graph is the agent's memory of itself, it also **pauses the agent before irreversible actions** with the exact reversible work it would lock in, **warns when another agent depends** on what you are undoing, and **explains every action** with the path and the query behind it.

## Status
- [x] Repository scaffold, contracts, fixtures, FalkorDB spike (`docs/spike-results.md`)
- [ ] Graph layer, recorder, undo engine
- [ ] Agents (replay and live), MCP server
- [ ] Web panel
- [ ] Deployment, video, full documentation

## Quick start (local)
```
pnpm install
pnpm db:up          # FalkorDB on :6379, FalkorDB Browser on :3000
pnpm spike          # verifies the FalkorDB behaviours the product relies on
pnpm test
```

## Repository
```
packages/core        graph layer, recorder SDK, undo engine, agents, fixtures contracts
packages/mcp-server  Backtrack graph tools as an MCP server (stdio)
apps/web             control panel (Next.js)
graph/               queries.cypher (generated) and the data model
docs/                engineering plan, contracts map, spike results
fixtures/            synthetic world and golden agent runs
```

## Built with AI assistance
This project was built during the hackathon with AI coding assistants (Claude Code and Amp) used for scaffolding, implementation drafts, test writing and documentation drafts. The problem framing, the graph data model, the query design, the architecture and the product decisions are the author's, and every query and design decision in this repository is one the author can explain. See `AGENTS.md` for the working conventions the assistants followed.

## License
MIT © 2026 Ayush Gundecha
