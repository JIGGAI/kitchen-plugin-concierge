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
const completed = (id = 'resp_1') => ({ type: 'response.completed', response: { id, status: 'incomplete' } });

async function collect(gen: AsyncGenerator<ConciergeEvent>) {
  const out: ConciergeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const gateway = { url: 'http://gw.test', token: 'tok-SECRET', agentId: 'hmx-govna' };

const base = {
  message: 'How did we do last month?',
  conversationId: 'conv-1',
  user: { id: 'u1', email: 'a@b.co' },
  scope: null,
  teamId: 'hmx-marketing-team',
  gateway,
  log: () => {},
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

  it('posts to the gateway OpenResponses endpoint as the Govna agent', async () => {
    const calls: string[] = [];
    let body: any = null;
    const impl = (async (url: string, init: any) => {
      calls.push(url); body = JSON.parse(init.body);
      return { ok: true, status: 200, body: sseBody([textDelta('hi')]) } as unknown as Response;
    }) as unknown as typeof fetch;
    await collect(streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any));
    expect(calls[0]).toBe('http://gw.test/v1/responses');
    expect(body.model).toBe('openclaw/hmx-govna');
    expect(body.stream).toBe(true);
  });

  it('authenticates with the gateway token and names a per-conversation session', async () => {
    let headers: any = null;
    const impl = (async (_url: string, init: any) => {
      headers = init.headers;
      return { ok: true, status: 200, body: sseBody([textDelta('hi')]) } as unknown as Response;
    }) as unknown as typeof fetch;
    await collect(streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any));
    expect(headers.authorization).toBe('Bearer tok-SECRET');
    expect(headers['x-openclaw-session-key']).toBe('agent:hmx-govna:conv:conv-1');
  });

  it('sends only the new turn; the gateway session holds the history', async () => {
    const { impl, state } = stubFetch([[textDelta('ok')]]);
    await collect(streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any));
    const roles = state.bodies[0].input.map((i: any) => `${i.type}:${i.role ?? ''}`);
    expect(roles).toEqual(['message:user']);
  });

  it('passes prior-conversation digests as a system message, not as fake history', async () => {
    const { impl, state } = stubFetch([[textDelta('ok')]]);
    await collect(streamChat({
      ...base, priorContext: 'Earlier: asked about Auburn Hills.', slices: [summary], roles: [], fetchImpl: impl,
    } as any));
    const [first, second] = state.bodies[0].input;
    expect(first).toMatchObject({ type: 'message', role: 'system' });
    expect(first.content[0].text).toContain('Auburn Hills');
    expect(second).toMatchObject({ type: 'message', role: 'user' });
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
      [fnCall('read_summary', 'call_abc'), completed('resp_1')],
      [textDelta('done')],
    ]);
    await collect(streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl } as any));
    const second = state.bodies[1];
    expect(second.input).toEqual([
      { type: 'function_call_output', call_id: 'call_abc', output: 'Revenue last month: $482,100' },
    ]);
    expect(second.previous_response_id).toBe('resp_1');
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

  it('reports a gateway failure with its reason, logged and token-free', async () => {
    const lines: string[] = [];
    const impl = (async () => ({
      ok: false, status: 400, body: null,
      text: async () => JSON.stringify({ error: { message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account. tok-SECRET" } }),
    } as unknown as Response)) as unknown as typeof fetch;
    const events = await collect(
      streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl, log: (l: string) => lines.push(l) } as any),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'gateway_400' });
    expect((events.at(-1) as any).detail).toContain('gpt-5.5');
    expect(lines[0]).toContain('agent:hmx-govna:conv:conv-1');
    expect(lines[0]).toContain('gateway 400');
    expect(JSON.stringify([events, lines])).not.toContain('SECRET');
  });

  it('errors cleanly when no gateway is available', async () => {
    const events = await collect(
      streamChat({
        ...base, gateway: null, slices: [summary], roles: [],
        fetchImpl: (async () => { throw new Error('should not be called'); }) as any,
      } as any),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'no_gateway' });
  });

  it('does not leak the access token into any event', async () => {
    const impl = (async () => { throw new Error('auth failed for tok-SECRET'); }) as unknown as typeof fetch;
    const lines: string[] = [];
    const events = await collect(
      streamChat({ ...base, slices: [summary], roles: [], fetchImpl: impl, log: (l: string) => lines.push(l) } as any),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'gateway_error' });
    expect(JSON.stringify([events, lines])).not.toContain('SECRET');
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

describe('date context', () => {
  it("tells the model today's date so it can build custom ranges", async () => {
    const { impl, state } = stubFetch([[textDelta('ok')]]);
    await collect(streamChat({
      ...base, slices: [summary], roles: [], fetchImpl: impl, today: '2026-08-08',
    } as any));
    const userItem = state.bodies[0].input.at(-1);
    expect(userItem.content[0].text).toContain('Today is 2026-08-08');
  });

  it('keeps the date out of the system prompt, which must stay cacheable', async () => {
    const { impl, state } = stubFetch([[textDelta('ok')]]);
    await collect(streamChat({
      ...base, slices: [summary], roles: [], fetchImpl: impl, today: '2026-08-08',
    } as any));
    expect(state.bodies[0].instructions).not.toContain('2026-08-08');
  });
});
