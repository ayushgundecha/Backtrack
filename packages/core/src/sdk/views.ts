/**
 * Read models for the panel, the API routes and the graph tools: graph rows in contract shape.
 *
 * Every function here is a thin mapping over named queries (V1, V3, V4, Q6), so the routes stay
 * free of Cypher and what the UI draws is exactly what the graph returned.
 */
import type { z } from 'zod';
import type { api } from '../contracts/api.js';
import {
  type ActionRecord,
  type EffectRecord,
  type Explain,
  GraphLink,
  GraphNode,
  type GraphSnapshot,
} from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';
import { parseJson } from '../graph/cypher.js';
import {
  type ActionRow,
  graphLinks,
  graphNodes,
  listActions,
  q6Explain,
} from '../graph/queries.js';
import { worldSnapshot } from '../world/store.js';
import { displayOf } from '../world/types.js';
import { labelOf } from './resolve.js';

type NodeProps = Partial<Record<string, unknown>>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** The caption a node gets in the graph view: what a person would call it. */
function titleOf(label: string, id: string, p: NodeProps): string {
  switch (label) {
    case 'Action':
      return str(p.tool) ?? id;
    case 'Entity':
      return str(p.display) ?? id;
    case 'Agent':
    case 'User':
      return str(p.name) ?? id;
    case 'Run':
      return str(p.goal) ?? id;
    case 'UndoPlan':
      return str(p.summary) ?? id;
    case 'Policy':
      return str(p.rule) ?? id;
    default:
      return id;
  }
}

/** V3 + V4: nodes and links for the force graph (Steps and Effects collapsed by the queries). */
export async function graphSnapshot(g: TenantGraph): Promise<GraphSnapshot> {
  const [nodes, links] = await Promise.all([graphNodes(g, {}), graphLinks(g, {})]);
  return {
    nodes: nodes.rows.map((r) => {
      const p: NodeProps = r.props ?? {};
      return GraphNode.parse({
        id: r.id,
        label: r.label,
        title: titleOf(r.label, r.id, p),
        status: str(p.status),
        tool: str(p.tool),
        kind: str(p.kind),
        seq: typeof p.seq === 'number' ? p.seq : undefined,
        agentId: str(p.agentId),
        runId: str(p.runId),
        reversible: typeof p.reversible === 'boolean' ? p.reversible : undefined,
      });
    }),
    links: links.rows.map((r) =>
      GraphLink.parse({
        source: r.source,
        target: r.target,
        type: r.type,
        order: r.order ?? undefined,
      }),
    ),
  };
}

export type ActionsView = z.infer<typeof api.actions.response>;

/** V1: every recorded action in order, with the label the panel and the agents use. */
export async function actionsView(g: TenantGraph): Promise<ActionsView> {
  const { rows } = await listActions(g, {});
  return {
    actions: rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      tool: r.tool,
      status: r.status,
      agentId: r.agentId,
      label: labelOf(r),
    })),
  };
}

/** An ActionRow (args and result stored as canonical JSON) in contract shape. */
export function toActionRecord(r: ActionRow): ActionRecord {
  return {
    id: r.id,
    seq: r.seq,
    tool: r.tool,
    args: parseJson<Record<string, unknown>>(r.args) ?? {},
    result: parseJson(r.result),
    ts: r.ts,
    kind: r.kind as ActionRecord['kind'],
    reversible: r.reversible,
    inverseTool: r.inverseTool,
    mitigationTool: r.mitigationTool,
    status: r.status as ActionRecord['status'],
    runId: r.runId,
    stepId: r.stepId,
    agentId: r.agentId,
  };
}

/**
 * Q6 plus "what did it see": each read entity's state just before the action ran, folded back
 * from the Effects (the same fold as the time scrubber), next to who last wrote it.
 * Returns null for an id the graph does not know.
 */
export async function explainAction(g: TenantGraph, actionId: string): Promise<Explain | null> {
  const res = await q6Explain(g, { actionId });
  const row = res.rows[0];
  if (!row) return null;
  const before = row.reads.length ? await worldSnapshot(g, row.seq - 1) : null;
  const stateOf = (entity: string) =>
    before?.entities.find((e) => `${e.type}:${e.key}` === entity)?.state ?? null;

  return {
    action: toActionRecord(row),
    thought: row.thought,
    reads: row.reads.map((r) => ({
      entity: r.entity,
      saw: stateOf(r.entity),
      writtenBy: r.writerId,
      writtenAtSeq: r.writerSeq,
    })),
    effects: row.effects.map(
      (f): EffectRecord => ({
        id: f.id ?? '',
        actionId: row.id,
        seq: row.seq,
        ts: f.ts ?? row.ts,
        kind: (f.kind ?? 'update') as EffectRecord['kind'],
        entity: {
          type: f.type ?? '',
          key: f.key ?? '',
          display: f.display ?? displayOf(f.type ?? '', f.key ?? ''),
        },
        field: f.field,
        before: parseJson(f.before),
        after: parseJson(f.after),
      }),
    ),
    dependsOn: row.dependsOn,
    dependedOnBy: row.dependedOnBy,
    trace: { cypher: res.cypher, params: res.params, ms: res.ms, rows: res.rows.length },
  };
}
