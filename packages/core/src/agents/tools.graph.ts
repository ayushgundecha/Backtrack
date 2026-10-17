/**
 * Graph tools: what the undo agent and the MCP server can ask the graph. One definition serves
 * both, so a model in the panel and Claude Desktop over MCP see the same names and schemas.
 *
 * Why flat schemas: free models fill nested objects and arrays unreliably. Every input here is
 * an object of strings, numbers, booleans and enums, and ids are checked against the graph
 * (resolve_action) before anything is planned. The model never writes Cypher; every answer
 * carries the named queries that produced it, so the agent can cite its evidence.
 */
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { TenantGraph } from '../graph/client.js';
import {
  q3BlastRadius,
  q8LoadBearing,
  q9Hinges,
  q10Clusters,
  q11PathBetween,
  q12EntityHistory,
  q13Recall,
} from '../graph/queries.js';
import { PolicyError, setPolicy } from '../sdk/policies.js';
import type { ToolRegistry } from '../sdk/registry.js';
import { rehearseUndo } from '../sdk/rehearse.js';
import { resolveAction } from '../sdk/resolve.js';
import { type QueryTrace, traceOf } from '../sdk/trace.js';
import { executeUndo, loadPlan, planUndo } from '../sdk/undo.js';
import { actionsView, explainAction } from '../sdk/views.js';

export interface GraphToolContext {
  g: TenantGraph;
  registry: ToolRegistry;
  /** The human on whose behalf plans and policies are recorded. */
  userId?: string;
  /** Pacing between executed undo steps (the panel streams; agents and tests use 0). */
  paceMs?: number;
}

export interface GraphToolAnswer {
  result: unknown;
  /** The named queries behind the answer, with their Cypher, timing and row counts. */
  traces: QueryTrace[];
}

/** A request the graph cannot answer as asked (unknown plan, missing scope): told to the caller. */
export class GraphToolError extends Error {
  override name = 'GraphToolError';
}

export interface GraphTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  run: (ctx: GraphToolContext, input: z.infer<S>) => Promise<GraphToolAnswer>;
}

const graphTool = <S extends z.ZodObject>(t: GraphTool<S>) => t as unknown as GraphTool;

const actionId = z.string().describe('An action id from list_actions, e.g. act_ab12cd34');
const planId = z.string().describe('An undo plan id returned by plan_undo, e.g. plan_ab12cd34');
const limit = z.number().int().min(1).max(25).default(5).describe('How many actions to return');

async function requirePlan(ctx: GraphToolContext, id: string) {
  const plan = await loadPlan(ctx.g, id);
  if (!plan) throw new GraphToolError(`No undo plan ${id}; call plan_undo first`);
  return plan;
}

export const listActionsTool = graphTool({
  name: 'list_actions',
  description:
    'List every recorded agent action in order: id, seq, tool, status, agent and a short label.',
  input: z.object({
    agentId: z.enum(['ops-agent', 'billing-agent', 'backtrack']).optional(),
  }),
  run: async (ctx, { agentId }) => {
    const view = await actionsView(ctx.g);
    const actions = agentId ? view.actions.filter((a) => a.agentId === agentId) : view.actions;
    return { result: { actions }, traces: [] };
  },
});

export const resolveActionTool = graphTool({
  name: 'resolve_action',
  description:
    'Find the recorded action a request refers to, by id or by words ("the address change"). Returns the action, or up to three candidates when the request does not single one out.',
  input: z.object({
    text: z.string().optional().describe('What the person said, e.g. "undo the address change"'),
    actionId: actionId.optional(),
  }),
  run: async (ctx, input) => {
    const r = await resolveAction(ctx.g, input);
    const action = r.action && {
      id: r.action.id,
      seq: r.action.seq,
      tool: r.action.tool,
      status: r.action.status,
      kind: r.action.kind,
      agentId: r.action.agentId,
    };
    return { result: { action, candidates: r.candidates }, traces: [r.trace] };
  },
});

export const planUndoTool = graphTool({
  name: 'plan_undo',
  description:
    'Propose (never execute) an undo for an action: everything downstream of it up to `depth` hops, in reverse dependency order. Answers one of four outcomes: plan, memory (already undone), none (nothing to undo), unknown (with candidates).',
  input: z.object({
    actionId: actionId.optional(),
    text: z.string().optional().describe('The request in words, if there is no id'),
    depth: z.number().int().min(1).max(10).default(5).describe('Hops of DEPENDS_ON to follow'),
  }),
  run: async (ctx, { actionId: id, text, depth }) => {
    if (!id && !text?.trim()) throw new GraphToolError('Give an actionId or the request text');
    const { outcome, traces } = await planUndo(
      ctx.g,
      { actionId: id ?? null, text: text ?? null, depth, userId: ctx.userId ?? 'ayush' },
      { registry: ctx.registry },
    );
    return { result: outcome, traces };
  },
});

export const rehearseUndoTool = graphTool({
  name: 'rehearse_undo',
  description:
    'Run an undo plan on a throwaway copy of the graph (GRAPH.COPY) and return what would change, field by field. The live graph is not touched.',
  input: z.object({ planId }),
  run: async (ctx, { planId: id }) => {
    await requirePlan(ctx, id);
    const { traces, ...diff } = await rehearseUndo(ctx.g, id, { registry: ctx.registry });
    return { result: diff, traces };
  },
});

export const executeUndoTool = graphTool({
  name: 'execute_undo',
  description:
    'Execute an undo plan for real. Only call this after the person has confirmed the plan; `confirmed` must be true.',
  input: z.object({
    planId,
    confirmed: z.literal(true).describe('The person explicitly confirmed this plan'),
  }),
  run: async (ctx, { planId: id }) => {
    await requirePlan(ctx, id);
    const res = await executeUndo(ctx.g, id, { registry: ctx.registry, paceMs: ctx.paceMs ?? 0 });
    const steps = res.events.flatMap((e) =>
      e.type === 'undo.step' && e.status !== 'started'
        ? [{ order: e.order, label: e.label, status: e.status }]
        : [],
    );
    return { result: { planId: id, status: res.status, steps }, traces: [] };
  },
});

export const explainActionTool = graphTool({
  name: 'explain_action',
  description:
    'Explain one action from the graph: the thought behind it, what it read (and who wrote that), what it changed, what it depends on and what depends on it.',
  input: z.object({ actionId }),
  run: async (ctx, { actionId: id }) => {
    const explain = await explainAction(ctx.g, id);
    if (!explain) throw new GraphToolError(`No action ${id}; call list_actions for valid ids`);
    const { trace, ...rest } = explain;
    return {
      result: rest,
      traces: [{ query: 'Q6', cypher: trace.cypher, ms: trace.ms, rows: trace.rows }],
    };
  },
});

export const entityHistoryTool = graphTool({
  name: 'entity_history',
  description:
    'Every change ever made to one entity (order, ticket, message, email, event, credit), oldest first, with the action and agent behind each.',
  input: z.object({
    entityType: z.enum(['customer', 'order', 'ticket', 'message', 'event', 'email', 'credit']),
    entityKey: z.string().describe('e.g. ord_1001, tkt_1'),
  }),
  run: async (ctx, { entityType, entityKey }) => {
    const res = await q12EntityHistory(ctx.g, { type: entityType, key: entityKey });
    return { result: { history: res.rows }, traces: [traceOf('Q12', res)] };
  },
});

export const recallTool = graphTool({
  name: 'recall',
  description:
    'Have we undone this action, this tool, or changes to this entity before, and is there a policy about it? Call this before acting or planning.',
  input: z.object({
    actionId: actionId.optional(),
    tool: z.string().optional().describe('A tool name, e.g. update_address'),
    entityType: z.string().optional(),
    entityKey: z.string().optional(),
  }),
  run: async (ctx, input) => {
    const res = await q13Recall(ctx.g, {
      actionId: input.actionId ?? null,
      tool: input.tool ?? null,
      type: input.entityType ?? null,
      key: input.entityKey ?? null,
    });
    return { result: { memories: res.rows }, traces: [traceOf('Q13', res)] };
  },
});

export const blastRadiusTool = graphTool({
  name: 'blast_radius',
  description:
    'How big undoing an action would be: how many actions depend on it within `depth` hops, how many of those are irreversible, and which entities they touched.',
  input: z.object({
    actionId,
    depth: z.number().int().min(1).max(10).default(5).describe('Hops of DEPENDS_ON to follow'),
  }),
  run: async (ctx, { actionId: id, depth }) => {
    const res = await q3BlastRadius(ctx.g, { actionId: id }, { depth });
    const row = res.rows[0];
    // The root itself always counts, so zero actions means the id is not in the graph.
    if (!row?.actions) throw new GraphToolError(`No action ${id}; call list_actions for valid ids`);
    return { result: { ...row, depth }, traces: [traceOf('Q3', res)] };
  },
});

export const loadBearingTool = graphTool({
  name: 'load_bearing',
  description:
    'The actions the most other work rests on (PageRank over DEPENDS_ON). Undoing these has the widest consequences.',
  input: z.object({ limit }),
  run: async (ctx, input) => {
    const res = await q8LoadBearing(ctx.g, { limit: input.limit });
    return { result: { actions: res.rows }, traces: [traceOf('Q8', res)] };
  },
});

export const hingeActionsTool = graphTool({
  name: 'hinge_actions',
  description:
    'The actions that sit on the most dependency paths between other actions (betweenness centrality).',
  input: z.object({ limit }),
  run: async (ctx, input) => {
    const res = await q9Hinges(ctx.g, { limit: input.limit });
    return { result: { actions: res.rows }, traces: [traceOf('Q9', res)] };
  },
});

export const independentClustersTool = graphTool({
  name: 'independent_clusters',
  description:
    'Groups of actions that do not depend on each other (weakly connected components): undoing one group cannot affect another.',
  input: z.object({}),
  run: async (ctx) => {
    const res = await q10Clusters(ctx.g, {});
    return { result: { clusters: res.rows }, traces: [traceOf('Q10', res)] };
  },
});

export const pathBetweenTool = graphTool({
  name: 'path_between',
  description:
    'How a later action came to depend on an earlier one: the shortest DEPENDS_ON path between them.',
  input: z.object({
    fromActionId: actionId.describe('The earlier action'),
    toActionId: actionId.describe('The later action'),
  }),
  run: async (ctx, { fromActionId, toActionId }) => {
    const res = await q11PathBetween(ctx.g, { from: fromActionId, to: toActionId });
    return { result: { path: res.rows[0] ?? null }, traces: [traceOf('Q11', res)] };
  },
});

export const setPolicyTool = graphTool({
  name: 'set_policy',
  description:
    'Record a "never again" rule the gate enforces before every later tool call: block, confirm or warn, for a tool and/or an entity, optionally for one agent.',
  input: z.object({
    rule: z.string().min(1).describe('The rule in plain words, shown when it fires'),
    kind: z.enum(['block', 'confirm', 'warn']),
    tool: z.string().optional().describe('The tool it applies to, e.g. update_address'),
    agentId: z.enum(['ops-agent', 'billing-agent']).optional(),
    entityType: z.string().optional(),
    entityKey: z.string().optional(),
    fromPlanId: planId.optional().describe('The undo plan that prompted this rule'),
  }),
  run: async (ctx, input) => {
    if (!input.entityType !== !input.entityKey) {
      throw new GraphToolError('Give both entityType and entityKey, or neither');
    }
    const policy = await setPolicy(
      ctx.g,
      {
        rule: input.rule,
        kind: input.kind,
        tool: input.tool ?? null,
        agentId: input.agentId ?? null,
        entity:
          input.entityType && input.entityKey
            ? { type: input.entityType, key: input.entityKey }
            : null,
        createdFromPlanId: input.fromPlanId ?? null,
      },
      { userId: ctx.userId },
    );
    return { result: policy, traces: [] };
  },
});

export const graphTools: GraphTool[] = [
  listActionsTool,
  resolveActionTool,
  planUndoTool,
  rehearseUndoTool,
  executeUndoTool,
  explainActionTool,
  entityHistoryTool,
  recallTool,
  blastRadiusTool,
  loadBearingTool,
  hingeActionsTool,
  independentClustersTool,
  pathBetweenTool,
  setPolicyTool,
];

export type GraphToolOutcome =
  | { ok: true; result: unknown; traces: QueryTrace[] }
  | { ok: false; error: string };

/**
 * Validate the arguments and run one graph tool. Bad arguments and requests the graph cannot
 * answer come back as `{ ok: false, error }` with a message the model can act on, never thrown:
 * the AI SDK and MCP adapters pass that message straight back to the model.
 */
export async function runGraphTool(
  ctx: GraphToolContext,
  name: string,
  rawArgs: unknown,
): Promise<GraphToolOutcome> {
  const def = graphTools.find((t) => t.name === name);
  if (!def) return { ok: false, error: `Unknown tool ${name}` };
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
    return { ok: false, error: `Invalid arguments for ${name}: ${issues.join('; ')}` };
  }
  try {
    const { result, traces } = await def.run(ctx, parsed.data);
    return { ok: true, result, traces };
  } catch (err) {
    if (err instanceof GraphToolError || err instanceof PolicyError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/**
 * The named graph tools as AI SDK tools. A failed call answers `{ error }` so the model can
 * correct itself; `onAnswer` sees every outcome (the undo agent keeps the last plan_undo result).
 */
export function aiGraphTools(
  ctx: GraphToolContext,
  names: readonly string[],
  onAnswer?: (name: string, outcome: GraphToolOutcome) => void,
): ToolSet {
  const tools: ToolSet = {};
  for (const name of names) {
    const def = graphTools.find((t) => t.name === name);
    if (!def) throw new Error(`Unknown graph tool ${name}`);
    tools[name] = tool({
      description: def.description,
      inputSchema: def.input,
      execute: async (args: unknown) => {
        const out = await runGraphTool(ctx, name, args);
        onAnswer?.(name, out);
        return out.ok ? out.result : { error: out.error };
      },
    });
  }
  return tools;
}
