/**
 * `defineTool`: how a tool tells Backtrack what it is.
 *
 * A tool implementation computes `{ result, reads, writes }` from the world and never writes the
 * world itself; the recorder applies the writes in the same statement that records the action.
 * That is what makes reads and writes trustworthy: they come from the implementation, not from
 * arguments a model supplied (AGENTS.md rule 2).
 *
 * Every tool declares exactly one effect class. A reversible tool names its inverse (undo is a
 * restore of each Effect's `before`; the inverse name labels that step). An irreversible tool
 * names the mitigation the undo engine runs instead. The two are mutually exclusive by type, and
 * `defineTool` re-checks at runtime for callers that bypass the types.
 */
import { type Tool, tool } from 'ai';
import type { z } from 'zod';
import type { EffectDraft, EntityRef, ToolResult } from '../contracts/types.js';
import type { TenantGraph } from '../graph/client.js';

export interface ToolContext {
  g: TenantGraph;
  agentId: string;
  runId: string;
}

/** A ToolResult whose `result` is typed by the tool. */
export interface TypedToolResult<R> extends ToolResult {
  result: R;
  reads: EntityRef[];
  writes: EffectDraft[];
}

export type EffectClass =
  /** Reads only; nothing to undo. */
  | { effect: 'read' }
  /** Changes internal state; undone by restoring `before`. `undoMode` picks the plan step mode. */
  | { effect: 'reversible'; inverse: string; undoMode: 'restore' | 'inverse' }
  /** Has an external effect that cannot be taken back; the undo engine runs `mitigation`. */
  | { effect: 'irreversible'; mitigation: string }
  /** Only ever run by the undo engine as the compensation for an irreversible action. */
  | { effect: 'mitigation' };

export type ToolDefinition<I extends z.ZodType = z.ZodType, R = unknown> = EffectClass & {
  name: string;
  description: string;
  input: I;
  run(ctx: ToolContext, input: z.infer<I>): Promise<TypedToolResult<R>>;
};

/** Any tool, for registries and loops that do not care about the input type. */
// biome-ignore lint/suspicious/noExplicitAny: a registry holds tools of every input type.
export type AnyToolDefinition = ToolDefinition<any, unknown>;

export function defineTool<I extends z.ZodType, R>(
  def: ToolDefinition<I, R>,
): ToolDefinition<I, R> {
  const loose = def as Partial<Record<'inverse' | 'mitigation', unknown>> & { effect: string };
  const hasInverse = typeof loose.inverse === 'string' && loose.inverse.length > 0;
  const hasMitigation = typeof loose.mitigation === 'string' && loose.mitigation.length > 0;
  const ok =
    (def.effect === 'reversible' && hasInverse && !hasMitigation) ||
    (def.effect === 'irreversible' && hasMitigation && !hasInverse) ||
    ((def.effect === 'read' || def.effect === 'mitigation') && !hasInverse && !hasMitigation);
  if (!ok) {
    throw new Error(
      `defineTool(${def.name}): a tool is either reversible (with an inverse) or irreversible (with a mitigation), not both or neither`,
    );
  }
  return def;
}

/** The Action properties a tool's effect class implies. */
export function actionFlags(def: AnyToolDefinition): {
  reversible: boolean;
  inverseTool: string | null;
  mitigationTool: string | null;
} {
  switch (def.effect) {
    case 'reversible':
      return { reversible: true, inverseTool: def.inverse, mitigationTool: null };
    case 'irreversible':
      return { reversible: false, inverseTool: null, mitigationTool: def.mitigation };
    default:
      return { reversible: true, inverseTool: null, mitigationTool: null };
  }
}

/** A name → definition lookup; replay, the agents and the undo engine all resolve tools here. */
export class ToolRegistry {
  private readonly byName = new Map<string, AnyToolDefinition>();

  constructor(defs: AnyToolDefinition[] = []) {
    for (const d of defs) this.add(d);
  }

  add(def: AnyToolDefinition): this {
    if (this.byName.has(def.name)) throw new Error(`Tool ${def.name} is defined twice`);
    this.byName.set(def.name, def);
    return this;
  }

  get(name: string): AnyToolDefinition {
    const def = this.byName.get(name);
    if (!def) throw new Error(`Unknown tool: ${name}`);
    return def;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.byName.values()];
  }
}

/**
 * Convert a definition into an AI SDK tool. The zod schema becomes the model-facing input schema;
 * `execute` is supplied by the caller (the Backtrack wrapper), which records and gates the call.
 */
export function toAiTool<I extends z.ZodType, R>(
  def: ToolDefinition<I, R>,
  execute: (input: z.infer<I>) => Promise<unknown>,
): Tool<z.infer<I>, unknown> {
  return tool({
    description: def.description,
    inputSchema: def.input,
    execute: (input: z.infer<I>) => execute(input),
  }) as Tool<z.infer<I>, unknown>;
}
