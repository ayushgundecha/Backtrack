/**
 * The world-tool catalogue in one registry: what the agents may call, plus the compensations the
 * undo engine resolves by the `inverse_tool` and `mitigation_tool` names stored on each Action.
 */
import { type AnyToolDefinition, ToolRegistry } from '../sdk/registry.js';
import { billingCompensations, billingTools } from './tools.billing.js';
import { opsCompensations, opsTools } from './tools.ops.js';

export const compensationTools: AnyToolDefinition[] = [
  ...opsCompensations,
  ...billingCompensations,
];

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry([...opsTools, ...billingTools, ...compensationTools]);
}
