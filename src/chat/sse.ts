/**
 * Parses an SSE byte stream into `data:` payload objects.
 *
 * Shared by the chat loop and the summarizer: the gateway's OpenResponses
 * endpoint streams Responses-API events (`response.output_text.delta`,
 * `response.output_item.done`, `response.completed`, ...), one JSON object
 * per `data:` line.
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
