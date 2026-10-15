import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Where Govna's model calls go.
 *
 * The concierge does not talk to a model provider itself. It posts to the
 * local OpenClaw gateway's OpenResponses endpoint (`/v1/responses`) as the
 * `hmx-govna` agent, and OpenClaw picks the model, the credential and the
 * provider the same way it does for every other agent on the box. That is
 * the whole point: when OpenAI changes what a ChatGPT account may call (as
 * on 2026-10-14), one `openclaw.json` edit fixes every agent, Govna included,
 * instead of this plugin carrying its own copy of the provider dance.
 */
export interface GatewayTarget {
  /** Gateway origin, e.g. http://127.0.0.1:18789 — no trailing slash. */
  url: string;
  /** `gateway.auth.token`. Never logged, never put in an event. */
  token: string;
  /** The OpenClaw agent id that answers as Govna. */
  agentId: string;
}

export const DEFAULT_AGENT_ID = 'hmx-govna';

/**
 * Resolves the gateway from the environment, falling back to OpenClaw's own
 * config file for the port and token. Read fresh on every call: the file is
 * small, and a rotated token must take effect without a dashboard restart.
 *
 * Env overrides (all optional):
 *   CONCIERGE_GATEWAY_URL    e.g. http://127.0.0.1:18789
 *   CONCIERGE_GATEWAY_TOKEN  bearer token for the gateway
 *   CONCIERGE_AGENT_ID       defaults to hmx-govna
 *   OPENCLAW_CONFIG_PATH     defaults to ~/.openclaw/openclaw.json
 */
export function readGatewayTarget(env: NodeJS.ProcessEnv = process.env): GatewayTarget | null {
  const agentId = env.CONCIERGE_AGENT_ID || DEFAULT_AGENT_ID;
  let url = env.CONCIERGE_GATEWAY_URL || '';
  let token = env.CONCIERGE_GATEWAY_TOKEN || '';

  if (!url || !token) {
    const cfg = readOpenClawConfig(env.OPENCLAW_CONFIG_PATH);
    const gw = cfg?.gateway ?? {};
    if (!url) url = `http://127.0.0.1:${typeof gw.port === 'number' ? gw.port : 18789}`;
    if (!token) token = typeof gw.auth?.token === 'string' ? gw.auth.token : '';
  }

  if (!token) return null;
  return { url: url.replace(/\/+$/, ''), token, agentId };
}

function readOpenClawConfig(path?: string): any | null {
  const file = path || join(homedir(), '.openclaw', 'openclaw.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function responsesUrl(target: GatewayTarget): string {
  return `${target.url}/v1/responses`;
}

export function gatewayHeaders(target: GatewayTarget, sessionKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${target.token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-openclaw-session-key': sessionKey,
  };
}

/**
 * One gateway session per dashboard conversation. The gateway keeps the
 * transcript for the agent, so the concierge sends only the new turn and
 * never replays history; archiving a conversation in the dashboard starts a
 * new id and therefore a new session.
 */
export function sessionKeyFor(target: GatewayTarget, kind: 'conv' | 'summary', id: string): string {
  return `agent:${target.agentId}:${kind}:${id}`;
}

/**
 * Turns a failed gateway response into one loggable line. The body is kept
 * (it is where the real reason lives — the 2026-10-14 outage was a provider
 * 400 that the old code threw away) but truncated, whitespace-collapsed, and
 * scrubbed of the bearer token in case an auth error echoes it.
 */
export async function describeGatewayFailure(res: Response, token: string): Promise<string> {
  let text = '';
  try { text = (await res.text()).slice(0, 800); } catch { text = ''; }
  try {
    const parsed = JSON.parse(text);
    const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    if (typeof msg === 'string') text = msg;
  } catch { /* not JSON; keep the raw text */ }
  const scrubbed = token ? text.split(token).join('[token]') : text;
  return `gateway ${res.status}: ${scrubbed.replace(/\s+/g, ' ').trim()}`.trim();
}
