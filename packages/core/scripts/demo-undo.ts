/**
 * Plan and execute an undo from the terminal.
 *
 *   pnpm demo:undo <actionId | "undo the address change"> [--depth 3] [--rehearse] [--dry]
 */

import { createToolRegistry } from '../src/agents/tools.js';
import { closeDb, openTenant } from '../src/graph/client.js';
import { rehearseUndo } from '../src/sdk/rehearse.js';
import { executeUndo, planUndo } from '../src/sdk/undo.js';
import { tenantFromArgs } from './env.js';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const target = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!target) {
  console.error(
    'usage: pnpm demo:undo <actionId | "undo the address change"> [--depth 3] [--rehearse] [--dry]',
  );
  process.exit(1);
}
const g = openTenant(tenantFromArgs(argv));
const registry = createToolRegistry();
const depth = Number(opt('--depth') ?? 5);

const { outcome } = await planUndo(
  g,
  target.startsWith('act_') ? { actionId: target, depth } : { text: target, depth },
  { registry },
);

if (outcome.kind !== 'plan') {
  console.log(`outcome: ${outcome.kind}`);
  console.log(JSON.stringify(outcome, null, 2));
  await closeDb();
  process.exit(0);
}

const { plan } = outcome;
console.log(`plan ${plan.id} (depth ${plan.depth}): ${plan.summary}`);
console.log(
  `blast radius: ${plan.blast.actions} actions · ${plan.blast.irreversible} irreversible · ${plan.blast.entities.length} entities`,
);
for (const s of plan.steps) {
  const mark = s.mode === 'mitigation' ? '⚠' : '↩';
  console.log(
    `  ${s.order}. ${mark} ${s.label}  [${s.agentId}, ${s.hops} hop${s.hops === 1 ? '' : 's'}: ${s.via.join(' → ')}]`,
  );
}

if (argv.includes('--rehearse')) {
  const diff = await rehearseUndo(g, plan.id, { registry });
  console.log(`\nrehearsed on ${diff.forkGraph} (deleted): ${diff.changes.length} changes`);
  for (const c of diff.changes) {
    console.log(
      `  ${c.entity.type}:${c.entity.key}${c.field ? `.${c.field}` : ''}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`,
    );
  }
}

if (!argv.includes('--dry')) {
  console.log('\nexecuting…');
  const res = await executeUndo(g, plan.id, {
    registry,
    paceMs: 500,
    onEvent: (e) => {
      if (e.type === 'undo.step' && e.status !== 'started')
        console.log(`  ${e.order}. ${e.status.padEnd(8)} ${e.label}`);
    },
  });
  console.log(`\nplan ${res.status}; undo run ${res.runId}`);
}
await closeDb();
