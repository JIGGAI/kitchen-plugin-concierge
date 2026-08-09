/**
 * Parses an SSE byte stream into `data:` payload objects.
 *
 * Shared by the chat loop and the summarizer because the codex backend
 * refuses `stream: false` outright ({"detail":"Stream must be set to true"}),
 * so even a one-shot summary has to be read off a stream.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { yield JSON.parse(payload); } catch { /* keepalive or partial */ }
      }
    }
  }
}

export const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

export function codexHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    'OpenAI-Beta': 'responses=experimental',
    'content-type': 'application/json',
  };
}
