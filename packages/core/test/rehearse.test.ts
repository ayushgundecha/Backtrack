import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RehearsalDiff } from '../src/contracts/types.js';
import { listGraphs } from '../src/graph/client.js';
import { getPlan, q15PlanEntities } from '../src/graph/queries.js';
import { defineTool, ToolRegistry } from '../src/sdk/registry.js';
import { diffStates, rehearseUndo } from '../src/sdk/rehearse.js';
import { executeUndo, planUndo } from '../src/sdk/undo.js';
import { worldSnapshot } from '../src/world/store.js';
import { buildGolden } from './golden.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();

const registry = new ToolRegistry([
  defineTool({
    name: 'draft_correction_email',
    description: 'Draft a correction.',
    input: z.object({ actionId: z.string() }),
    effect: 'compensation',
    run: async () => ({
      result: null,
      reads: [],
      writes: [
        {
          kind: 'create',
          entity: { type: 'email', key: 'eml_2' },
          field: null,
          before: null,
          after: { id: 'eml_2', status: 'draft' },
        },
      ],
    }),
  }),
]);

async function planId() {
  const { outcome } = await planUndo(
    g,
    { text: 'undo the address change', depth: 3 },
    { registry },
  );
  if (outcome.kind !== 'plan') throw new Error('expected a plan');
  return outcome.plan.id;
}

describe('rehearseUndo', () => {
  beforeEach(async () => {
    await fresh(g);
    await buildGolden(g);
  });

  it('runs the plan on a GRAPH.COPY fork, leaves live untouched and deletes the fork', async () => {
    const id = await planId();
    const before = await worldSnapshot(g);
    const diff = await rehearseUndo(g, id, { registry });
    RehearsalDiff.parse(diff);
    expect(diff.forkGraph).toBe(`${g.name}:fork:${id}`);
    expect(diff.status).toBe('executed');
    expect((await worldSnapshot(g)).entities).toEqual(before.entities);
    expect(await listGraphs()).not.toContain(diff.forkGraph);
    expect((await getPlan(g, { planId: id })).rows[0]?.status).toBe('rehearsed');
    expect(diff.changes).toContainEqual({
      entity: { type: 'order', key: 'ord_1001', display: 'order ord_1001' },
      field: 'address',
      from: '221B Baker Street, London NW1 6XE',
      to: '14 Marine Drive, Mumbai 400020',
    });
    expect(diff.changes.find((c) => c.entity.key === 'eml_2')).toMatchObject({
      field: null,
      from: null,
    });
  });

  it('predicts exactly the change the real execution then makes', async () => {
    const id = await planId();
    const rehearsal = await rehearseUndo(g, id, { registry });
    const liveBefore = await q15PlanEntities(g, { planId: id });
    await executeUndo(g, id, { registry });
    const liveAfter = await q15PlanEntities(g, { planId: id });
    expect(diffStates(liveBefore.rows, liveAfter.rows)).toEqual(rehearsal.changes);
  });
});
