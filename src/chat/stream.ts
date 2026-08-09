import { visibleSlices, toolsFor, toolName, type Slice, type SliceContext } from '../slices/types';
import { systemPrompt, DEFAULT_PERSONA } from './prompt';
import { readCodexCredential, type CodexCredential } from './credentials';
import { sseEvents, CODEX_ENDPOINT, codexHeaders } from './sse';

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
  /** Passed through to every slice's read() as ctx.host. Never inspected. */
  hostContext?: Record<string, unknown>;
  /** ISO date the model should treat as today. Defaults to the real one. */
  today?: string;
}

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
  const notes: string[] = [];

  // Today's date, so the model can resolve "the first week of July" or "the
  // last three days" into a real startDate/endDate. It goes in the user turn
  // rather than the system prompt on purpose: the system prompt is the
  // cacheable prefix and must stay byte-identical, and a date in it would
  // invalidate that cache every midnight.
  notes.push(`Today is ${input.today ?? new Date().toISOString().slice(0, 10)}.`);

  if (input.route) {
    const filters = input.filters && Object.keys(input.filters).length
      ? ` with filters ${JSON.stringify(input.filters)}`
      : '';
    notes.push(`The user is currently viewing the ${input.route} page${filters}.`);
  }

  return `${input.message}\n\n(${notes.join(' ')})`;
}

function messageItem(role: 'user' | 'assistant', text: string) {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  };
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
        headers: codexHeaders(cred.accessToken, cred.accountId),
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
          scope: input.scope, params, host: input.hostContext,
        };

        // Announce BEFORE reading, not after. A slice can take seconds — the
        // Daily Ops read hits YOT in-process and measured ~4s on live data —
        // and that is exactly the window the "Reading Daily Ops…" indicator
        // exists to cover. Emitting after the await left the user staring at
        // nothing for the entire fetch, which stub-backed tests could never
        // surface because a stub returns instantly.
        const announced = !seen.has(slice.id);
        if (announced) {
          seen.add(slice.id);
          yield { type: 'slice', id: slice.id, label: slice.label, href: slice.href };
        }

        try {
          const data = await slice.read(ctx);
          // Sources list what was actually read, so it is appended on success
          // only — an announced slice that then failed is not a citation.
          if (announced) {
            sources.push({ id: slice.id, label: slice.label, href: slice.href });
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
