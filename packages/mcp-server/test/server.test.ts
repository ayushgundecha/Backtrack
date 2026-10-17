import { closeDb, createToolRegistry, graphTools, openTenant, resetTenant } from '@backtrack/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const g = openTenant(`${process.env.BT_TEST_TENANT ?? 'test'}-mcp`);
const client = new Client({ name: 'test', version: '0' });

const text = (res: Awaited<ReturnType<typeof client.callTool>>) =>
  (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

beforeAll(async () => {
  await resetTenant(g);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ g, registry: createToolRegistry() }).connect(a);
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  await g.drop();
  await closeDb();
});

describe('MCP server', () => {
  it('lists every graph tool with its schema and safety hints', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(graphTools.map((t) => t.name));
    const execute = tools.find((t) => t.name === 'execute_undo');
    expect(execute?.inputSchema.required).toEqual(['planId', 'confirmed']);
    expect(execute?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((t) => t.name === 'recall')?.annotations?.readOnlyHint).toBe(true);
  });

  it('answers with the result and the named queries behind it', async () => {
    const res = await client.callTool({
      name: 'entity_history',
      arguments: { entityType: 'order', entityKey: 'ord_1001' },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({
      result: { history: [] },
      evidence: [{ query: 'Q12', ms: expect.any(Number), rows: 0 }],
    });
  });

  it('an unknown id is an honest outcome, and an unknown plan is a tool error the model can read', async () => {
    const plan = await client.callTool({
      name: 'plan_undo',
      arguments: { actionId: 'act_nope0000' },
    });
    expect(JSON.parse(text(plan)).result).toMatchObject({ kind: 'unknown', candidates: [] });

    const rehearse = await client.callTool({
      name: 'rehearse_undo',
      arguments: { planId: 'plan_nope' },
    });
    expect(rehearse.isError).toBe(true);
    expect(text(rehearse)).toBe('No undo plan plan_nope; call plan_undo first');
  });
});
