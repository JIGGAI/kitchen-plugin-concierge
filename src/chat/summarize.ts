import { readCodexCredential, type CodexCredential } from './credentials';
import { sseEvents, CODEX_ENDPOINT, codexHeaders } from './sse';
import type { ChatTurn } from '../db/history';

const PROMPT =
  'Summarize this conversation between a staff member and a dashboard assistant '
  + 'in two or three sentences. Capture what they were investigating and what was '
  + 'found, including specific figures, locations, or people named. Write it so a '
  + 'future assistant reading only this summary knows what the thread was about. '
  + 'No preamble — start with the substance.';

export interface SummarizeOptions {
  model?: string;
  credential?: CodexCredential;
  fetchImpl?: typeof fetch;
}

/**
 * Returns a digest of a conversation, or null if one could not be produced.
 *
 * A failed summary must never block archiving. The transcript is retained
 * either way, and a missing summary is a far smaller loss than a stuck job or
 * a thread that stays open because its digest could not be written.
 *
 * Non-streaming: nothing user-facing waits on this. It runs behind the Clear
 * response and in the nightly job.
 */
export async function summarizeTurns(
  turns: ChatTurn[],
  opts: SummarizeOptions = {},
): Promise<string | null> {
  if (!turns.length) return null;

  const cred = opts.credential ?? readCodexCredential();
  if (!cred) return null;

  const transcript = turns
    .map((t) => `${t.role === 'user' ? 'Staff' : 'Govna'}: ${t.content}`)
    .join('\n')
    .slice(0, 12_000);

  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const res = await doFetch(CODEX_ENDPOINT, {
      method: 'POST',
      headers: codexHeaders(cred.accessToken, cred.accountId),
      body: JSON.stringify({
        model: opts.model ?? 'gpt-5.5',
        instructions: PROMPT,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: transcript }] }],
        reasoning: { effort: 'low' },
        // Must be true. The codex backend rejects a non-streaming request
        // outright: {"detail":"Stream must be set to true"}. Even a one-shot
        // summary is read off the stream and accumulated.
        stream: true,
        store: false,
      }),
    });
    if (!res.ok || !res.body) return null;

    let text = '';
    for await (const ev of sseEvents(res.body)) {
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
        text += ev.delta;
      }
    }

    return text.trim() || null;
  } catch {
    return null;
  }
}
