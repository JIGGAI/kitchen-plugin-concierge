import { visibleSlices, toolsFor, toolName, type Slice, type SliceContext } from '../slices/types';
import { systemPrompt, DEFAULT_PERSONA } from './prompt';
import {
  readGatewayTarget, responsesUrl, gatewayHeaders, sessionKeyFor, describeGatewayFailure,
  type GatewayTarget,
} from './gateway';
import { sseEvents } from './sse';

export interface Source { id: string; label: string; href: string }
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export type ConciergeEvent =
  | { type: 'delta'; text: string }
  | { type: 'slice'; id: string; label: string; href: string }
  | { type: 'done'; sources: Source[] }
  /** `detail` is a short, token-free description for logs and the console; `message` is for the user. */
  | { type: 'error'; code: string; message: string; detail?: string };

export interface StreamChatInput {
  message: string;
  /**
   * The dashboard conversation id. It names the gateway session, so the
   * agent remembers the thread across turns without the concierge replaying
   * it. A new conversation id is a new session.
   */
  conversationId: string;
  /**
   * Context the gateway session cannot have yet — the digests of this user's
   * earlier conversations. The dashboard passes it on the first turn of a
   * thread only; it goes in as a system message, not as fake history.
   */
  priorContext?: string;
  slices: Slice[];
  user: { id: string; email: string };
  roles: string[];
  scope: unknown;
  teamId: string;
  route?: string;
  filters?: Record<string, string>;
  persona?: string;
  /**
   * Overrides the gateway resolved from the environment / openclaw.json.
   * Tests pass a fake; `null` means "none available".
   */
  gateway?: GatewayTarget | null;
  /** Injected in tests. Production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Where failures are written. Defaults to console.error. */
  log?: (line: string) => void;
  /** Passed through to every slice's read() as ctx.host. Never inspected. */
  hostContext?: Record<string, unknown>;
  /** ISO date the model should treat as today. Defaults to the real one. */
  today?: string;
}

const MAX_TOOL_ROUNDS = 4;
const USER_MESSAGE = 'Govna could not complete that request.';

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

function messageItem(role: 'user' | 'system', text: string) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] };
}

export async function* streamChat(input: StreamChatInput): AsyncGenerator<ConciergeEvent> {
  const allowed = visibleSlices(input.slices, input.roles);
  const tools = responsesTools(input.slices, input.roles);
  const byToolName = new Map(allowed.map((s) => [toolName(s.id), s]));
  const log = input.log ?? ((line: string) => console.error(`[concierge] ${line}`));

  const target = input.gateway === undefined ? readGatewayTarget() : input.gateway;
  if (!target) {
    log('no gateway target: set CONCIERGE_GATEWAY_TOKEN or make ~/.openclaw/openclaw.json readable');
    yield { type: 'error', code: 'no_gateway', message: 'Govna cannot reach OpenClaw.' };
    return;
  }

  const doFetch = input.fetchImpl ?? fetch;
  const instructions = systemPrompt(input.persona ?? DEFAULT_PERSONA, allowed);
  const sessionKey = sessionKeyFor(target, 'conv', input.conversationId);

  // Only the new turn goes up. The gateway session already holds every earlier
  // turn of this conversation, and resending them would double the transcript
  // the agent sees on every request.
  let nextInput: any[] = [
    ...(input.priorContext ? [messageItem('system', input.priorContext)] : []),
    messageItem('user', userText(input)),
  ];
  let previousResponseId: string | undefined;

  const sources: Source[] = [];
  const seen = new Set<string>();

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await doFetch(responsesUrl(target), {
        method: 'POST',
        headers: gatewayHeaders(target, sessionKey),
        body: JSON.stringify({
          model: `openclaw/${target.agentId}`,
          instructions,
          input: nextInput,
          ...(tools.length ? { tools } : {}),
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          stream: true,
          store: false,
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await describeGatewayFailure(res, target.token);
        log(`${sessionKey} round ${round}: ${detail}`);
        yield { type: 'error', code: `gateway_${res.status}`, message: USER_MESSAGE, detail };
        return;
      }

      const calls: PendingCall[] = [];
      let responseId: string | undefined;

      for await (const ev of sseEvents(res.body)) {
        if (typeof ev?.response?.id === 'string') responseId = ev.response.id;
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
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

      previousResponseId = responseId;
      nextInput = [];

      for (const call of calls) {
        const slice = byToolName.get(call.name);

        // Defense in depth. A slice the caller lacks the role for is not in the
        // tool list, so the model should never name it — but the one property
        // this whole design exists for is not left to "should".
        if (!slice) {
          nextInput.push({
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
          nextInput.push({
            type: 'function_call_output', call_id: call.callId,
            output: data ?? 'No data available for that request.',
          });
        } catch (err) {
          // One bad slice must not fail the chat.
          nextInput.push({
            type: 'function_call_output', call_id: call.callId,
            output: `That data could not be read right now: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    yield { type: 'done', sources };
  } catch (err: any) {
    // The gateway token never reaches an event. The log line carries only the
    // error's constructor and message, which for a fetch failure is network
    // detail, not the request headers.
    const detail = `transport: ${err?.name ?? 'Error'} ${String(err?.message ?? err).split(target.token).join('[token]')}`.slice(0, 300);
    log(`${sessionKey}: ${detail}`);
    yield { type: 'error', code: 'gateway_error', message: USER_MESSAGE, detail };
  }
}
