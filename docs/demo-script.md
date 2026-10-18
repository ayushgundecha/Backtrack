# Demo script (2:45)

The shot list for the submission video, from `docs/PLAN.md` §9. Recorded by Ayush in replay mode; a live LLM take only if the budget allows after 12:30. The voice-over below is a draft for Ayush to rewrite in his own words.

Everything said on camera must be backed by the screen: counts, order, warnings and paths come from query rows (Q-numbers are noted so the claim can be checked).

## Pre-flight checklist

Do these in order, right before recording.

**World and graph**
- [ ] Reset the world: **Reset world** in the top bar, or
  `curl -X POST <live-url>/api/reset -H 'content-type: application/json' -d '{"tenant":"demo","token":"<RESET_TOKEN>"}'`.
- [ ] The panel shows the empty state ("Nothing recorded yet. Run the ops agent.") and the connection dot reads "FalkorDB · bt:demo".
- [ ] The world panel shows order `ord_1001` pinned with the original address "14 Marine Drive, Mumbai 400020".
- [ ] Mode is **replay** (the default). Live LLM is not selected.
- [ ] One full dry run of the script below, then reset again. Check during the dry run that the depth slider can be set to 1 before the undo shot (the API default depth is 5).

**Deployment**
- [ ] Pre-warm the deployment: open the live URL and load `/api/graph` and `/api/world` once, so no cold start lands on camera. <!-- TODO(BT-052): name the pre-warm script once it exists -->
- [ ] If FalkorDB Cloud misbehaves, record against local Docker (`pnpm db:up`, `pnpm dev`) instead; the script is identical.

**Screen**
- [ ] Browser window 1920×1080, browser zoom 100%. If text is too small on the recording, use 110% and check the three columns do not collapse into the mobile stack.
- [ ] Clean browser profile: no bookmarks bar, no extensions, no other tabs except the two below.
- [ ] OS "reduce motion" is **off** (the app respects it, and the animations are part of the story).
- [ ] Notifications off: Do Not Disturb / Focus on; chat apps, mail and calendar quit; dock or taskbar hidden.
- [ ] Tab 1: the Backtrack panel. Tab 2: FalkorDB Browser (`http://localhost:3000` for local Docker, or the FalkorDB Cloud browser for the deployed instance), connected to the **same** instance, graph `bt:demo` selected, with the "originals undone" query below already pasted.
- [ ] The incident headlines (Replit, July 2025; PocketOS, April 2026) and the end card are ready as full-screen images. <!-- TODO(BT-072): incident headline images and end card -->

**Audio and capture**
- [ ] Mic level checked; room quiet.
- [ ] Recorder set to 1080p; cursor highlight on; keystroke overlay on (so ⌘Z is visible).

### Query for the "originals undone" shot (FalkorDB Browser)

```cypher
// answers: which original actions were undone, by which undo action, and what is their status now?
MATCH (u:Action)-[:UNDOES]->(o:Action)
RETURN o.seq AS seq, o.tool AS original, o.status AS status, u.tool AS undone_by
ORDER BY o.seq DESC
```

Check in the dry run how `send_email` appears here (it is irreversible: the plan records it under `COULD_NOT_REVERT` with the `draft_correction_email` mitigation), so the voice-over matches what the rows show.

## Shot list

| Time | On screen | Voice-over (draft) | Click / action |
|---|---|---|---|
| 0:00–0:15 | Two incident headlines, one after the other: Replit (July 2025), PocketOS (April 2026). | "Two incidents, same shape. An AI agent acted in production with no confirmation step, and the recovery came from outside the agent, a whole database at a time." | Cut between the two images. |
| 0:15–0:25 | Tagline "Backtrack — the undo button for AI agents" over the empty panel; connection dot "FalkorDB · bt:demo". | "Rewind restores state. It does not undo consequences. Backtrack records every agent action as a cause-and-effect graph in FalkorDB, and computes the undo from it." | None. |
| 0:25–0:55 | Ops agent run streams: step cards with thoughts and tool chips; the graph grows node by node; trace strips tick ("Cypher · ms · rows"); `ord_1001` address flashes blue in the world panel. | "An ops agent fixes a customer's order: it looks up the order, changes the address, opens a ticket, posts to the ops channel. Every tool call is recorded with what it read and what it changed, and the graph links each action to the actions it depended on. Every step shows the query that recorded it." | **Run ops agent**. Hover one trace strip briefly. |
| 0:55–1:10 | Amber approval card before `send_email`: "would lock in 3 reversible changes: update_address, create_ticket, post_message". Then the billing agent run: three short steps, its nodes attach to `post_message`. | "Before sending the email, the agent pauses itself. Not a hand-written rule: a graph query (Q4 gate lock-in) found three reversible changes this email would lock in. I approve. A second agent, billing, reads the open ticket and applies a goodwill credit. It never spoke to the ops agent." | **Approve**. When the run finishes, **Run billing agent**. |
| 1:10–1:35 | ⌘Z focuses the undo console; type "undo the address change"; plan card appears with depth 1: `create_ticket`, `send_email` flagged irreversible. Drag the blast-chip depth slider 1 → 3: `post_message` at 2, then `schedule_followup` and the billing agent's `apply_credit` with the path `apply_credit → post_message → create_ticket → update_address`. | "The address was wrong. Command-Z: undo the address change. At depth one, two actions depend on it, and one of them, the email, can't be taken back. Drag to depth three, and a different agent's credit appears, with the exact path that connects it. That is a transitive question; the graph answers it in one query (Q1 downstream closure)." | **⌘Z**, type, **Enter**. Drag depth slider **1 → 2 → 3**. Hover the cross-agent line. |
| 1:35–2:05 | **Rehearse**: diff card from the forked graph. **Confirm**: checklist ticks in `seq DESC` order (revoke_credit, cancel_event, draft_correction_email, delete_message, close_ticket, restore_address); graph nodes turn dashed; world fields flash green "restored"; a correction email draft appears. Cut (about 5 s) to FalkorDB Browser running the "originals undone" query. | "First, rehearse: Backtrack copies the whole graph with GRAPH.COPY, runs the undo on the copy, shows the diff, and deletes the copy. Then confirm. It reverts in reverse dependency order, newest first. The email can't be unsent, so it drafts a correction instead, and records that it could not revert it. In FalkorDB itself, every original is linked to the action that undid it." | **Rehearse**, then **Confirm**. Switch to tab 2, **Run** the query, switch back. |
| 2:05–2:15 | Time scrubber: drag back to before `update_address`, later graph nodes dim, the world shows the state at that `seq`; **Now** snaps back. | "Because every change is stored with its before and after, I can scrub the world to any point in the run." | Drag the scrubber left, then click **Now**. |
| 2:15–2:25 | Click the `create_ticket` node: explain drawer with Why (the thought), Read (`order:ord_1001`, written by `update_address` at seq 2), Changed (before → after), Depends on / Depended on by, and the Cypher block. | "Click anything: why it happened, what it read and who wrote that, what it changed, and the exact query behind the answer (Q6 explain)." | Click the node. Click **Copy** on the Cypher block. |
| 2:25–2:35 | Set a "never again" block policy from the executed plan; re-run the ops agent; the targeted step is blocked, the step card shows the policy rule, the graph shows a `BLOCKED` edge. | "And so it doesn't happen again: a policy, stored in the graph, set by me, blocks the same move on the next run (Q5 policy check)." | Set the policy, then **Run ops agent**. <!-- TODO(Ayush, BT-026/BT-044): confirm where the "never again" control lives in the UI and which tool and entity the demo policy targets --> |
| 2:35–2:45 | End card: the graph model diagram (`graph/model.md`), "Track 1: Agents That Act on Connected Data · Track 2: Agent Memory and Coordination", repo URL, live URL. | "Backtrack. The undo button for AI agents, built on FalkorDB." | None. <!-- TODO(BT-072): repo and live URLs on the end card --> |

## Notes for the edit

- Keep each change to one visible motion; do not speed-ramp the undo checklist, the pacing (about 500 ms per step) is part of what the viewer reads.
- If a take overruns, trim the 0:25–0:55 run (the stream can be cut mid-way, the graph result is what matters) before trimming the undo segment.
- Open questions for Ayush:
  - Is the billing agent run on camera (as above, at 1:05) or done before the undo shot off camera? On camera keeps the "never spoke to the ops agent" line honest.
  - Which "never again" policy is shown at 2:25, and does the re-run block at `update_address` or at `send_email`?
