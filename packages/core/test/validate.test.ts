import { beforeAll, describe, expect, it } from 'vitest';
import { createToolRegistry } from '../src/agents/tools.js';
import type { UndoOutcome } from '../src/contracts/types.js';
import { planUndo } from '../src/sdk/undo.js';
import { templateSummary, validateSummary } from '../src/sdk/validate.js';
import { buildGolden } from './golden.js';
import { fresh, testGraph } from './helpers.js';

const g = testGraph();
const registry = createToolRegistry();
const toolNames = registry.list().map((t) => t.name);
let outcome: Extract<UndoOutcome, { kind: 'plan' }>;
let id: Record<string, string>;

describe('validateSummary', () => {
  beforeAll(async () => {
    await fresh(g);
    id = await buildGolden(g);
    const res = await planUndo(g, { actionId: id.update_address, depth: 3 }, { registry });
    if (res.outcome.kind !== 'plan') throw new Error('expected a plan');
    outcome = res.outcome;
  });

  it("keeps a model's paraphrase when every id, tool and count is in the outcome", () => {
    const text = `Undoing ${id.update_address} takes 6 steps at depth 3: revoke cr_1, cancel evt_1, a correction draft for eml_1 instead of unsending send_email, then delete msg_1, close tkt_1 and restore ord_1001.`;
    expect(validateSummary(text, outcome, toolNames)).toEqual({ text, valid: true, problems: [] });
  });

  it('rejects an invented action id and falls back to the row-built plan summary', () => {
    const check = validateSummary('Undo act_zz99zz99 in 6 steps.', outcome, toolNames);
    expect(check).toEqual({
      text: outcome.plan.summary,
      valid: false,
      problems: ['act_zz99zz99 is not in the outcome'],
    });
  });

  it('rejects a near-miss entity key (tkt_12 is not tkt_1) and wrong counts', () => {
    const check = validateSummary('Closes tkt_12 in 4 steps at depth 5.', outcome, toolNames);
    expect(check.valid).toBe(false);
    expect(check.problems).toEqual([
      'tkt_12 is not in the outcome',
      'the plan has 6 steps, not 4',
      "the plan's depth is 3, not 5",
    ]);
  });

  it('rejects a tool the plan does not touch', () => {
    // lookup_order is a real tool, but a read-only one that is not part of this plan.
    const check = validateSummary('This also reverts lookup_order.', outcome, toolNames);
    expect(check.problems).toEqual(['lookup_order is not in the outcome']);
  });

  it('an empty answer gets the template for every outcome kind', () => {
    const unknown: UndoOutcome = {
      kind: 'unknown',
      query: 'undo the weather',
      candidates: [
        { id: 'act_aaaa1111', tool: 'apply_credit', seq: 9, label: 'apply_credit(tkt_1)' },
      ],
    };
    expect(validateSummary('  ', unknown)).toEqual({
      text: 'I could not tell which action "undo the weather" means. Closest: apply_credit(tkt_1) (seq 9, act_aaaa1111).',
      valid: false,
      problems: ['the summary is empty'],
    });
    const none: UndoOutcome = {
      kind: 'none',
      actionId: 'act_x',
      reason: 'lookup_order only read.',
    };
    expect(templateSummary(none)).toBe('lookup_order only read.');
  });
});
