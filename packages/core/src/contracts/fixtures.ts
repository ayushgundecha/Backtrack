/** Shapes of the JSON fixtures in /fixtures. Replay mode feeds a RunFixture through the real recorder. */
import { z } from 'zod';
import { AgentId } from './types.js';

export const WorldSeed = z.object({
  customers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      tier: z.enum(['standard', 'gold']),
    }),
  ),
  orders: z.array(
    z.object({
      id: z.string(),
      customerId: z.string(),
      items: z.array(z.string()),
      total: z.number(),
      address: z.string(),
      status: z.enum(['processing', 'shipped', 'delivered']),
    }),
  ),
});
export type WorldSeed = z.infer<typeof WorldSeed>;

/** An argument value may reference an earlier step's result: { "$ref": "steps.2.result.id" }. */
export const ArgValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({ $ref: z.string() }),
]);

export const RunFixture = z.object({
  agentId: AgentId,
  goal: z.string(),
  steps: z.array(
    z.object({
      thought: z.string(),
      tool: z.string(),
      args: z.record(z.string(), ArgValue),
      /** Documentation only: what the demo expects the gate to do here. */
      expectGate: z.enum(['none', 'user-approval']).optional(),
    }),
  ),
});
export type RunFixture = z.infer<typeof RunFixture>;
