import { beforeEach, describe, expect, it } from 'vitest';
import { loadRunFixture } from '../src/agents/fixtures.js';
import { replayRun, resolveArgs } from '../src/agents/replay.js';
import { createToolRegistry } from '../src/agents/tools.js';
import { RunEvent } from '../src/contracts/events.js';
import { recordDecision } from '../src/sdk/gate.js';
import { getEntity } from '../src/world/store.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const registry = createToolRegistry();

describe('replay', () => {
  beforeEach(async () => {
    await fresh(g);
  });

  it('streams the contract events in order and pauses at the gate until a decision is in the graph', async () => {
    const events: RunEvent[] = [];
    const run = replayRun(g, loadRunFixture('ops-agent'), {
      registry,
      paceMs: 0,
      emit: (e) => {
        events.push(RunEvent.parse(e));
        // Approve from "elsewhere", the way /api/approval does: by writing to the graph.
        if (e.type === 'approval.requested') {
          setTimeout(() => void recordDecision(g, { actionId: e.actionId, approved: true }), 30);
        }
      },
    });
    const result = await run;
    expect(result.status).toBe('done');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.started');
    expect(types.at(-1)).toBe('run.finished');
    expect(types.filter((t) => t === 'step')).toHaveLength(6);
    expect(types.filter((t) => t === 'action.recorded')).toHaveLength(6);
    const gate = events.find((e) => e.type === 'approval.requested');
    expect(gate).toMatchObject({
      tool: 'send_email',
      reason: 'would lock in 3 reversible changes: update_address, create_ticket, post_message',
    });
    expect(types.indexOf('approval.resolved')).toBeGreaterThan(types.indexOf('approval.requested'));
    expect((await getEntity(g, 'order', 'ord_1001'))?.address).toBe(
      '221B Baker Street, London NW1 6XE',
    );
    expect(await getEntity(g, 'email', 'eml_1')).toMatchObject({ status: 'sent' });
  });

  it('a denial is recorded and the run carries on without sending', async () => {
    const result = await replayRun(g, loadRunFixture('ops-agent'), {
      registry,
      paceMs: 0,
      emit: () => undefined,
      awaitApproval: async () => false,
    });
    expect(result.status).toBe('done');
    expect(result.actions.map((a) => `${a.action.tool}:${a.action.status}`)).toContain(
      'send_email:denied',
    );
    expect(await getEntity(g, 'email', 'eml_1')).toBeNull();
  });

  it('resolves $ref arguments from earlier results and fails clearly when a step has none', () => {
    const results = [{ tickets: [{ id: 'tkt_1' }] }, undefined];
    expect(
      resolveArgs({ ticketId: { $ref: 'steps.0.result.tickets.0.id' }, n: 1 }, results),
    ).toEqual({ ticketId: 'tkt_1', n: 1 });
    expect(() => resolveArgs({ x: { $ref: 'steps.1.result.id' } }, results)).toThrow(/did not run/);
    expect(() => resolveArgs({ x: { $ref: 'nope.0' } }, results)).toThrow(/Bad \$ref/);
  });
});
