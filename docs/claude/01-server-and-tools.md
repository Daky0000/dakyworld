# The server, and the agent tool layer

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

## Architecture

**Server** — Express, one router per domain under `src/routes/`, mounted in
`src/index.ts`. The mounting order matters: the unsubscribe route is public and
registered *before* `attachUser`/`requireAuth`, `/api/imports` is excluded from
the JSON body parser because it takes uploads, and **both webhook routes sit
above the JSON parser** because a signature covers the exact bytes that were
sent — Stripe's own route first, then the generic `/api/webhooks/:source`.
`src/lib/` holds integration clients (Apify, Anthropic, Google, Stripe,
Cloudinary, mailer, Slack, GitHub, Calendar, webhooks) and `src/services/`
holds the logic that composes them.

**The agent tool layer** — `src/services/tools/`. A tool is a catalogue entry
with a scope, a Zod schema, a handler and (for anything outward-facing) a
preview; `invoke.ts` is the only way one gets called, and it enforces the whole
policy in one place: is the integration configured, has this agent been granted
this tool, does its autonomy level allow acting rather than preparing, is the
input the declared shape. Every call — including every refusal — lands in
`ToolCall`. **An agent's `toolkit` is that grant**, so adding a key on the
Agents screen hands over a real capability.

Adding a tool means adding one entry to `catalogue.ts`. It inherits the
permission model, the audit trail and the Tools screen by existing; nothing
else needs touching.

**The catalogue has two halves.** `TOOLS` is the code half. `mcpTools.ts` is
the other: every enabled `McpServer` contributes its advertised tools as
`mcp.<server>.<tool>` entries, built from the server's own JSON Schema.
`listTools()` / `listAllTools()` / `resolveTool()` span both, and **everything
that grants or calls a tool must go through those rather than through `TOOLS`**
— `findTool` is the built-in half only and is blind to connected servers.

Three things are never taken from a remote server: its scope, whether it spends
money, and whether it reaches outside the company. Those come from the
`McpServer` row the Owner filled in, so a server cannot describe its way past
the autonomy gate. Descriptions are shown to the Owner and passed to the model
as descriptions; nothing in one is ever executed.

