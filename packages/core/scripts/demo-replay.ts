/**
 * Record the golden ops run (and optionally the billing run) into bt:<tenant>.
 *
 *   pnpm demo:replay                  reset bt:demo, run ops; wait for an approval at the gate
 *   pnpm demo:replay --approve        approve the gate automatically (or --deny)
 *   pnpm demo:replay --billing        then run the billing agent too
 *   pnpm demo:replay --keep --fast    keep the existing graph; no pacing
 *   --tenant acme                     another tenant graph
 */

import { loadRunFixture } from '../src/agents/fixtures.js';
import { replayRun } from '../src/agents/replay.js';
import { createToolRegistry } from '../src/agents/tools.js';
import type { RunEvent } from '../src/contracts/events.js';
import { closeDb, openTenant } from '../src/graph/client.js';
import { recordDecision } from '../src/sdk/gate.js';
import { ensureTenant, resetTenant } from '../src/world/seed.js';
import { tenantFromArgs } from './env.js';

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const g = openTenant(tenantFromArgs(argv));
const registry = createToolRegistry();

if (flag('--keep')) await ensureTenant(g);
else await resetTenant(g);
console.log(`graph ${g.name} ready${flag('--keep') ? '' : ' (reset and seeded)'}\n`);

const print = (e: RunEvent) => {
  switch (e.type) {
    case 'run.started':
      return console.log(`▶ ${e.agentId} run ${e.runId}: ${e.goal}`);
    case 'step':
      return console.log(`\n  ${e.index + 1}. ${e.thought}`);
    case 'action.recorded': {
      const deps = e.dependsOn.length ? ` ← depends on ${e.dependsOn.join(', ')}` : '';
      return console.log(
        `     ${e.action.tool} [${e.action.status}] seq ${e.action.seq} id ${e.action.id}${deps}  (${e.trace.ms} ms)`,
      );
    }
    case 'approval.requested':
      return console.log(
        `     ⏸ gate: ${e.tool} ${e.reason}${flag('--approve') || flag('--deny') ? '' : `\n       waiting for POST /api/approval on ${e.actionId} (or rerun with --approve)`}`,
      );
    case 'approval.resolved':
      return console.log(`     ${e.approved ? '✓ approved' : '✗ denied'} by ${e.by}`);
    case 'action.blocked':
      return console.log(`     ⛔ blocked by ${e.policyId}: ${e.rule}`);
    case 'run.finished':
      return console.log(`\n■ run ${e.runId} ${e.status}\n`);
    case 'error':
      return console.error(`  error: ${e.message}`);
    default:
      return undefined;
  }
};

const autoDecision = flag('--approve') ? true : flag('--deny') ? false : null;
const pace = flag('--fast') ? 0 : 400;
const ops = await replayRun(g, loadRunFixture('ops-agent'), {
  registry,
  emit: print,
  paceMs: pace,
  awaitApproval:
    autoDecision === null
      ? undefined
      : async (pending) => {
          await recordDecision(g, { actionId: pending.action.id, approved: autoDecision });
          return autoDecision;
        },
});
if (flag('--billing') && ops.status === 'done') {
  await replayRun(g, loadRunFixture('billing-agent'), { registry, emit: print, paceMs: pace });
}

const address = ops.actions.find((a) => a.action.tool === 'update_address');
if (address)
  console.log(
    `next: pnpm demo:undo ${address.action.id}   (or: pnpm demo:undo "undo the address change")`,
  );
await closeDb();
