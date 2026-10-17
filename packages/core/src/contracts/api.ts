/**
 * HTTP contract for apps/web. Every route validates its input and output with these schemas.
 * SSE routes stream `RunEvent` JSON objects, one per `data:` line.
 */
import { z } from 'zod';
import {
  AgentId,
  Explain,
  GraphSnapshot,
  Policy,
  RehearsalDiff,
  RunMode,
  UndoOutcome,
  UndoPlan,
  WorldSnapshot,
} from './types.js';

export const TenantQuery = z.object({ tenant: z.string().default('demo') });

export const api = {
  /** GET /api/graph?tenant= */
  graph: { query: TenantQuery, response: GraphSnapshot },
  /** GET /api/world?tenant=&asOfSeq= (asOfSeq folds Effects up to that seq: the time scrubber) */
  world: {
    query: TenantQuery.extend({ asOfSeq: z.coerce.number().int().optional() }),
    response: WorldSnapshot,
  },
  /** GET /api/actions?tenant= */
  actions: {
    query: TenantQuery,
    response: z.object({
      actions: z.array(
        z.object({
          id: z.string(),
          seq: z.number().int(),
          tool: z.string(),
          status: z.string(),
          agentId: z.string(),
          label: z.string(),
        }),
      ),
    }),
  },
  /** GET /api/explain?tenant=&actionId= */
  explain: { query: TenantQuery.extend({ actionId: z.string() }), response: Explain },
  /** POST /api/reset { tenant, token } → drops and reseeds the tenant graph */
  reset: {
    body: z.object({ tenant: z.string().default('demo'), token: z.string() }),
    response: z.object({ ok: z.boolean(), seededAt: z.number() }),
  },
  /** POST /api/agent { tenant, agent, mode, goal? } → SSE of RunEvent */
  agent: {
    body: z.object({
      tenant: z.string().default('demo'),
      agent: AgentId,
      mode: RunMode,
      goal: z.string().optional(),
    }),
  },
  /** POST /api/approval { tenant, runId, actionId, approved } → resumes a paused run */
  approval: {
    body: z.object({
      tenant: z.string().default('demo'),
      runId: z.string(),
      actionId: z.string(),
      approved: z.boolean(),
    }),
    response: z.object({ ok: z.boolean() }),
  },
  /** POST /api/undo { tenant, text | actionId, depth? } → UndoOutcome (plan is proposed, not executed) */
  undo: {
    body: z.object({
      tenant: z.string().default('demo'),
      text: z.string().optional(),
      actionId: z.string().optional(),
      depth: z.number().int().min(1).max(10).default(5),
    }),
    response: UndoOutcome,
  },
  /** POST /api/undo/execute { tenant, planId, confirmed:true } → SSE of undo.step / undo.finished */
  undoExecute: {
    body: z.object({
      tenant: z.string().default('demo'),
      planId: z.string(),
      confirmed: z.literal(true),
    }),
  },
  /** POST /api/rehearse { tenant, planId } → diff computed on a GRAPH.COPY fork, fork deleted afterwards */
  rehearse: {
    body: z.object({ tenant: z.string().default('demo'), planId: z.string() }),
    response: RehearsalDiff,
  },
  /** GET /api/plan?tenant=&planId= */
  plan: { query: TenantQuery.extend({ planId: z.string() }), response: UndoPlan },
  /** POST /api/policy { tenant, rule, kind, tool?, agentId?, entity?, createdFromPlanId? } */
  policy: {
    body: Policy.omit({ id: true, ts: true }).extend({ tenant: z.string().default('demo') }),
    response: Policy,
  },
  /** GET /api/algo?tenant=&name=load_bearing|hinge_actions|independent_clusters|path_between&from=&to= */
  algo: {
    query: TenantQuery.extend({
      name: z.enum(['load_bearing', 'hinge_actions', 'independent_clusters', 'path_between']),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
    response: z.object({
      rows: z.array(z.record(z.string(), z.unknown())),
      cypher: z.string(),
      ms: z.number(),
    }),
  },
} as const;
