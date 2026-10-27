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
  /**
   * One per distinct read in a round, after it returns. Keeps bytes flowing on
   * the SSE stream while a turn is reading, and tells the host how long each
   * read took and how many duplicate calls it absorbed.
   */
  | { type: 'progress'; tool: string; ms: number; duplicates: number; ok: boolean }
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
/**
 * Distinct reads executed per round. The model has fanned out 27 calls in one
 * round (2026-10-26, all the same tool with empty arguments); the slices are
 * the slow part of a turn, so anything past this is answered with a note
 * instead of read.
 */
const MAX_DISTINCT_READS_PER_ROUND = 6;
const READ_CONCURRENCY = 4;
const USER_MESSAGE = 'Govna could not complete that request.';

interface PendingCall { callId: string; name: string; args: string }

/** Stable key for "the same call": tool name plus arguments with sorted keys. */
function callKey(call: PendingCall): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as any)[k])]));
    }
    return v;
  };
  let args: unknown;
  try { args = canonical(JSON.parse(call.args || '{}')); } catch { args = call.args; }
  return `${call.name}\u0000${JSON.stringify(args)}`;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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

      // The model may issue the same call many times in one round — 27 copies
      // of one read with empty arguments was observed — and the slices are the
      // slow part of a turn. Identical calls are read once and every call id
      // gets an answer; distinct reads run a few at a time.
      const groups = new Map<string, PendingCall[]>();
      for (const call of calls) {
        const key = callKey(call);
        const group = groups.get(key);
        if (group) group.push(call); else groups.set(key, [call]);
      }
      const distinct = [...groups.values()];
      const toRead = distinct.slice(0, MAX_DISTINCT_READS_PER_ROUND);
      const overflow = distinct.slice(MAX_DISTINCT_READS_PER_ROUND);

      // Announce BEFORE reading, not after. A slice can take seconds — the
      // Daily Ops read hits YOT in-process and measured ~4s on live data —
      // and that is exactly the window the "Reading Daily Ops…" indicator
      // exists to cover.
      const announcedNow = new Set<string>();
      for (const [lead] of toRead) {
        const slice = byToolName.get(lead.name);
        if (slice && !seen.has(slice.id)) {
          seen.add(slice.id);
          announcedNow.add(slice.id);
          yield { type: 'slice', id: slice.id, label: slice.label, href: slice.href };
        }
      }

      type ReadResult = { group: PendingCall[]; output: string; ok: boolean; ms: number; sliceId?: string };
      const results = await mapLimit(toRead, READ_CONCURRENCY, async (group): Promise<ReadResult> => {
        const lead = group[0];
        const slice = byToolName.get(lead.name);
        const t0 = Date.now();

        // Defense in depth. A slice the caller lacks the role for is not in the
        // tool list, so the model should never name it — but the one property
        // this whole design exists for is not left to "should".
        if (!slice) {
          return { group, output: 'No such tool is available to you.', ok: false, ms: 0 };
        }

        let params: Record<string, string | undefined> = {};
        try { params = JSON.parse(lead.args || '{}'); } catch { params = {}; }

        const ctx: SliceContext = {
          teamId: input.teamId, user: input.user, roles: input.roles,
          scope: input.scope, params, host: input.hostContext,
        };

        try {
          const data = await slice.read(ctx);
          return { group, output: data ?? 'No data available for that request.', ok: true, ms: Date.now() - t0, sliceId: slice.id };
        } catch (err) {
          // One bad slice must not fail the chat.
          return {
            group, ok: false, ms: Date.now() - t0, sliceId: slice.id,
            output: `That data could not be read right now: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      });

      for (const r of results) {
        // Sources list what was actually read, so it is appended on success
        // only — an announced slice that then failed is not a citation.
        if (r.ok && r.sliceId && announcedNow.has(r.sliceId)) {
          const slice = byToolName.get(r.group[0].name)!;
          sources.push({ id: slice.id, label: slice.label, href: slice.href });
          announcedNow.delete(r.sliceId);
        }
        yield { type: 'progress', tool: r.group[0].name, ms: r.ms, duplicates: r.group.length - 1, ok: r.ok };
        const [first, ...dups] = r.group;
        nextInput.push({ type: 'function_call_output', call_id: first.callId, output: r.output });
        for (const d of dups) {
          nextInput.push({
            type: 'function_call_output', call_id: d.callId,
            output: `Duplicate of an identical call in this turn; use the result returned for ${first.callId}.`,
          });
        }
      }
      for (const group of overflow) {
        for (const c of group) {
          nextInput.push({
            type: 'function_call_output', call_id: c.callId,
            output: `Not read: more than ${MAX_DISTINCT_READS_PER_ROUND} distinct reads were requested in one turn. Ask again with the broadest parameters the tool accepts.`,
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
