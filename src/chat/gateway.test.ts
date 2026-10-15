import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readGatewayTarget, sessionKeyFor, describeGatewayFailure, gatewayHeaders } from './gateway';

describe('readGatewayTarget', () => {
  it('prefers explicit env over the config file', () => {
    const t = readGatewayTarget({
      CONCIERGE_GATEWAY_URL: 'http://gw.test:1234/',
      CONCIERGE_GATEWAY_TOKEN: 'tok',
      CONCIERGE_AGENT_ID: 'custom',
      OPENCLAW_CONFIG_PATH: '/nonexistent/openclaw.json',
    });
    expect(t).toEqual({ url: 'http://gw.test:1234', token: 'tok', agentId: 'custom' });
  });

  it('reads port and token from openclaw.json and defaults the agent to hmx-govna', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concierge-gw-'));
    const file = join(dir, 'openclaw.json');
    writeFileSync(file, JSON.stringify({ gateway: { port: 18790, auth: { token: 'from-file' } } }));
    const t = readGatewayTarget({ OPENCLAW_CONFIG_PATH: file });
    expect(t).toEqual({ url: 'http://127.0.0.1:18790', token: 'from-file', agentId: 'hmx-govna' });
  });

  it('returns null when no token can be found', () => {
    expect(readGatewayTarget({ OPENCLAW_CONFIG_PATH: '/nonexistent/openclaw.json' })).toBeNull();
  });
});

describe('session keys and headers', () => {
  const target = { url: 'http://gw.test', token: 'tok-SECRET', agentId: 'hmx-govna' };

  it('scopes the session to the agent and the conversation', () => {
    expect(sessionKeyFor(target, 'conv', 'c1')).toBe('agent:hmx-govna:conv:c1');
    expect(sessionKeyFor(target, 'summary', 'c1')).toBe('agent:hmx-govna:summary:c1');
  });

  it('sends the bearer token and the session key header', () => {
    const h = gatewayHeaders(target, 'agent:hmx-govna:conv:c1');
    expect(h.authorization).toBe('Bearer tok-SECRET');
    expect(h['x-openclaw-session-key']).toBe('agent:hmx-govna:conv:c1');
  });
});

describe('describeGatewayFailure', () => {
  const fail = (status: number, body: string) =>
    ({ status, text: async () => body } as unknown as Response);

  it('keeps the provider reason, which is what the old code threw away', async () => {
    const body = JSON.stringify({ error: { message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." } });
    expect(await describeGatewayFailure(fail(400, body), 'tok'))
      .toBe("gateway 400: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.");
  });

  it('scrubs the token and collapses whitespace in a non-JSON body', async () => {
    expect(await describeGatewayFailure(fail(401, 'bad\n  token tok-SECRET here'), 'tok-SECRET'))
      .toBe('gateway 401: bad token [token] here');
  });

  it('survives an unreadable body', async () => {
    const res = { status: 502, text: async () => { throw new Error('closed'); } } as unknown as Response;
    expect(await describeGatewayFailure(res, 'tok')).toBe('gateway 502:');
  });
});
