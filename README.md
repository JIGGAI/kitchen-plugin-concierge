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

Requests go to the Codex backend (`chatgpt.com/backend-api/codex/responses`)
using the OAuth credential OpenClaw stores in `openclaw-agent.sqlite`.

**The credential is read, never refreshed.** OAuth refresh tokens are
single-use and rotate; OpenClaw owns that cycle. A second refresher would get
`refresh_token_reused`, and providers commonly treat reuse as a breach signal
and revoke the entire token family — which would take down every agent on the
machine, not just the concierge.

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
