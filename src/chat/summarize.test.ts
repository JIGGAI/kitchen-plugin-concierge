import { describe, it, expect } from 'vitest';
import { summarizeTurns } from './summarize';

const gateway = { url: 'http://gw.test', token: 'tok-SECRET', agentId: 'hmx-govna' };
const turns = [
  { role: 'user' as const, content: 'Why did Auburn Hills dip?' },
  { role: 'assistant' as const, content: 'Two stylists left mid-month.' },
];

function sseFetch(texts: string[], ok = true, status = 200) {
  return (async () => {
    if (!ok) return { ok, status, body: null, text: async () => 'nope' } as unknown as Response;
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        for (const t of texts) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`));
        }
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return { ok, status, body } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('summarizeTurns', () => {
  it('posts to the gateway as the Govna agent in a per-conversation summary session', async () => {
    let url = ''; let init: any = null;
    const capture = (async (u: string, i: any) => {
      url = u; init = i;
      return { ok: true, body: null, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    await summarizeTurns(turns, { gateway, conversationId: 'c1', fetchImpl: capture, log: () => {} });
    expect(url).toBe('http://gw.test/v1/responses');
    expect(init.headers['x-openclaw-session-key']).toBe('agent:hmx-govna:summary:c1');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('openclaw/hmx-govna');
    expect(body.stream).toBe(true);
  });

  it('extracts output_text from the Responses stream', async () => {
    const out = await summarizeTurns(turns, {
      gateway, fetchImpl: sseFetch(['Looked into ', 'the Auburn Hills dip.']),
    });
    expect(out).toBe('Looked into the Auburn Hills dip.');
  });

  it('returns null and logs the reason when the gateway fails', async () => {
    const lines: string[] = [];
    expect(await summarizeTurns(turns, { gateway, fetchImpl: sseFetch([], false, 500), log: (l) => lines.push(l) })).toBeNull();
    expect(lines[0]).toContain('gateway 500: nope');
    const boom = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    expect(await summarizeTurns(turns, { gateway, fetchImpl: boom, log: () => {} })).toBeNull();
  });

  it('returns null for an empty conversation without calling the gateway', async () => {
    let called = false;
    const spy = (async () => { called = true; return { ok: true, body: null } as unknown as Response; }) as unknown as typeof fetch;
    expect(await summarizeTurns([], { gateway, fetchImpl: spy })).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when there is no gateway', async () => {
    const spy = (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch;
    expect(await summarizeTurns(turns, { gateway: null, fetchImpl: spy, log: () => {} })).toBeNull();
  });

  it('caps a very long transcript', async () => {
    let sent = '';
    const capture = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body).input[0].content[0].text;
      return { ok: true, body: null, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    const huge = Array.from({ length: 2000 }, (_, i) => ({ role: 'user' as const, content: `line ${i} ${'x'.repeat(50)}` }));
    await summarizeTurns(huge, { gateway, fetchImpl: capture, log: () => {} });
    expect(sent.length).toBeLessThanOrEqual(12_000);
  });
});
