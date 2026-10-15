import { randomUUID } from 'node:crypto';
import {
  readGatewayTarget, responsesUrl, gatewayHeaders, sessionKeyFor, describeGatewayFailure,
  type GatewayTarget,
} from './gateway';
import { sseEvents } from './sse';
import type { ChatTurn } from '../db/history';

const PROMPT =
  'Summarize this conversation between a staff member and a dashboard assistant '
  + 'in two or three sentences. Capture what they were investigating and what was '
  + 'found, including specific figures, locations, or people named. Write it so a '
  + 'future assistant reading only this summary knows what the thread was about. '
  + 'No preamble — start with the substance.';

export interface SummarizeOptions {
  /** Names the gateway session (`agent:<id>:summary:<conversationId>`). */
  conversationId?: string;
  gateway?: GatewayTarget | null;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * Returns a digest of a conversation, or null if one could not be produced.
 *
 * A failed summary must never block archiving. The transcript is retained
 * either way, and a missing summary is a far smaller loss than a stuck job or
 * a thread that stays open because its digest could not be written.
 *
 * Nothing user-facing waits on this. It runs behind the Clear response and in
 * the nightly job.
 */
export async function summarizeTurns(
  turns: ChatTurn[],
  opts: SummarizeOptions = {},
): Promise<string | null> {
  if (!turns.length) return null;

  const log = opts.log ?? ((line: string) => console.error(`[concierge] ${line}`));
  const target = opts.gateway === undefined ? readGatewayTarget() : opts.gateway;
  if (!target) {
    log('summarize: no gateway target');
    return null;
  }

  const transcript = turns
    .map((t) => `${t.role === 'user' ? 'Staff' : 'Govna'}: ${t.content}`)
    .join('\n')
    .slice(0, 12_000);

  const doFetch = opts.fetchImpl ?? fetch;
  const sessionKey = sessionKeyFor(target, 'summary', opts.conversationId ?? randomUUID());

  try {
    const res = await doFetch(responsesUrl(target), {
      method: 'POST',
      headers: gatewayHeaders(target, sessionKey),
      body: JSON.stringify({
        model: `openclaw/${target.agentId}`,
        instructions: PROMPT,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: transcript }] }],
        stream: true,
        store: false,
      }),
    });
    if (!res.ok || !res.body) {
      log(`${sessionKey}: ${await describeGatewayFailure(res, target.token)}`);
      return null;
    }

    let text = '';
    for await (const ev of sseEvents(res.body)) {
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
        text += ev.delta;
      }
    }

    return text.trim() || null;
  } catch (err: any) {
    log(`${sessionKey}: transport: ${String(err?.message ?? err).split(target.token).join('[token]')}`.slice(0, 300));
    return null;
  }
}
