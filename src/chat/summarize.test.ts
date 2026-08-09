import { describe, it, expect } from 'vitest';
import { summarizeTurns } from './summarize';

const cred = { accessToken: 'tok-SECRET', accountId: 'acct-1', expiresAt: Date.now() + 3_600_000 };
const turns = [
  { role: 'user' as const, content: 'Why did Auburn Hills dip?' },
  { role: 'assistant' as const, content: 'Two stylists left mid-month.' },
];

/** The codex backend only speaks SSE, so the summarizer reads a stream too. */
function sseFetch(texts: string[], ok = true, status = 200) {
  return (async () => {
    if (!ok) return { ok, status, body: null } as unknown as Response;
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
  it('requests a stream — the codex backend rejects stream:false', async () => {
    let sentStream: unknown = null;
    const capture = (async (_u: string, init: any) => {
      sentStream = JSON.parse(init.body).stream;
      return { ok: true, body: null } as unknown as Response;
    }) as unknown as typeof fetch;
    await summarizeTurns(turns, { credential: cred, fetchImpl: capture });
    expect(sentStream).toBe(true);
  });

  it('extracts output_text from the Responses payload', async () => {
    const out = await summarizeTurns(turns, {
      credential: cred,
      fetchImpl: sseFetch(['Looked into ', 'the Auburn Hills dip.']),
    });
    expect(out).toBe('Looked into the Auburn Hills dip.');
  });

  it('returns null rather than throwing when the provider fails', async () => {
    expect(await summarizeTurns(turns, { credential: cred, fetchImpl: sseFetch([], false, 500) })).toBeNull();
    const boom = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    expect(await summarizeTurns(turns, { credential: cred, fetchImpl: boom })).toBeNull();
  });

  it('returns null for an empty conversation without calling the provider', async () => {
    let called = false;
    const spy = (async () => { called = true; return { ok: true, body: null } as unknown as Response; }) as unknown as typeof fetch;
    expect(await summarizeTurns([], { credential: cred, fetchImpl: spy })).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when there is no credential', async () => {
    const spy = (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch;
    expect(await summarizeTurns(turns, { fetchImpl: spy })).toBeNull();
  });

  it('caps a very long transcript', async () => {
    let sent = '';
    const capture = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body).input[0].content[0].text;
      return { ok: true, body: null } as unknown as Response;
    }) as unknown as typeof fetch;
    const huge = Array.from({ length: 2000 }, (_, i) => ({ role: 'user' as const, content: `line ${i} ${'x'.repeat(50)}` }));
    await summarizeTurns(huge, { credential: cred, fetchImpl: capture });
    expect(sent.length).toBeLessThanOrEqual(12_000);
  });
});
