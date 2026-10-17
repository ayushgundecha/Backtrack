/**
 * Backtrack over MCP: the same graph tools the undo agent uses, for any MCP client.
 *
 * Why expose the tools rather than a chat endpoint: Claude Desktop or Cursor already is the
 * agent. It gets the fixed tool catalogue (it never writes Cypher), every answer carries the
 * named queries that produced it, and execute_undo still demands `confirmed: true`.
 */
import { type GraphToolContext, graphTools, runGraphTool } from '@backtrack/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_INFO = { name: 'backtrack', version: '0.1.0' } as const;

/** Tools that change the graph or the world; MCP clients use the hint to ask before calling. */
const WRITES = new Set(['execute_undo', 'set_policy', 'plan_undo', 'rehearse_undo']);

export function createServer(ctx: GraphToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Backtrack records what AI agents did in a FalkorDB graph and undoes it with its consequences. Start with list_actions or plan_undo; never call execute_undo unless the person confirmed that exact plan.',
  });
  for (const def of graphTools) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: !WRITES.has(def.name),
          destructiveHint: def.name === 'execute_undo',
        },
      },
      async (args: unknown) => {
        const out = await runGraphTool(ctx, def.name, args);
        if (!out.ok) return { isError: true, content: [{ type: 'text', text: out.error }] };
        const evidence = out.traces.map(({ query, ms, rows }) => ({ query, ms, rows }));
        return {
          content: [
            { type: 'text', text: JSON.stringify({ result: out.result, evidence }, null, 2) },
          ],
        };
      },
    );
  }
  return server;
}
