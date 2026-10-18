# Submission

Text for the Graph Hacks form and the launch thread. Every claim here is backed by the README, the code or the demo graph; check the URLs before pasting.

## Form fields

| Field | Value |
|---|---|
| Project name | Backtrack |
| Tracks | Track 1 — Agents That Act on Connected Data; Track 2 — Agent Memory and Coordination |
| Team | Solo: Ayush Gundecha |
| Repository | https://github.com/ayushgundecha/Backtrack |
| Live URL | *after deploy (BT-052)* |
| Video | *after recording (BT-072)* |
| AI disclosure | Paste the README's "Built with AI assistance" section, once written in Ayush's words (BT-070 walkthrough). |

## One-liner

Backtrack is the undo button for AI agents: it records every action as a cause-and-effect graph in FalkorDB and computes a safe undo plan for any past action, including what other agents built on it.

## Description (150 words)

Agents now take real actions, and when one goes wrong, "rewind" restores state, not consequences. Backtrack records each tool call as an Action with the Effects it caused and the Entities it read, and derives DEPENDS_ON edges from those reads and writes, across runs and agents. Point at any past action ("undo the address change") and FalkorDB answers with traversals: what depends on it, in what order to unwind it (seq DESC over DEPENDS_ON is a reverse topological order), what is irreversible and needs a mitigation, and which other agent's work it reaches, with the path. The plan is rehearsed on a GRAPH.COPY fork before anything changes. Before an irreversible call, a graph query pauses the agent with the reason. "Never again" turns an undo into a policy the gate enforces. The model never writes Cypher: 15 named, tested queries, PageRank, betweenness, WCC and SPpaths are exposed as tools and over MCP.

## Launch thread (6 posts)

1. AI agents now update records, open tickets and send emails. When one gets it wrong, "rewind" gives you the old files back, not the consequences. I built Backtrack for #GraphHacks: the undo button for AI agents, on @FalkorDB. 🧵

2. Every tool call becomes an Action in a graph: the Effects it caused (before and after) and the Entities it read. DEPENDS_ON edges come from those reads and writes, never from what the model says it did.

3. Say "undo the address change". At depth 1 the plan touches two actions. Slide to depth 3 and a billing agent's credit appears, three hops away, with its path. Same question, deeper traversal: that is the reason it is a graph and not a log.

4. The plan runs newest first (seq DESC over DEPENDS_ON is a reverse topological order). A sent email cannot be unsent, so it gets a correction draft instead. Rehearse runs the whole plan on a GRAPH.COPY fork and shows the diff before you confirm.

5. Before an irreversible call, a query decides whether to pause the agent: "would lock in 3 reversible changes". After an undo, "Never again" records a policy, and the next run is stopped at the same move. Every number on screen names the query behind it.

6. 15 named queries, FalkorDB's PageRank, betweenness, WCC and shortest paths as agent tools, an MCP server, and the model never writes Cypher. Code, model and queries: https://github.com/ayushgundecha/Backtrack · demo: *live URL after deploy*
