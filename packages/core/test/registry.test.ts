import { asSchema } from 'ai';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  actionFlags,
  defineTool,
  type ToolContext,
  ToolRegistry,
  toAiTool,
} from '../src/sdk/registry.js';

const updateAddress = defineTool({
  name: 'update_address',
  description: 'Change the shipping address of an order.',
  input: z.object({ orderId: z.string(), address: z.string().min(5) }),
  effect: 'reversible',
  inverse: 'restore_address',
  undoMode: 'restore',
  async run(_ctx: ToolContext, input) {
    return { result: { orderId: input.orderId }, reads: [], writes: [] };
  },
});

describe('defineTool', () => {
  it('types the input end to end from the zod schema', () => {
    expectTypeOf(updateAddress.run)
      .parameter(1)
      .toEqualTypeOf<{ orderId: string; address: string }>();
  });

  it('rejects a tool that is both reversible and irreversible, or neither', () => {
    const base = {
      name: 'bad',
      description: 'x',
      input: z.object({}),
      run: async () => ({ result: null, reads: [], writes: [] }),
    };
    expect(() =>
      // @ts-expect-error a reversible tool cannot also declare a mitigation
      defineTool({
        ...base,
        effect: 'reversible',
        inverse: 'x',
        undoMode: 'inverse',
        mitigation: 'y',
      }),
    ).toThrow(/not both or neither/);
    expect(() =>
      // @ts-expect-error an irreversible tool needs a mitigation
      defineTool({ ...base, effect: 'irreversible' }),
    ).toThrow(/not both or neither/);
    expect(() =>
      // @ts-expect-error a read-only tool has no inverse
      defineTool({ ...base, effect: 'read', inverse: 'x' }),
    ).toThrow();
  });

  it('maps the effect class onto Action flags', () => {
    expect(actionFlags(updateAddress)).toEqual({
      reversible: true,
      inverseTool: 'restore_address',
      mitigationTool: null,
    });
    const email = defineTool({
      name: 'send_email',
      description: 'Send an email.',
      input: z.object({ to: z.string() }),
      effect: 'irreversible',
      mitigation: 'draft_correction_email',
      run: async () => ({ result: null, reads: [], writes: [] }),
    });
    expect(actionFlags(email)).toEqual({
      reversible: false,
      inverseTool: null,
      mitigationTool: 'draft_correction_email',
    });
  });

  it('converts to an AI SDK tool with the same JSON schema and a delegating execute', async () => {
    const calls: unknown[] = [];
    const t = toAiTool(updateAddress, async (input) => {
      calls.push(input);
      return 'recorded';
    });
    expect(t.description).toBe('Change the shipping address of an order.');
    const schema = await asSchema(t.inputSchema).jsonSchema;
    expect(schema).toMatchObject({
      type: 'object',
      properties: { orderId: { type: 'string' }, address: { type: 'string', minLength: 5 } },
      required: ['orderId', 'address'],
    });
    const out = await t.execute?.({ orderId: 'ord_1001', address: '221B Baker Street' }, {
      toolCallId: 'c1',
      messages: [],
      context: {},
    } as never);
    expect(out).toBe('recorded');
    expect(calls).toEqual([{ orderId: 'ord_1001', address: '221B Baker Street' }]);
  });

  it('registry resolves by name and refuses duplicates', () => {
    const r = new ToolRegistry([updateAddress]);
    expect(r.get('update_address')).toBe(updateAddress);
    expect(() => r.get('nope')).toThrow(/Unknown tool/);
    expect(() => r.add(updateAddress)).toThrow(/defined twice/);
  });
});
