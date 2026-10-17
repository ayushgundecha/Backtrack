# Later

Ideas that are good but out of scope for the hackathon build. Each line: idea — why it waits.

- Undo by natural-language description via a vector index on `Action.embedding` — the undo console already resolves descriptions against the action list; vectors add infra for little demo value.
- Field-level dependency edges (`DEPENDS_ON {field}`) — entity-level is explainable and sufficient for the demo; field-level needs per-tool field maps.
- MCP over HTTP from the deployed app — self-calling the deployment doubles cold starts and adds session state; the stdio server covers external clients.
- Real external integrations (GitHub issue, Slack message) with real inverses — needs credentials and rate limits; the synthetic world keeps the demo deterministic.
- Policy suggestions from repeated undos — needs more than one undo per tool to be meaningful.
