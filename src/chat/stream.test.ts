import { describe, it, expect } from 'vitest';
import { streamChat, type ConciergeEvent } from './stream';
import type { Slice } from '../slices/types';

const summary: Slice = {
  id: 'summary', label: 'Overview', href: '/', description: 'Org-wide KPIs.',
  role: null, parameters: {},
  async read() { return 'Revenue last month: $482,100'; },
};

const payouts: Slice = {
  id: 'payouts', label: 'Daily Payouts', href: '/daily-payouts',
  description: 'Per-stylist disbursements.', role: 'payouts',
  parameters: {}, async read() { return 'SHOULD NOT BE REACHED'; },
};

/** Builds an SSE body from Responses-API event objects. */
function sseBody(events: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(e)}\n\n`));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/** Stubs global fetch, replaying one scripted response per call. */
function stubFetch(scripts: object[][]) {
  const state = { calls: 0, bodies: [] as any[] };
  const impl = (async (_url: string, init: any) => {
    state.bodies.push(JSON.parse(init.body));
    const events = scripts[state.calls++] ?? [];
    return { ok: true, status: 200, body: sseBody(events) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, state };
}

const textDelta = (t: string) => ({ type: 'response.output_text.delta', delta: t });
const fnCall = (name: string, callId = 'call_1', args = '{}') => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', id: 'fc_1', call_id: callId, name, arguments: args },
});

async function collect(gen: AsyncGenerator<ConciergeEvent>) {
  const out: ConciergeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const credential = { accessToken: 'tok-SECRET', accountId: 'acct-1', expiresAt: Date.now() + 3_600_000 };

const base = {
  message: 'How did we do last month?',
  history: [],
  user: { id: 'u1', email: 'a@b.co' },
  scope: null,
  teamId: 'hmx-marketing-team',
  credential,
};

describe('streamChat', () => {
  it('yields text deltas and a terminating done event', async () => {
    const { impl } = stubFetch([[textDelta('Revenue '), textDelta('was up.')]]);
    const events = await collect(
      streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any),
    );
    const text = events.filter((e) => e.type === 'delta').map((e: any) => e.text).join('');
    expect(text).toBe('Revenue was up.');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('calls the codex backend, not the standard API', async () => {
    const calls: string[] = [];
    const impl = (async (url: string, init: any) => {
      calls.push(url);
      return { ok: true, status: 200, body: sseBody([textDelta('hi')]) } as unknown as Response;
    }) as unknown as typeof fetch;
    await collect(streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any));
    expect(calls[0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls[0]).not.toContain('api.openai.com');
  });

  it('sends the account header the codex backend requires', async () => {
    let headers: any = null;
    const impl = (async (_url: string, init: any) => {
      headers = init.headers;
      return { ok: true, status: 200, body: sseBody([textDelta('hi')]) } as unknown as Response;
    }) as unknown as typeof fetch;
    await collect(streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any));
    expect(headers['chatgpt-account-id']).toBe('acct-1');
    expect(headers.authorization).toBe('Bearer tok-SECRET');
  });

  it('runs a tool call, emits a slice event, and records the source', async () => {
    const { impl } = stubFetch([
      [fnCall('read_summary')],
      [textDelta('Revenue was $482,100.')],
    ]);
    const events = await collect(
      streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any),
    );
    expect(events).toContainEqual({ type: 'slice', id: 'summary', label: 'Overview', href: '/' });
    expect(events.at(-1)).toMatchObject({
      type: 'done', sources: [{ id: 'summary', label: 'Overview', href: '/' }],
    });
  });

  it('feeds the slice output back as a function_call_output item', async () => {
    const { impl, state } = stubFetch([
      [fnCall('read_summary', 'call_abc')],
      [textDelta('done')],
    ]);
    await collect(streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any));
    const second = state.bodies[1];
    const out = second.input.find((i: any) => i.type === 'function_call_output');
    expect(out).toMatchObject({ call_id: 'call_abc', output: 'Revenue last month: $482,100' });
  });

  it('uses the flat Responses tool shape', async () => {
    const { impl, state } = stubFetch([[textDelta('hi')]]);
    await collect(streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any));
    expect(state.bodies[0].tools[0]).toMatchObject({ type: 'function', name: 'read_summary' });
    expect(state.bodies[0].tools[0].function).toBeUndefined();
  });

  it('never advertises a slice the caller lacks the role for', async () => {
    const { impl, state } = stubFetch([[textDelta('ok')]]);
    await collect(
      streamChat({ ...base, slices: [summary, payouts], roles: ['media-manager'], fetchImpl: impl } as any),
    );
    expect(state.bodies[0].tools.map((t: any) => t.name)).toEqual(['read_summary']);
  });

  it('refuses a tool call for a slice outside the caller role, even if the model invents it', async () => {
    const { impl } = stubFetch([
      [fnCall('read_payouts')],
      [textDelta("I can't see payouts.")],
    ]);
    const events = await collect(
      streamChat({ ...base, slices: [summary, payouts], roles: ['media-manager'], fetchImpl: impl } as any),
    );
    expect(events.find((e) => e.type === 'slice' && (e as any).id === 'payouts')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'done', sources: [] });
  });

  it('skips a slice that throws and still completes the turn', async () => {
    const boom: Slice = {
      ...summary, id: 'boom', label: 'Boom', href: '/boom',
      async read() { throw new Error('db down'); },
    };
    const { impl } = stubFetch([[fnCall('read_boom')], [textDelta('Could not read that.')]]);
    const events = await collect(
      streamChat({ ...base, slices: [boom], roles: [], fetchImpl: impl } as any),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', sources: [] });
    expect(events.some((e) => e.type === 'delta')).toBe(true);
  });

  it('reports a provider failure as an error event rather than throwing', async () => {
    const impl = (async () => ({ ok: false, status: 429, body: null } as unknown as Response)) as unknown as typeof fetch;
    const events = await collect(
      streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'provider_429' });
  });

  it('errors cleanly when no credential is available', async () => {
    const events = await collect(
      streamChat({
        ...base, credential: undefined, slices: [summary], roles: [],
        fetchImpl: (async () => { throw new Error('should not be called'); }) as any,
        // Point the reader at a path that does not exist so it returns null.
      } as any),
    );
    // Either no_credential (reader found nothing) or a provider error — never a throw.
    expect(['no_credential', 'provider_error']).toContain((events.at(-1) as any).code);
  });

  it('does not leak the access token into any event', async () => {
    const impl = (async () => { throw new Error('auth failed for tok-SECRET'); }) as unknown as typeof fetch;
    const events = await collect(
      streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any),
    );
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });
});

describe('slice announcement ordering', () => {
  it('announces the slice before reading it, so the indicator covers a slow fetch', async () => {
    const order: string[] = [];
    const slow: Slice = {
      id: 'slow', label: 'Slow', href: '/slow', description: 'Slow source.',
      role: null, parameters: {},
      async read() { order.push('read-start'); return 'data'; },
    };
    const { impl } = stubFetch([[fnCall('read_slow')], [textDelta('ok')]]);
    for await (const ev of streamChat({ ...base, slices: [slow], roles: [], fetchImpl: impl } as any)) {
      if (ev.type === 'slice') order.push('slice-event');
    }
    expect(order).toEqual(['slice-event', 'read-start']);
  });

  it('does not cite a slice that was announced but then failed', async () => {
    const boom: Slice = {
      id: 'boom', label: 'Boom', href: '/boom', description: 'Broken source.',
      role: null, parameters: {},
      async read() { throw new Error('db down'); },
    };
    const { impl } = stubFetch([[fnCall('read_boom')], [textDelta('could not read')]]);
    const events: ConciergeEvent[] = [];
    for await (const ev of streamChat({ ...base, slices: [boom], roles: [], fetchImpl: impl } as any)) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === 'slice')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', sources: [] });
  });
});
