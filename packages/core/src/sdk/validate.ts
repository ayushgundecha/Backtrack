/**
 * validateSummary: a model may phrase the answer to an undo request, but it may not invent it.
 *
 * Why check instead of trusting the prompt: free models misread ids and counts, and the panel
 * promises that nothing on screen claims what the graph cannot back. So every id, entity key and
 * tool name in the model's sentence must appear in the outcome the graph returned, and every
 * "N steps" / "depth N" must match it. One miss and the sentence is replaced by a template built
 * only from the outcome's rows.
 */
import type { UndoOutcome } from '../contracts/types.js';

export interface SummaryCheck {
  /** The text to show: the model's when it holds up, otherwise the row-built template. */
  text: string;
  valid: boolean;
  /** What did not hold up, e.g. `act_zz99 is not in the outcome` (empty when valid). */
  problems: string[];
}

// Ids Backtrack mints (act_/plan_/pol_/run_/stp_ + 8 chars) and the world's entity keys.
const ID = /\b(?:act|plan|pol|run|stp)_[a-z0-9]{8}\b|\b(?:cust|ord|tkt|msg|evt|eml|cr)_\d+\b/g;
const STEPS = /\b(\d+)\s+(?:undo\s+)?steps?\b/gi;
const DEPTH = /\bdepth\s+(?:of\s+)?(\d+)\b/gi;

/** The sentence the panel shows when the model's does not hold up. */
export function templateSummary(outcome: UndoOutcome): string {
  switch (outcome.kind) {
    case 'plan':
      return outcome.plan.summary;
    case 'memory': {
      const [last] = outcome.priorPlans;
      return last
        ? `Already undone: plan ${last.id} (${last.status}) on ${new Date(last.ts).toISOString()}. ${last.summary}`
        : `${outcome.actionId} is already undone.`;
    }
    case 'none':
      return outcome.reason;
    case 'unknown':
      return outcome.candidates.length
        ? `I could not tell which action "${outcome.query}" means. Closest: ${outcome.candidates
            .map((c) => `${c.label} (seq ${c.seq}, ${c.id})`)
            .join('; ')}.`
        : `I could not find an action matching "${outcome.query}"; nothing has been recorded yet.`;
  }
}

/**
 * Check a model's summary of an undo outcome. `knownTools` are the tool names the model could
 * mention (the registry); any of them in the text must also be in the outcome.
 */
export function validateSummary(
  text: string | null | undefined,
  outcome: UndoOutcome,
  knownTools: readonly string[] = [],
): SummaryCheck {
  const evidence = JSON.stringify(outcome);
  // Whole-word match, so tkt_1 in the outcome does not vouch for tkt_12 in the text.
  const inEvidence = (word: string) => new RegExp(`\\b${word}\\b`).test(evidence);
  const problems: string[] = [];
  const said = text?.trim() ?? '';
  if (!said) problems.push('the summary is empty');

  for (const id of new Set(said.match(ID) ?? [])) {
    if (!inEvidence(id)) problems.push(`${id} is not in the outcome`);
  }
  for (const tool of knownTools) {
    if (new RegExp(`\\b${tool}\\b`).test(said) && !inEvidence(tool)) {
      problems.push(`${tool} is not in the outcome`);
    }
  }
  if (outcome.kind === 'plan') {
    const { steps, depth } = outcome.plan;
    for (const [, n] of said.matchAll(STEPS)) {
      if (Number(n) !== steps.length) problems.push(`the plan has ${steps.length} steps, not ${n}`);
    }
    for (const [, n] of said.matchAll(DEPTH)) {
      if (Number(n) !== depth) problems.push(`the plan's depth is ${depth}, not ${n}`);
    }
  }

  return problems.length
    ? { text: templateSummary(outcome), valid: false, problems }
    : { text: said, valid: true, problems };
}
