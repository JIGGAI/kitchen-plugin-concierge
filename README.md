# kitchen-plugin-concierge

A read-only conversational concierge for ClawKitchen dashboards. It answers
questions about a host application's own data, streaming the reply, and can
only ever read.

## What it owns, and what it doesn't

The plugin owns the model loop, the slice contract, conversation history, and a
Kitchen configuration tab. **It ships no data access of its own.** The host
application supplies slice implementations, because the host is where its data
layer already lives — and that split is what lets a second deployment adopt the
plugin without forking it.

## The read-only guarantee

`read` is the only verb the slice contract defines:

```ts
interface Slice {
  id: string;
  label: string;
  href: string;          // the page this data is shown on, for citations
  description: string;   // the tool description the model routes on
  role: string | null;   // required role, or null for everyone
  parameters: Record<string, SliceParam>;
  read(ctx: SliceContext): Promise<string | null>;
}
```

There is no write, exec, or fetch capability to deny, because none was built. A
test asserts every slice's only function-valued property is `read`, so adding a
second verb fails the suite rather than shipping. The Kitchen tab can edit the
persona and model but has no route that grants a capability — widening what the
concierge can read stays a commit.

## Role gating

A slice carrying a `role` is **omitted from the model's tool list entirely**
when the caller lacks it, so the model cannot mention or attempt it, with a
second check before any read runs. Identity arrives as a function argument, not
as prompt text, so nothing the model reads can widen it.

## Conversation history

Stored in the plugin's own SQLite database. Nothing is deleted on a timer —
idle threads are summarized and archived with every message row intact.
`deleteConversation` is the only function that removes data.

## Model transport

Requests go to the local OpenClaw gateway's OpenResponses endpoint
(`POST /v1/responses`, `model: openclaw/hmx-govna`). OpenClaw runs the
`hmx-govna` agent with whatever model, credential and provider its config
names, exactly as for every other agent on the box; the concierge never holds
a provider credential. The slices stay client tools: the agent is scaffolded
from `~/.openclaw/workspace/recipes/hmx-govna.md` with no server-side tools,
and each request supplies the function tools the signed-in user may call.

One gateway session per dashboard conversation
(`x-openclaw-session-key: agent:hmx-govna:conv:<conversationId>`), so only the
new turn is sent; the gateway keeps the transcript. Tool rounds continue the
same response with `previous_response_id` and `function_call_output` items.

Resolution of the gateway, in order: `CONCIERGE_GATEWAY_URL` /
`CONCIERGE_GATEWAY_TOKEN`, then `gateway.port` / `gateway.auth.token` from
`~/.openclaw/openclaw.json` (`OPENCLAW_CONFIG_PATH` to point elsewhere).
`CONCIERGE_AGENT_ID` changes the agent. The endpoint must be enabled:
`gateway.http.endpoints.responses.enabled: true`.

A failed call is logged as `[concierge] agent:... gateway <status>: <reason>`
(token scrubbed) and surfaced as an `error` event with `code: gateway_<status>`
and a short `detail`, so the next outage is one grep away instead of a
generic "could not complete that request".

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build     # esbuild → dist/
node scripts/smoke.mjs "your question"   # live, against the real model
```

Installed into a kitchen as a `file:` symlink, so `npm run build` makes changes
live. A host that caches the imported module needs a restart to pick them up.
