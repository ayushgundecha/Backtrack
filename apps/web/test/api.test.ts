import type { RunEvent } from '@backtrack/core/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError, HttpApiClient, parseSse } from '../lib/api';

const started: RunEvent = {
  type: 'run.started',
  runId: 'run_1',
  agentId: 'ops-agent',
  mode: 'replay',
  goal: 'Fix the address',
  model: null,
  ts: 1,
};
const finished: RunEvent = { type: 'run.finished', runId: 'run_1', status: 'done', ts: 2 };

/** A body that delivers the given chunks one by one, as a network would. */
const bodyOf = (chunks: string[]) => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

async function collect(stream: AsyncIterable<RunEvent>) {
  const out: RunEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('parseSse', () => {
  it('parses events split across arbitrary chunk boundaries and skips comments', async () => {
    const text = `: keep-alive\n\ndata: ${JSON.stringify(started)}\n\ndata: ${JSON.stringify(finished)}\n\n`;
    const chunks = [text.slice(0, 7), text.slice(7, 40), text.slice(40, 41), text.slice(41)];
    expect(await collect(parseSse(bodyOf(chunks)))).toEqual([started, finished]);
  });

  it('rejects an event that does not match the RunEvent contract', async () => {
    const bad = bodyOf([`data: ${JSON.stringify({ type: 'step', runId: 'x' })}\n\n`]);
    await expect(collect(parseSse(bad))).rejects.toThrow();
  });
});

describe('HttpApiClient', () => {
  it('sends the tenant and validates the response with the contract schema', async () => {
    const calls: string[] = [];
    const client = new HttpApiClient({
      tenant: 'acme',
      fetch: async (input) => {
        calls.push(String(input));
        return Response.json({ tenant: 'acme', asOfSeq: 3, entities: [] });
      },
    });
    expect(await client.world(3)).toEqual({ tenant: 'acme', asOfSeq: 3, entities: [] });
    expect(calls).toEqual(['/api/world?tenant=acme&asOfSeq=3']);
  });

  it('surfaces the route error message', async () => {
    const client = new HttpApiClient({
      fetch: async () => Response.json({ error: 'FalkorDB is unreachable' }, { status: 503 }),
    });
    await expect(client.graph()).rejects.toEqual(
      new ApiError('FalkorDB is unreachable', 503, '/api/graph'),
    );
  });
});
