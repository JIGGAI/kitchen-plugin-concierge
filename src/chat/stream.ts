import { visibleSlices, toolsFor, toolName, type Slice, type SliceContext } from '../slices/types';
import { systemPrompt, DEFAULT_PERSONA } from './prompt';
import { readCodexCredential, type CodexCredential } from './credentials';

export interface Source { id: string; label: string; href: string }
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export type ConciergeEvent =
  | { type: 'delta'; text: string }
  | { type: 'slice'; id: string; label: string; href: string }
  | { type: 'done'; sources: Source[] }
  | { type: 'error'; code: string; message: string };

export interface StreamChatInput {
  message: string;
  history: ChatTurn[];
  slices: Slice[];
  user: { id: string; email: string };
  roles: string[];
  scope: unknown;
  teamId: string;
  route?: string;
  filters?: Record<string, string>;
  model?: string;
  persona?: string;
  /**
   * Reasoning depth. The backend defaults to `medium`, which on sampling
   * produced a long tail (one run in four past 5s to first feedback). `low`
   * is the right default for a concierge: the questions are lookups, not
   * analysis, and the slice does the real work.
   */
  effort?: 'low' | 'medium' | 'high';
  /** Overrides the credential read from OpenClaw. Tests pass a fake. */
  credential?: CodexCredential;
  /** Injected in tests. Production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * The Codex backend, not api.openai.com.
 *
 * This distinction is the whole reason the concierge works at all: the OAuth
 * credential and the API key belong to the same OpenAI account but bill
 * against different wallets. `/v1/chat/completions` draws on API credits;
 * this endpoint draws on the ChatGPT subscription. Pointing the same token at
 * the standard API returns `credit_balance_exhausted`.
 */
const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

const MAX_TOOL_ROUNDS = 4;

interface PendingCall { callId: string; name: string; args: string }

/** Responses-API tool shape: flat, unlike Chat Completions' nested `function`. */
function responsesTools(slices: Slice[], roles: string[]) {
  return toolsFor(slices, roles).map((t) => ({
    type: 'function' as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

function userText(input: StreamChatInput): string {
  if (!input.route) return input.message;
  const filters = input.filters && Object.keys(input.filters).length
    ? ` with filters ${JSON.stringify(input.filters)}`
    : '';
  return `${input.message}\n\n(The user is currently viewing the ${input.route} page${filters}.)`;
}

function messageItem(role: 'user' | 'assistant', text: string) {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  };
}

/** Parses an SSE byte stream into `data:` payload objects. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
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

export async function* streamChat(input: StreamChatInput): AsyncGenerator<ConciergeEvent> {
  const allowed = visibleSlices(input.slices, input.roles);
  const tools = responsesTools(input.slices, input.roles);
  const byToolName = new Map(allowed.map((s) => [toolName(s.id), s]));

  const cred = input.credential ?? readCodexCredential();
  if (!cred) {
    yield {
      type: 'error',
      code: 'no_credential',
      message: 'Govna has no model credential configured.',
    };
    return;
  }

  const doFetch = input.fetchImpl ?? fetch;
  const model = input.model ?? 'gpt-5.5';
  const instructions = systemPrompt(input.persona ?? DEFAULT_PERSONA, allowed);

  const conversation: any[] = [
    ...input.history.map((t) => messageItem(t.role, t.content)),
    messageItem('user', userText(input)),
  ];

  const sources: Source[] = [];
  const seen = new Set<string>();

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await doFetch(CODEX_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cred.accessToken}`,
          'chatgpt-account-id': cred.accountId,
          'OpenAI-Beta': 'responses=experimental',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          instructions,
          input: conversation,
          ...(tools.length ? { tools } : {}),
          reasoning: { effort: input.effort ?? 'low' },
          stream: true,
          store: false,
        }),
      });

      if (!res.ok || !res.body) {
        yield {
          type: 'error',
          code: `provider_${res.status}`,
          message: 'Govna could not complete that request.',
        };
        return;
      }

      const calls: PendingCall[] = [];
      let assistantText = '';

      for await (const ev of sseEvents(res.body)) {
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
          assistantText += ev.delta;
          yield { type: 'delta', text: ev.delta };
        } else if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') {
          calls.push({
            callId: ev.item.call_id,
            name: ev.item.name,
            args: ev.item.arguments || '{}',
          });
        }
      }

      if (!calls.length) break;

      // Echo the assistant's text and each call back, then append the results.
      if (assistantText) conversation.push(messageItem('assistant', assistantText));
      for (const c of calls) {
        conversation.push({
          type: 'function_call', call_id: c.callId, name: c.name, arguments: c.args,
        });
      }

      for (const call of calls) {
        const slice = byToolName.get(call.name);

        // Defense in depth. A slice the caller lacks the role for is not in the
        // tool list, so the model should never name it — but the one property
        // this whole design exists for is not left to "should".
        if (!slice) {
          conversation.push({
            type: 'function_call_output', call_id: call.callId,
            output: 'No such tool is available to you.',
          });
          continue;
        }

        let params: Record<string, string | undefined> = {};
        try { params = JSON.parse(call.args || '{}'); } catch { params = {}; }

        const ctx: SliceContext = {
          teamId: input.teamId, user: input.user, roles: input.roles,
          scope: input.scope, params,
        };

        try {
          const data = await slice.read(ctx);
          if (!seen.has(slice.id)) {
            seen.add(slice.id);
            sources.push({ id: slice.id, label: slice.label, href: slice.href });
            yield { type: 'slice', id: slice.id, label: slice.label, href: slice.href };
          }
          conversation.push({
            type: 'function_call_output', call_id: call.callId,
            output: data ?? 'No data available for that request.',
          });
        } catch (err) {
          // One bad slice must not fail the chat.
          conversation.push({
            type: 'function_call_output', call_id: call.callId,
            output: `That data could not be read right now: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    yield { type: 'done', sources };
  } catch (err: any) {
    // Never surface the credential or a raw provider payload — an auth failure
    // can echo the token back in its message.
    yield {
      type: 'error',
      code: err?.status ? `provider_${err.status}` : 'provider_error',
      message: 'Govna could not complete that request.',
    };
  }
}
