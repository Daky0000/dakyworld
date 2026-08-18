# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This repo holds two products

Read this before touching anything at the root — the layout is not obvious.

| Path | Product | Deployed to |
|---|---|---|
| `server/` | Dakyworld OS, the internal ops app (API + React client) | Railway → **os.dakyworld.com** |
| repo root (`index.html`, `about.html`, … `assets/`) | the public marketing website, static HTML | GitHub Pages → **dakyworld.com** |
| `website-drafts/` | superseded homepage explorations | served but unlinked |

The website sits *at the root, beside `server/`* because GitHub Pages can only
serve from the root or `/docs` on this repo, and changing that needs a
dashboard setting. It is not a mistake — don't "tidy" it into a subfolder
without also changing the Pages source, or the live site 404s.

`CNAME` contains `dakyworld.com`. It claimed `os.dakyworld.com` for months
while that subdomain actually pointed at Railway, so Pages served nothing and
the apex returned 404 with a bad certificate. If the apex ever breaks again,
check `CNAME` against DNS before anything else.

**[DOMAINS.md](DOMAINS.md) is the runbook** — which host owns which domain, the
DNS records that must never be deleted (email, SPF, the `os` CNAME), and the
outstanding zone cleanup that is blocking `dakyworld.com`. Read it before
touching DNS or Pages settings.

Railway's Root Directory is set to `server`, so **`server/railway.json` is the
file that applies**; the root `railway.json` is a fallback for a configuration
that isn't active. Keep them in step.

## Commands

```bash
# Server (from server/)
npm run dev              # tsx watch, http://localhost:4000
npm run build            # builds server/client first, then the API
npm run build:server     # prisma generate + tsc only
npm run seed             # sample client/lead/project/invoice
npm run prisma:migrate   # see the migration gotcha below
npx tsc --noEmit         # typecheck

# Client (from server/client/)
npm run dev              # vite, http://localhost:5173
npm run build            # tsc -b && vite build
```

**There are no tests and no linter in this repo.** `npx tsc --noEmit` in both
`server/` and `server/client/` plus a real build is the whole verification
story — do not claim a change is "tested" on the strength of a passing build.
For anything visual or document-shaped, render it and look (below).

Local setup, the Docker Postgres line, and `DEV_NO_AUTH` are covered in
[README.md](README.md#running-it-locally) — follow it rather than improvising.

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

**Models are chosen by job, never by vendor** — `src/lib/models/`. A caller
says `callModel({ job: "text" })` and the routing decides who serves it:
Gemini writes, ChatGPT draws and builds pages, Perplexity checks facts against
live sources and rewrites drafts into plain English. **Every job falls back to
Claude when the vendor picked for it has no key**, so nothing waits on a
credential and each key the Owner pastes moves one job onto its chosen model.
`registry.ts` holds the vendors, the shipped routing, the published rates and
the fallback; `call.ts` holds one adapter per vendor.

Three things that will bite:

- The three new vendors are spoken to over `fetch`, not SDKs. Anthropic keeps
  its SDK because the agent loop needs tool use and thinking blocks.
- **Gemini rejects `additionalProperties` outright** rather than ignoring it,
  so `forGemini()` strips it on the way out. The schema the caller wrote is
  untouched — it is a translation, not an edit.
- **Perplexity bills per request as well as per token**, and the request fee is
  larger than the tokens on a short call. `REQUEST_FEES` is added to every
  priced Perplexity call; a cost worked out from tokens alone understates one
  by an order of magnitude.

A tool that routes declares `requires: "models"` and a `job`, never a vendor —
naming one would make it refuse work the fallback could still do. What it must
do instead is **say who answered**: `content.factcheck` returns `checkedBy` and
`checkedAgainstLiveSources`, because checking a claim against a model's
training data is a much weaker thing than checking it against the live web and
whoever reads the result has to be able to tell which they got.

**The agent runtime** — `src/services/agents/`. `runner.ts` is what turns a
task into work: it claims an `AgentTask`, builds the prompt from the agent's
ten prompt layers plus its recalled memories plus the resolved record, hands it
only the tools its `toolkit` grants, and turns a manual tool-use loop
(`lib/claudeAgent.ts`) until the agent finishes or escalates. Every call still
goes through `invokeTool`, so the gate is unchanged.

**Check `result.dryRun` before `result.refusedReason`.** A dry run carries a
`refusedReason` too — it is the sentence explaining *why* the call was
downgraded — so checking the refusal first files prepared work as refused,
leaves `dryRunCalls` at zero, and finishes the task `DONE`. The Owner then
reads "done" about work that never happened. This shipped broken once.

Three tools exist outside the catalogue and every agent has them regardless of
its toolkit, because they are how an agent takes part in the system rather than
things it does to the business: `escalate` (stop and ask → `BLOCKED`),
`remember` (write a memory), and `delegate` (hand work to a *direct report*
only — never sideways or upward). A specialist gets the first two.

**Memory is recalled by subject, not by similarity.** `agents/memory.ts` files
a memory against `lead:abc`, `client:xyz` or `self`, and recall returns only
what this agent concluded about the subjects this task is about. An embedding
search would occasionally surface a fact about a different client in the
context of this one, and the failure mode of that is a letter to the wrong
company. `findSecret()` refuses to store anything credential-shaped — a memory
is re-read into a prompt every time its subject comes up.

**There are two scopes and only one is private.** An `AGENT` memory is one
agent's own. A `SHARED` one belongs to the company: `agentKey` is null so it
outlives its author, `authorKey` records who concluded it (`owner` for one a
person typed), and every agent is shown it. **Sharing widens who sees a
memory, never when it comes up** — recall is still by subject, so a shared
fact about one client surfaces only on tasks about that client. `company` is
the shared equivalent of `self` and is recalled on every task. The two are put
in the prompt under separate headings because they carry different authority:
an agent's own conclusions lose to the record in front of it, a house rule
does not. Shared memories get a point of importance in the recall ranking but
not in the stored row, and `pruneMemories()` never sweeps them.

**Agents come in two kinds.** The eighteen management agents recommend and
decide; the eleven `SUB_AGENT` specialists make things — Web Developer,
Graphic Designer, Video Editor, Ad Designer, Proposal Writer, Cold Lead Writer
and the rest, each with `skills` (a client's words, matched by a router)
separate from `toolkit` (a permission). Both kinds seed at autonomy 1 with dry
run on, and the create route cannot say otherwise.

**Every agent's wording is editable, including a seeded one.** That was not
true until Aug 2026 — the API refused to rewrite a built-in agent on the
grounds that shipped wording is a diff, which left the Owner editing
TypeScript or hiring a duplicate agent to say the same job differently. A
prompt is the instruction, so it is theirs. `ensureAgents()` only ever
creates, so an edit survives every deploy; a rewritten seeded agent carries
`promptEditedAt`, and `POST /agents/:key/prompt/reset` puts the seed's wording
back. **Reset never touches the toolkit, the autonomy level or dry run** —
what an agent is told to do and what it is allowed to reach are different
decisions. An edit lands on the agent's next task, because `runner.ts` reads
the row rather than a cache.

**One agent takes one task at a time.** `MAX_CONCURRENT` is the process
ceiling; the per-agent ceiling is one, enforced in the claim itself as a
relation filter (`agent: { tasks: { none: { status: "RUNNING" } } }`) so two
processes cannot both win. The reason is memory as much as legibility: an
agent writes what it concluded as it goes and reads it back on the next task
about the same subject, so two tasks about one lead running side by side
interleave those writes and the agent contradicts itself with nothing in the
timeline to show why. **This makes a stranded `RUNNING` row block its agent
entirely**, which is why `reapAbandoned()` runs on every tick and requeues
anything running for more than 45 minutes that no live process owns.

**Client** — Vite + React + React Router + TanStack Query, in `server/client/`.
The server serves the built client from `client/dist` when it exists, and falls
back to an API-only status page when it doesn't.

**Database** — Prisma, 40 models. `prisma/schema.prisma` is the source of truth.

**Integration keys live encrypted in the database**, not in env vars — the
`AppSetting` model, keyed by `APP_SECRET`. That is deliberate: adding or
rotating a key must never need a redeploy. Env vars still override where they
exist. **Rotating `APP_SECRET` makes every stored key unreadable.**

**The company's own details are data, not constants.**
`services/systemProfile.ts` holds the name, address, phone numbers, socials and
registration details, merged over the `COMPANY` defaults in `dakyworld.ts` and
edited under Settings → System. Uploaded logos live in `AppSetting` as data
URLs, not on disk — Railway's filesystem is ephemeral, so a file written at
runtime reverts on the next deploy and *looks like it worked*. Every surface
that describes the company reads the profile: `emailLetterhead`, `emailRender`,
`letterhead` (via `letterheadIdentity()`), `pdf`, `proposalDocx`, the
unsubscribe page, and the system prompts of the drafter and the proposal writer
(via `contactBlock()`). **Never import `COMPANY` into a new renderer** — that
reintroduces the hard-coded copy this replaced.

PDFKit stamps the letterhead from a synchronous `pageAdded` handler, so nothing
in the drawing code can await a database read. `letterheadIdentity()` gathers
the profile and the artwork once, before the document is built, and is passed
down. That is why `stampLetterhead` takes a second argument.

**Tags are a registry, not a constraint** — `services/leadTags.ts`. Four things
write tags on a lead (a scrape, a spreadsheet import, an inbound webhook, a
person) and three of them invent the words as they go, so a foreign key would
make those writes fail on a label nobody had registered. Instead every tag is
upserted into `LeadTag` as it is used, and `Lead.tags` / `LeadGroup.tags` hold
the **slug** — which is what makes renaming a tag cost one row instead of an
update across every lead carrying it. Anything writing tags must go through
`registerTags()`; anything reading a filter must go through `normaliseTags()`.

`backfillTags()` runs at boot and does two jobs, because tags written before
the registry existed hold *labels* rather than slugs: it registers what it
finds and rewrites the arrays. Skipping the second half leaves a tag showing a
count of zero while a lead visibly carries it, and filtering by it returning
nothing. Both were true the first time it ran.

**Lead capture prices itself from Apify at run time.** `lib/apify.getActorPricing`
reads an actor's published rates (a public endpoint — it works before a token
is connected) and `services/captureCost.ts` turns an input into a count of
billable events. Never hard-code an actor's price: they change, and a stale
number in a spending guard fails silently. Three things depend on this — the
estimate shown before a capture runs, the `maxTotalChargeUsd` ceiling derived
for any pay-per-event run the Owner hasn't capped by hand, and the warnings
about paid switches whose data nothing reads.

**Actors are chosen on measured cost, not reputation.** The comment block at
the top of `services/scraperTemplates.ts` records what each pairing costs and
why it beat the alternative; re-price against `estimateCost` before changing
one. The trap that cost the most: Google Maps bills a *filter* charge per place
per filter, so `skipClosedPlaces` costs more than the closed places it avoids.

**Auth** — `src/middleware/auth.ts`. `DEV_NO_AUTH=true` runs the API as one
implicit Owner and is force-disabled when `NODE_ENV=production`. `requireRole()`
gates the routes that spend money (scrapers, imports) or write to clients.

## The brand design system is canonical

`DAKYWORLD-BRAND-DESIGN-SYSTEM.md` (69 numbered sections, held by the owner)
governs every surface: the website, the OS admin UI, and every generated
document. Reuse existing components and tokens before inventing anything.

```
Ink #08101F   Navy #0B0A16   Blue #3157FF   Blue-light #6490FF
Cyan #6FE4FF  Lime #B8FF3D   Cream #F4F5F0  Muted #69758A  Line #DFE4EB
Space Grotesk (display) · DM Sans (body)
```

Three rules that are repeatedly got wrong:

1. **Lime is action and positive status only** — roughly 1–5% of a surface. It
   is a mark colour and never type on white. On light surfaces the accent is
   blue. Generators that touch both light and dark carry two accent constants
   for exactly this reason.
2. **Blue is structure, selection and emphasis.** When something needs an
   accent and isn't an action, it is blue.
3. **A gold/bronze/ivory identity was retired in Aug 2026.** If you find
   `#C7A24C`, `#8A6A2F`, `#F7F4EE`, `#0B0B0C`, `#6E6A63`, Playfair Display or
   Inter, it is a leftover, not a choice. `website-drafts/` still contains
   them, deliberately, as history.

Token values live in three places that must agree: `assets/site.css` (website),
`server/client/tailwind.config.js` (OS UI), and
`server/src/services/letterhead.ts` (documents, which re-exports to `pdf.ts`).
Near-miss values (`#F5F7F2`, `#68738A`, `#DFE4EC`, `#0B1630`) were swept out in
Aug 2026 — reintroducing one is new drift.

Real logo artwork exists as of Aug 2026 in `assets/brand/`, in an `-on-light`
and an `-on-dark` cut. The wordmark has its own typeface — **never re-set it in
Space Grotesk**. `server/assets/logo.png` and `mark.png` are picked up
automatically by the letterhead at render time; the typographic fallbacks in
`letterhead.ts` and `proposalDocx.ts` exist for when the files are absent and
should stay.

Artwork uploaded under Settings → System wins over both. Order everywhere is
**uploaded → shipped file → type**.

## Render it and look at it

Reviewing document and layout code by reading it does not work here — a
half-page lime dash, a letterhead stamped over a cover page and a mis-set
first-page flag all passed code review and were obvious on sight.

```bash
# HTML → PNG
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --disable-gpu --window-size=1440,900 --virtual-time-budget=10000 \
  --screenshot=out.png "file:///absolute/path.html"

# PDF → PNG (PyMuPDF; poppler/ImageMagick are not installed)
python -c "import fitz; fitz.open('a.pdf')[0].get_pixmap(dpi=110).save('p1.png')"
```

- Chrome needs a `file:///` URL or an HTTP server; a bare path fails DNS, and
  ES-module pages (the React client) need real HTTP.
- Scroll-reveal CSS hides below-fold content — render a temp copy with the
  reveal styles overridden. Scrolling a fixed-header page in headless Chrome
  tends to produce a blank capture; render tall instead.
- Chrome cannot screenshot a PDF — it renders a blank grey page.
- `.docx` → PDF goes through Word COM; a successful open also doubles as a
  corruption check after bulk XML edits.

**Neither brand font is installed on this machine.** Word and local renders
substitute, so headings come out serif. The files are still correct — do not
"fix" a document that only looks wrong here.

## Gotchas that cost real time

- **`prisma generate` fails with `EPERM … query_engine-windows.dll.node`**
  whenever a node process still has the Prisma client loaded — a dev server
  left running from an earlier session counts. Find it with
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`, stop it, retry.
- **Postgres enum values cannot be added and used in one migration**
  (`55P04 unsafe use of new value`) — the addition needs its own earlier
  migration. `prisma migrate dev` is hostile to non-interactive use here; build
  the SQL with `prisma migrate diff --script` into a hand-made folder, then
  `migrate deploy`.
- **Docker Desktop is usually not running.** Launch it and poll for the daemon
  before any `docker run`.
- **Railway's Root Directory and GitHub-repo connections are dashboard-only** —
  the CLI has no subcommand for them. Report the click path instead of retrying.
- Tailwind's config maps `blue`, `lime` and `cyan` to single brand values, which
  replaces those default scales. `blue-500` and friends do not exist; the red,
  amber and emerald scales are untouched and carry error/warning/success states.
- **Uploads ride in the JSON body as base64**, so their paths are excluded from
  the global parser in `index.ts` (`UPLOAD_PATHS`) and each mounts its own
  larger one *inside* its router, after the role check. Adding a third upload
  route means touching both places or it fails at 100 kB.
- **The whole model layer can be exercised without a single real key.** Point
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GEMINI_BASE_URL` and
  `PERPLEXITY_BASE_URL` at one local stub answering `/v1/messages`,
  `/v1/models/:id`, `/v1/chat/completions`, `/v1/images/generations`,
  `:generateContent` and `/v1/sonar`. A stub that fills the caller's own JSON
  schema keeps every adapter honest, and one that 400s on a leaked
  `additionalProperties` proves the Gemini translation. That is how routing,
  fallback, pricing, the dry-run and refusal paths, per-agent concurrency, the
  reaper, shared-memory recall and prompt edits were all verified — a compile
  is not evidence that a loop turns.
- **Verifying an API response through `curl | python` on Windows mangles UTF-8**
  — Python decodes stdin as cp1252/gbk, so `·` comes back as a CJK ideograph and
  a correct render looks broken. Write the body to a file and read it with
  `encoding="utf-8"`, and set `PYTHONIOENCODING=utf-8` before printing any.

## Committing

Push and deploy without asking — the owner has given standing approval for
finished work. Railway auto-deploys `server/` and GitHub Pages auto-publishes
the root on every push to `main`.
