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

**There is no linter in this repo, and `server/checks/` is the only committed
test suite.** `npm run checks` (from `server/`) runs every file in it against a
real Postgres, with no API key and no network; `npm run checks:types`
typechecks them. Everything else is still `npx tsc --noEmit` in both `server/`
and `server/client/` plus a real build — do not claim a change is "tested" on
the strength of a passing build.

`checks/` is not `tmp/`. `tmp/` is gitignored and holds the throwaway harness
written to prove one change worked on one afternoon; several of those are
excellent and none of them runs again unless somebody remembers it exists.
A check that belongs in `checks/` is one where a future change breaking it
would be a real regression, and it must need nothing but a database — a check
that needs a credential is a check that stops being run.
`server/checks/README.md` carries the three rules, all learned the hard way in
`tmp/`.
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
**ox-alpha through OpenRouter is the shipped default for every job except
images**, ChatGPT draws, and Perplexity researches companies, checks facts
against live sources and rewrites drafts into plain English when it is asked
for by name. **A job whose chosen vendor has no key — or whose call fails
mid-flight — falls through a chain: the declared fallback first, then every
other vendor that can actually do that job**, so nothing waits on a credential
and each key the Owner pastes moves one job onto its chosen model.
`registry.ts` holds the vendors, the shipped routing, the published rates and
`standInsFor()`; `call.ts` holds one adapter per vendor.

Two things about the OpenRouter half: **the model id is verified against
OpenRouter's own catalogue at key-save time** (`verifyProviderKey` reads
`GET /models`, free and authenticated), so a slug that isn't listed fails on
the screen with the closest matches named rather than becoming a month of
calls that quietly failed over; and **ox-alpha has no published rate in either
pricing table**, so it prices at the dearest known rate in the ledger until
one is added — the safe direction for a ceiling, worth remembering before
concluding the budget is being spent too fast.

**The chain is not decoration — a two-step fallback had a hole in it.** `vision`
is routed to ChatGPT and fell back to Claude only, so a deployment holding a
Gemini key and nothing else had *no model at all* for looking at a page: the
audit paid Apify for two screenshots of a prospect's homepage and then filed
"the homepage was photographed but not reviewed", while a vendor that reads
pictures perfectly well sat connected and unasked. "No model is connected" is
now reserved for what it means — not one vendor that can do this job has a key —
and the sentence names all of them. A vendor that *cannot* do the job is never
in the chain, so Perplexity is never asked to look at a screenshot however many
keys are missing.

**The schema is sent as a schema, or said in words — never neither.** The
largest of the ox-alpha defects and the one that made the analyst look like it
had simply got worse. On OpenRouter, `response_format` in a model's
`supported_parameters` means it takes `{"type":"json_object"}`;
**`structured_outputs` is the one that means the schema is compiled and
enforced**, and 332 of the 416 models listed on 24 Aug 2026 declare it.
**`stealth/ox-alpha` is one of the 84 that do not** — so OpenRouter drops a
`json_schema` sent to it. That would be harmless if the prompt described the
answer, and *not one caller in this app does*: every one of them describes it
entirely in the schema — field names, enums, sentinels, and a `description` per
field carrying the real instruction. The sheet analyst's prompt says "return a
plan" and never says what a plan looks like, because `headerRow`,
`firstDataRow`, the `-1` sentinel and the list of valid field targets all live
in the schema. So the shipped default model was being asked for a plan with no
description of one anywhere in the request; it guessed at the field names, and
`normalizePlan` dropped what it could not recognise.

`openRouterCompilesSchemas()` reads the model's own declaration from the same
free catalogue endpoint `verifyProviderKey` already uses, cached for six hours,
and the answer decides: a model that compiles schemas gets the strict one and
nothing else, one that does not gets `json_object` plus `schemaContract()`
written into its system prompt. **A failed lookup returns `null` and does
both** — guessing wrong in that direction costs tokens, and the other direction
silently un-enforces a schema. `readJson()` also takes a second attempt at a
reply with a sentence of preamble around the object, which is what a model
*asked* for JSON rather than held to it routinely sends; it slices the
outermost braces and parses them, and never repairs malformed JSON, because
guessing what a truncated object meant is how a plan arrives with boundaries
nobody chose.

**The OpenRouter wire carries two more things it silently did not.** `effort` is not
an OpenAI parameter, so for as long as `callModel` existed it put *nothing* on
that wire and every routed job ran at **ox-alpha's own default, which is max** —
triage included, which asks for `low` in so many words and runs once per
*arriving* message. `reasoningEffortFor()` had been written for the agent loop
and lived inside it; it is a vendor fact and lives in `registry.ts` now, and
both halves of the model layer read it. And **`max_tokens` caps reasoning plus
reply on that wire**, exactly as Anthropic's does, so a caller's budget sized
for the answer was being spent thinking: the sheet analyst asks for 16,000
because a plan describing forty columns is genuinely long, and what came back
was an empty message with `finish_reason: "length"` — read correctly as
"produced nothing usable" and handed to the next vendor. The Owner paid for the
reasoning, waited for it, and got Claude's answer. `tokensWithReasoning()`
budgets the thinking on top of the answer, capped at 32,000. Same shape of bug
as the missing prompt cache: nothing breaks, every answer is correct, and the
only symptom is the bill and a slower import.

Four things that will bite:

- The four new vendors are spoken to over `fetch`, not SDKs. Anthropic keeps
  its SDK because the agent loop needs tool use and thinking blocks.
- **A chat-completions `content` is not reliably a string.** OpenRouter fronts
  arbitrary models and some answer with the parts array; that used to reach
  `.trim()` as an array and throw an *uncaught* `TypeError`, skipping every
  failover path below it and surfacing as "Something went wrong" about a
  spreadsheet the Owner was looking at. `assistantText()` normalises both
  shapes. A reasoning model's own thinking is deliberately not read even where
  the vendor returns it — it is not the answer.
- **Gemini rejects `additionalProperties` outright** rather than ignoring it,
  so `forGemini()` strips it on the way out. The schema the caller wrote is
  untouched — it is a translation, not an edit.
- **Perplexity bills per request as well as per token**, and the request fee is
  larger than the tokens on a short call. `REQUEST_FEES` is added to every
  priced Perplexity call; a cost worked out from tokens alone understates one
  by an order of magnitude.
- **Perplexity's `max_tokens` floor is 16.** Below it the answer is a 400, not a
  short reply, and a 400 during key verification reads to the Owner as a
  rejected key. `PERPLEXITY_MIN_TOKENS` clamps both the probe and every real
  call.
- **Perplexity is prepaid, so 401 does not mean "wrong key".** It answers 401
  for a perfectly valid key on an account with no credits left, and keys are
  only issued against a non-zero balance in the first place. Never flatten a
  401 into "rejected that API key" — `describeRejection()` carries the vendor's
  own sentence through, which is the only thing that separates *regenerate the
  key* from *top up the account*.

**The prompt cache is load-bearing and invisible, so it has a check.** An agent
turn re-sends everything before it — the system prompt, every tool definition,
the brief, and every tool result so far — and for a month this app paid full
input rate for all of it. `cache_control` appeared nowhere while `LlmCall` kept
a `cacheReadTokens` column that was always zero and `costOf` kept a multiplier
nothing multiplied. Nothing broke, no test failed, every answer was correct; the
only symptom was the bill, arriving a month later with no way to say which run
spent it.

- **Four breakpoints, and all four are used** (`lib/claudeAgent.ts`): the last
  tool definition, the system prompt, and a **rolling pair** on the two most
  recent user turns. Four is the API's hard limit and a fifth is a 400 — so an
  added one is not a slightly worse bill, it is every agent failing at once.
- **Two inside the conversation, never one.** The newest turn writes what just
  happened into the cache; the one behind it is what the *next* turn reads.
  Marking only the newest writes an entry every turn and reads none, which is
  the expensive half of caching with none of the saving.
- **Breakpoints are applied at send time and never stored.** `messages` is what
  the checkpoint holds, and a breakpoint frozen wherever a process happened to
  stop lands in the wrong place on resume.
- **The one-shot writers cache too**, gated on `CACHE_FLOOR_CHARS` — below
  Anthropic's 1,024-token floor nothing is cached at all, and a write costs a
  quarter more than sending it plainly, so marking a short prompt makes it
  dearer.
- `checks/promptCache.ts` drives the real loop against a fake Anthropic on
  localhost and asserts on **what went over the wire**, because a correct
  `withCacheBreakpoints()` that nothing calls is precisely the bug that was here.

**An agent turn is priced by what the work is, not by what an agent is.**
`modelForEffort()` sends `low` and `medium` to `MODEL_ECONOMY` (Sonnet 5,
overridable at `anthropic.model.economy`) and everything above it to the
headline model. The split follows `effortFor()` in the runner: whoever writes to
somebody outside the company, and whoever sits on the board, keeps the expensive
model; a sub-agent reading a record or checking a link does not. Paying Opus
rates for the second was never a decision anybody made — it was `defaultModel()`
being the only answer the loop knew. **Named the cheap way round on purpose**: a
new effort level above `high` defaults to the better model rather than falling
through to the cheaper one because nobody listed it.

**A tool result is not paid for once.** It goes into the conversation and is
re-sent with every turn after it, so a 16,000-character blob on turn two is
still being billed on turn twelve. `TOOL_RESULT_MAX_CHARS` is 6,000 and
`clipToolResult()` **says when it has cut**, because a silent `.slice()` hands
the model half a record that reads as all of it — an agent concluding "there are
four communications on this lead" from a list cut at four has been misled by its
own tooling.

A tool that routes declares `requires: "models"` and a `job`, never a vendor —
naming one would make it refuse work the fallback could still do. What it must
do instead is **say who answered**: `content.factcheck` returns `checkedBy` and
`checkedAgainstLiveSources`, because checking a claim against a model's
training data is a much weaker thing than checking it against the live web and
whoever reads the result has to be able to tell which they got.

**Nothing writes to a lead until somebody has looked at it** —
`src/services/leadPrep.ts`. A scraped row is a name, an email and three
em-dashes, and an email written from that can only be generic, because generic
is all the record holds. `prepareLead()` runs three stages before a word is
drafted:

1. `leadResearch.ts` — who they are, established against live sources
   (`job: "research"` → Perplexity), filling only *blank* fields on the lead and
   writing the discovery note.
2. `companyAudit.ts` — their site and mail domain, fetched and resolved. The
   checkable half.
3. `siteShot.ts` + `homepageLook.ts` — a screenshot of the homepage through
   Apify's `apify/screenshot-url`, read by a vision model (`job: "vision"`).
   The half markup cannot answer: what a first-time visitor actually sees.

**The scan writes back to the record.** It is not only evidence for a letter:
the trade and town the homepage states fill Category and Location, the
`mailto:`/`tel:`/profile links in the markup fill the contact fields and
socials, the findings become **tags** (`auditTags` — the filterable ones only,
not all of them), and `scoreLead` re-runs on what is now known (`Math.max`, so
a re-run never demotes a lead somebody has worked on). Tags are added and never
removed: a finding that has gone away is good news for the next look, not a
silent untagging that makes an earlier campaign impossible to reconstruct.

**The two contact rules are deliberately different.** An address a *search*
associated with a company is held back for a person, because a search can
attach the wrong company to a name. An address read out of the homepage we just
fetched is written straight in when the field is empty — it cannot be somebody
else's, and the worst case is that it is stale.

**A weak case is an output, not a gap.** `caseStrength()` reads the worst
non-GOOD severity across the audit and the look. When it is WEAK or NONE the
drafter is told **THERE IS NO STRONG CASE HERE** in those words and instructed
to write three honest sentences or to say the lead is not worth writing to; the
polish fails an email built on minor housekeeping whatever else is right about
it; and the composer says so above the draft. This exists because of a real
sent-quality failure: a letter that opened on missing link-preview tags and
closed on missing analytics, about a site that was fine. A system that always
produces an output will produce that email every time.

Then `emailDrafter.ts` picks the **angle** from the one fact that changes it —
no website is a different letter from a bad website — and `emailPolish.ts`
(`job: "humanise"` → Perplexity) reads it last, changing how it is said and
never what it says. `POST /emails/draft` runs all of it and returns the work:
the pre-polish draft, what the polish changed, and anything it *added*, which
should always be empty and is shown loudly when it is not.

Four rules hold it honest, and each has a failure mode behind it:

- **Fill a blank or leave it empty; never overwrite and never guess.** A scrape
  read the address off the business's own listing; a search read it off
  whatever ranked. Every filled value carries the URL it came from, and one
  without a citable source is dropped on arrival.
- **A researched contact address is offered, never applied.** Everything else
  being wrong costs a sentence in a draft somebody reads. An email address
  being wrong sends a letter about a stranger's business to a stranger.
- **A `website` value is validated as a URL before it is stored.** It decides
  which argument the email makes, so garbage there turns Dakyworld's strongest
  opening into a pitch about a site that does not exist.
- **Every stage degrades to a note, never an error.** No Perplexity key, no
  Apify token, a site that blocks headless browsers — each is a sentence in
  `notes[]`, and what comes back is still something a person can send.
- **The email opens where the evidence is strongest, and "strongest" means to
  the business.** `strongestPoint(audit, look)` ranks by severity and then
  breaks ties in favour of what a customer can *see* over what a tool measured.
  This was a real defect: the headline came from `audit.findings` alone, so a
  CRITICAL observation about the page could never beat a MEDIUM DNS detail, and
  a cement manufacturer got a letter about which hostname resolves. Accurate,
  and worth nothing to the reader.
- **The look answers a business question, not a design one.** `worthFixing`
  (problem / costsThem / whyWorthPaying), `fitsTheBusiness` — the gap between
  what a company is and what its page makes it look like, which is invisible in
  the markup and lands hardest with an established firm — and a `plainly` line
  on every observation with no web vocabulary in it at all. The email reaches
  for `plainly`; the owner is not a developer and never will be.
- **When there is no screenshot, the drafter is told nobody has seen the page**
  and forbidden from stretching a technical check into a design opinion; the
  composer says so in amber. Without that, a lead whose Apify token is missing
  silently produces DNS-trivia emails and nobody can tell why.

Results live on `LeadResearch` (one row per lead, `STALE_AFTER_DAYS = 30`), so
the second draft to the same person costs nothing and the Owner can read what
the email was argued from after it has gone.

`services/png.ts` gained a decoder for this: a full-page screenshot arrives
taller than any vision model accepts, so `cropPngTop` keeps the first 2400px and
`downscalePng` then halves it to 1024 wide. It is sixty lines of
`zlib.inflateSync` and an unfilter loop rather than an image library, and it
refuses anything that is not 8-bit non-interlaced — which is everything a
headless Chrome emits.

**Screenshot cost is the actor booting, not the picture** — `siteShot.ts`,
`screenshotActors.ts`. An Apify run starts a container and a browser before it
does anything useful, and that boot is identical for one page or twenty. So
`captureHomepages()` is the real function and `captureHomepage()` wraps it;
`prepareLeads()` batches a whole selection into `ceil(n / MAX_BATCH)` runs
instead of n. Sixty leads is three runs, not sixty. The other levers, in order
of size: not re-shooting what is still fresh (`skipFresh`), `runOptionsFor()`
sizing memory and timeout to the batch (compute is billed in gigabyte-hours),
and `downscalePng` to 1024 — vision is billed in 512px tiles, so 1280×2400 is
15 tiles and 1024×1920 is 8.

**The actor is a setting, not a constant** (`capture.screenshotActor`,
`GET`/`PUT /api/settings/capture/screenshot-actor`, which reports each
candidate's *live* price). Every screenshot actor does the same job under a
different input schema — `urls` vs `link_urls`, `viewportWidth` vs
`window_Width` vs `width`, `proxy` vs `proxyConfig` vs `proxyConfiguration` — so
`buildScreenshotInput()` maps them and **only ever sends a key the actor's own
schema declares**. Apify ignores an unknown key silently, so the failure mode of
guessing is a perfectly successful run at the wrong size with nothing to show
for it.

Shipped default **`i-scraper/website-screenshot`** since 19 Aug 2026: $0.006 a
picture, flat, nothing for the compute. It beats `apify/screenshot-url` (free
beyond compute) on the shape this app actually runs — two pictures of one
homepage in two runs, where a 2GB boot dwarfs a pair of flat fees — and loses on
a batch of twenty, where one boot is spread across forty pictures.

Declaring a key is not the same as taking the value you meant, and swapping
actors is where that bites:

- **`fullPage` is sent `true`.** `apify/screenshot-url` has no such key and is
  always full-page; `cropPngTop` keeps 2400 rows afterwards. Sending `false`
  silently shortens every picture to the window height.
- **`viewportHeight` is a real device height** (800 desktop, 844 phone), not a
  fraction of the width. Three quarters of 390 is a 293px window, which is not
  a shape any site was designed against.
- **The proxy is forced on** whatever the actor's own default says, keeping any
  groups it names. i-scraper defaults it off, and a datacentre IP with no proxy
  is refused by a good share of small-business sites behind Cloudflare — which
  arrives in the report as "their site could not be retrieved".
- **`runOptionsFor` clamps to the band the actor's build declares.** i-scraper
  declares 512–2048MB while its own default run option says 256MB, below its
  own floor. Over the ceiling Apify rejects the run outright.

`fetchSite` checks *both* spellings of the host even when the first works, so
"only www resolves" is found whichever form the scrape happened to record. When
the stored address does not resolve and another form does, `leadPrep` corrects
the record — swapping only the hostname, not adopting the redirect's landing
path — which is the one case where overwriting stored data is a correction
rather than a loss. The fault itself survives as a finding and a tag.

Matching a dataset row back to the business that asked for it goes by
`startUrl`, then final `url`, and only falls back to position when no row
carries an address *and* the counts line up exactly. A picture attached to the
wrong business is a page carrying somebody's name that is not theirs.

**When a check fails, try the obvious alternative before reporting failure.**
This is the habit, not a one-off: `fetchSite` swaps www for the bare host and
retries a 403 as a browser; `leadPrep` photographs the address that *answered*
rather than the one on file; `post()` in the model layer waits out a 429 and
tries again. Each of those was a real failure that reached a person as a
sentence when the system could have solved it — "your website did not load",
"the model provider is rate-limiting this key", and a lead whose screenshot was
taken of a hostname with no DNS record so the look never ran at all.

**Rate limits are a queue, not a failure.** `post()` retries 429 and 5xx up to
four attempts, honouring `Retry-After` and capped at 90s of total waiting. It
matters most for the biggest requests, which are both the likeliest to be
limited and the most expensive to throw away — a demo build loses its design
lookup too. Relatedly: `max_completion_tokens` counts against a per-minute
budget whether or not it is used, so the demo asks for 16k rather than 32k.

**A failed question is not an answer** — `companyAudit.fetchSite()`. The audit
used to collapse every fetch failure into `catch { return null }` and raise a
CRITICAL "their website did not load at all". A real email went out saying that
to a company whose site loads in a second: the address on file was the apex,
which has no DNS record, while `www.` answers 200. So the fetch now tries the
www/apex pair, retries a 403 with a browser user agent, classifies the failure,
and **only DNS saying "no such host" on every candidate becomes a finding**.
Everything else — a timeout, a WAF, a chain Node rejects and a browser repairs —
is a `note`, and notes never reach the drafter. This is the same rule
`probeDns` already followed for DNS records, applied where it was missing. The
drafter and the polish carry it too: a negative claim that is not in the facts
is a false statement about somebody, made to the one person who can check it.

**A certificate warning is clicked past, not reported as a dead end.** The third
rung of that ladder retries a TLS failure with verification off — what a person
does at *Advanced → Continue to site*. It exists because of a real report whose
entire content was "we could not open it, and here is one thing about your mail
domain", about a site every visitor reaches by clicking the same button, with the
expired certificate never named. Now the page is read, every section is marked as
having come over an unverified connection, and the certificate is the loudest
finding in the document with the issuer and expiry date read off the socket
(`cert-untrusted`, CRITICAL; `sec-cert-untrusted` in the audit team; the
`Certificate warning` tag). **[SECURITY.md](SECURITY.md) is where the scope of
that relaxation is written down** — one call, no credential sent, never
`NODE_TLS_REJECT_UNAUTHORIZED`, and `routability()` re-checked on every redirect
hop. The screenshot half cannot follow: none of the three screenshot actors
declares an ignore-certificate input, and inventing one would be a key Apify
silently drops, so `ux.ts` says that in those words rather than blaming a missing
token.

**The outreach doctrine is the authority** —
[`server/src/services/outreachDoctrine.ts`](server/src/services/outreachDoctrine.ts).
It replaced Cold Email Playbook v3 on 22 Aug 2026 at the founder's instruction:
the playbook was to come out of the cold email agent entirely and be rebuilt
from the installed skill libraries. `docs/cold-email-playbook.md` is kept as
history, marked superseded, and **nothing in the code reads it**.

One file now holds all three outbound doctrines — cold, follow-up and
WhatsApp/SMS — because they are one system that has to agree with itself, and
keeping them apart is how the polish stage came to enforce a rule the drafter
had already dropped. Four things in it **reverse** the playbook, so do not
"restore" any of them:

- **The letter opens on the reader, not on us.** The playbook opened every
  email with "Daky here from Dakyworld" *before* the observation. Leading with
  yourself is the commonest reason a stranger stops reading. Dakyworld is still
  named inside the first three lines — `coldEmailChecks` blocks a send
  otherwise — but it comes *after* the thing that was seen.
- **There are no scenarios.** Eighteen numbered letters produced eighteen
  recognisable shapes. The writer now picks a framework from the evidence.
  `coldEmailScenarios.ts` survives as **evidence routing only** — which
  confirmed finding is strongest, and `chooseScenario()` returning null still
  means there is no email — but no part of one reaches a model.
- **Subjects are two to four lowercase words and deliberately boring**, not
  "six words or fewer, specific". The subject's only job is to get the email
  opened.
- **One true proof point belongs in a first email** — 70%+ admin cut, four-hour
  priority-one response, no data-loss incidents — where it fits the issue just
  described. The playbook had none.

What survived is the honesty floor, and it survived because it was never
playbook: only what was confirmed, **what it makes harder rather than what it
has cost**, no price in a first email, no private individual named, and never
implying anything physical (Dakyworld is entirely remote).

`tmp/outreachSwap.ts` is the harness. For every rule it asserts the new wording
is present **and that its opposite is absent**, across the drafter, the phone
drafter and both agent seeds — the negative half being the one that catches the
next version of the bug this codebase has already paid for twice.

**A prompt improvement that never reaches the model is not an improvement, and
the symptom is "nothing changed".** Three ways that happened here, all worth
checking before writing another word of prompt:

0. **The prompt being edited was not the prompt being run.** The largest of the
   three, and the one that made the other two hard to see. Every deliverable
   this company produces — the cold email, the polish, the proposal, the
   WhatsApp message, three audit sections, the demo page, the research — was
   written by a string constant in `lib/` or `services/` that **no screen
   displayed and no edit could reach**, while the Agents screen showed a prompt
   that governed only that agent's own task runs. `DISCIPLINE_AGENTS` made it
   literal: it supplied the name printed on the audit PDF — "Reviewed by the
   Page Reviewer" — while an anonymous constant did the reviewing, and the UX
   prompt actually opened "You are the Dakyworld UI/UX Designer", an agent the
   one-job split had moved off that work. So the doctrine existed twice:
   `outreach.writer`'s seed carried the whole playbook in its `process` layer,
   and so did `draftSystem()`. One was editable; the other was the one that
   ran. **See "Writers read the agent that owns them" below** — that is the fix
   and the rule that keeps it fixed.
1. **A later stage was enforcing the earlier doctrine.** `emailPolish` runs
   *after* the drafter and rewrites the text. Its `TEST.COLD_OUTREACH` still
   required "what it costs them" and treated a self-introduction as
   throat-clearing, so it edited v3 back out of every draft. The last writer in
   a chain sets the house style whatever the first one was told.
2. **The prompt contradicted itself.** The purpose brief said "never what it has
   already cost them" and "the ask is never a meeting"; the legacy `angle()`
   block, emitted immediately after, said "say what it costs them" three times
   and "ask for fifteen minutes". A model given both does not average them — it
   falls back to the generic email it already knew. `angle()` and the scenario
   are two answers to one question, so **only one is emitted**: the scenario
   when the findings chose one, the angle only when they did not.

`tmp/writerAudit.ts` is the tool for this. It prints the composed prompt, asserts
each rule is present *and* that its opposite is not, and reports what fraction of
the prompt is actually facts about the business. Run it before adding
instructions, not after.

**Writers read the agent that owns them** — `src/services/writers/`. Every job a
model writes is named in `registry.ts` and given exactly one owning agent, and
`brief.ts` resolves what that writer is told: a per-job override first, then
**the owning agent's own instruction once a person has edited it**, then the
wording the code ships. An agent may own several jobs; a job has exactly one
owner, because two agents editing one deliverable is the contradiction that
makes a model fall back to the generic output it already knew.

- **Doctrine and contract are different things and only one is editable.** The
  doctrine is how Dakyworld writes this — voice, judgement, what may be
  claimed. The contract is the shape of the answer: the fields, the plain-text
  rule, the severity words that get scored, the opt-out the app appends, the
  fabrication rules on a demo page carrying somebody's real business name.
  `composeWriterSystem()` puts the contract *after* the doctrine and no edit
  path can reach it, so a rewritten voice can make a letter worse and can never
  make it unparseable, uncompliant, or libellous about a stranger.
- **An untouched seed deliberately falls through to the shipped wording.** A
  seeded agent's ten layers describe a colleague ("you report to the CRO,
  escalate when…"); the shipped doctrine describes the letter. Swapping one for
  the other on an agent nobody edited would quietly make every draft worse.
  The first edit is what hands the agent authority over its own deliverable.
- **The override is read with a direct query, not `getSetting`.** That cache is
  per-process and cleared only by the process that wrote it — on more than one
  instance, a brief edited on one would go on being ignored by the other, which
  is this bug again wearing a different hat.
- **`emailPolish` no longer carries its own copy of the checklist.** It runs
  last and rewrites the text, which makes it the house style whatever the
  drafter was told, so it is resolved to the *same* job as the drafter. A
  second copy of a doctrine is a second doctrine.
- The Agents screen's compiled prompt returns `writes`: which deliverables this
  agent's wording governs, and whether it is governing them *yet*. That panel
  is the answer to "where do these words actually go", which the screen could
  not answer before.

`tmp/writerReach.ts` is the harness. It plants a shibboleth in an agent's
wording and asserts it comes out of the real composer, that the contract
survives, that the polish sees the same doctrine, and — the check that catches
the next version of this bug — that **every job in the registry is actually
passed to the composer by the file it claims**, since a job key is a string and
nothing else verifies it. 63 checks, database only, no key.

**The old doctrine also reaches the drafter through the facts.** Two files feed
the cold writer in words rather than in rules: `audit/markdown.ts` writes the
internal email brief the writer argues from, and `audit/synthesis.ts` decides
the `consequence` sentence and the DEMO/FIX ask that go into it. Both were still
saying "ask for fifteen minutes" and "what that costs them" long after the
drafter stopped. **Anything that writes an instruction another writer will read
is part of the playbook surface** — the drafter, the polish, the two agent
prompts, the synthesis and the audit Markdown.

**Effort is a quality decision and it was set wrong.** The cold email — the
shortest, most-read thing the company produces — was drafted at `medium` while a
proposal and a demo page were at `high`. Both email stages are `high` now, and
the agent runner picks by *what the work is* rather than by tier alone
(`WRITES_FOR_OUTSIDE` in `agents/runner.ts`): a judgement or a piece of writing
that leaves the building gets high, reading a record and filing a task does not.

**The playbook guides; it does not dictate.** The scenarios say what a letter
must establish and how small the ask should be. `subjectExamples` and
`exampleAsk` are named that way on purpose — they calibrate register and are
never text to reuse, because twenty businesses in one scenario receiving the
same subject line and the same closing question is a mail merge with eighteen
variants, which is the thing the playbook exists to prevent. The first version
of `scenarioForPrompt()` said `Subject: use "X"` and a model does what it is
told; it now frames both as calibration, and `coldEmailChecks.ts` warns when a
draft reuses one verbatim. **Guards are the exception and are rules** — "never
mention fraud", "no same-day promise" — and are stated as such in the prompt.

`coldEmailScenarios.ts` holds the **eighteen scenarios as data** — signals,
guidance, register examples, and the guard that belongs to that letter and no
other. Eleven are chosen in code from the finding ids the audit produced,
worst first; seven need a person to supply the evidence (a new branch, a
registrar account, a sector incident) and are never chosen automatically.
`chooseScenario()` returning null is a real answer and means there is no email.

`coldEmailChecks.ts` runs the **nine of the fifteen checklist items that are
arithmetic on the rendered text** — unresolved merge fields, the opt-out,
identification, one question, unsupported "most people" claims, marketing
filler, jargon, the subject, the length, the price — against the *polished*
text, because that is what would actually be sent. Blocking failures surface at
the top of the composer in red. The other six are judgement and are listed for
the reviewer, never ticked by code. The reply-based opt-out is appended by
`emailRender` rather than asked of the model: a rule that must hold on every
message cannot depend on a model remembering it.

The same doctrine lives in three places that must agree — the playbook, the
drafter's `SHIPPED_DOCTRINE`, and the `outreach.writer` / `outreach.followup`
prompts — plus the `dakyworld-cold-email` skill for writing outside the app.
**The drafter's copy is now a default rather than the authority**: once either
agent has been edited, its wording is what writes the letter and the constant
steps aside (`services/writers/`). That is what makes the third copy safe —
before it, the agent prompts were documentation of a doctrine that a constant
enforced.
`applyColdEmailPlaybook()` is the one-off pass that puts the v3 wording onto
agents that already exist, marked by `agents.coldEmailPlaybookV3` and skipping
any prompt the Owner has rewritten.


**The phone channels** — `src/lib/{phone,whatsapp,messageDrafter}.ts`,
`src/services/{messageSender,whatsappTemplates}.ts`, `routes/messages.ts`,
`routes/messaging.ts`. Most of a scraped list has a number and no email — a
Maps listing carries a phone number because a customer needs one, while an
address is a thing a business chose to publish — so the largest group of leads
in this database could not be reached by anything the app did.

**One rule shapes the whole module.** WhatsApp carries a message you wrote only
within **24 hours of that person's last inbound message**; outside that window
it carries a template Meta approved in advance and nothing else. A scraped lead
has never written to us, so **every first WhatsApp is a MARKETING template and
waits on Meta's review** — minutes, occasionally a day. That is not a latency
this code can engineer away, which is why `MessageThread.lastInboundAt` exists
and why the window is re-read at the moment of sending rather than trusted from
the composer: 24 hours is long enough for it to have closed since the draft.

**So `wa.me` is a first-class route, not a fallback.** `MessageRoute.LINK`
prepares a message and hands back a click-to-chat link a person opens and sends
from their own WhatsApp — no Business account, no template review, no
per-conversation fee, and it arrives from a human being rather than a brand,
which is what a small business here actually replies to. **A LINK message reads
`READY` until somebody says they sent it** (`markSentByHand`). Copying a link is
not sending a message, and an outbox that marks things sent on the strength of a
click is an outbox nobody can trust about anything.

- **`lib/phone.ts` refuses rather than guesses.** The same handset arrives six
  ways and the number *is* the identity here — it is what a thread is keyed on
  and what an opt-out is recorded against, so two spellings means two threads
  and an opt-out on one that does not stop the other. The failure mode is
  silence, not an error: both providers accept a malformed number and the
  message goes to nobody, or to a stranger under Dakyworld's name.
- **A landline is not "no phone".** A WhatsApp to one is a conversation fee for
  nothing and an SMS to one is money burnt, so `reachabilityOf` reports it
  unreachable *with the reason* rather than quietly trying.
- **An SMS cliff is invisible and `smsCost` is why it is priced in code.** 160
  GSM-7 characters is one segment, 161 is two, and one curly apostrophe pasted
  in from a word processor re-encodes the whole message as UCS-2 and drops the
  limit to 70. `toGsm7` is offered, never applied silently.
- **`MessageSuppression` is keyed on the number and crosses channels.** Somebody
  who replies STOP on WhatsApp has not asked to keep getting texts. An inbound
  STOP also cancels everything queued on both channels and stops any email
  sequence the lead is in — `emailSequences.stopOnReply` is keyed on an address,
  and a lead reached by phone because they have no address could never have
  triggered it.
- **`lib/messageDrafter.ts` is part of the playbook surface.** Same doctrine as
  the email drafter — identify yourself first, say what it makes harder rather
  than what it has cost, no price, an ask that offers rather than requests — and
  a different shape, because there is no signature to append (the name goes *in*
  the words, which the email drafter is explicitly forbidden from doing) and 70
  words is the ceiling rather than the floor.
- **`coldEmailChecks.preSendCheck` took a `channel` rather than being forked.**
  One doctrine with three sets of numbers: the subject check does not run where
  there is no subject, and the length band differs. Two copies of a checklist
  drift, and the drift is invisible until a v3 email and a v2 WhatsApp reach the
  same prospect on the same day.
- **`WhatsAppTemplate` mirrors Meta and never leads it.** Only `syncTemplates`
  writes a status, because Meta is the only thing that knows one — a template
  can be approved and then paused a week later because recipients blocked it.
  `checkTemplate` catches every one of Meta's refusals *before* submission
  (a name with capitals, a body starting or ending on a variable, adjacent
  variables, a gap in the numbering), because each of them comes back as a
  generic "invalid parameter" hours later.
- **A template body is never modified.** Meta approved an exact string, so the
  opt-out is *not* appended to one — which is why every starter template carries
  its own.
- **Meta's error codes are translated.** `explain()` in `lib/whatsapp.ts` turns
  `(#131047) Re-engagement message` into the sentence that says what to do. The
  raw text sends somebody looking for a bug in an app that is working exactly as
  Meta requires. `WhatsAppError`, `HubtelError` and `MessagingError` join
  `AnalystError` and `ApifyError` as the classes whose message the error handler
  passes through, for the same stated reason.
- **`routes/messaging.ts` is public and mounted above the JSON parser** — the
  fourth route on that page for which the signature covers the exact bytes.
  Verification matters *more* here than on the generic webhook route: an
  unverified inbound would open a 24-hour free-form window to a number of the
  caller's choosing, or opt a live prospect out. Meta signs with the app secret;
  **Hubtel signs nothing at all**, so its SMS callbacks carry a secret in the
  query string and are refused without one.
- **`quality_rating` is fetched, not stored.** It falls when recipients block or
  report, a RED number loses the ability to start conversations at all, and
  there is nowhere else in this app to see it.

`tmp/phoneChannels.ts` drives all of it — the number table, the segment
arithmetic, the channel-aware checklist, Meta's template rules, then the whole
send-and-receive loop against a real Postgres and a local stub playing Meta and
Hubtel, then the webhook over **real HTTP mounted as `index.ts` mounts it**.
That last part is the one that cannot be faked, and it is the same trap
`tmp/slackButtons.ts` exists for. It also audits the composed prompt the way
`tmp/writerAudit.ts` does: every v3 rule present, and every superseded one
absent.

**The mail room** — `src/lib/imap.ts`, `src/services/mailbox/`, `routes/inbox.ts`,
the `mail.room` agent. Every email module before Aug 2026 was outbound: the app
could compose, schedule, sequence and send, and had no idea whether anybody
answered. A reply was something the founder noticed in his own webmail and then
remembered to type in — the one step in the pipeline that depended on a person
being at a desk. So a sequence kept writing to somebody who had already said
yes, and the fastest-moving event this business produces reached the system last.

```
IMAP IDLE ──┐
            ├─→ sync.ts ─→ parse.ts ─→ ingest.ts ─→ triage.ts ─→ router.ts ─→ AgentTask
minute tick ┘   (UID       (quote      (dedupe,     (a model:    (a table:
                 cursor)    stripped)   thread,      what is      whose job
                                        match)       this)        is this)
                                            └─→ consequences.ts (no model, always)
```

- **IMAP, not a provider API.** Sending has two paths because the provider
  differences live there; reading has none, and every mailbox this company
  could use already speaks IMAP. The Settings form arrives **pre-filled from
  the SMTP block** — the host is the SMTP host with `smtp` swapped for `imap`,
  the port is 993, and the password is usually the same App Password — so
  connecting is normally read-it-and-press-Connect. Credentials are proved
  against the real server before they are stored, exactly as SMTP is.
- **Both folders are read, and Sent is the half people forget.** The founder
  answers a prospect from his phone; the app knows nothing about it; the
  sequence writes again on Thursday asking whether they saw his first email.
  Reading Sent is what stops that — and a message the *app* sent is told apart
  from one typed by hand by looking its `Message-ID` up in the outbox.
- **The live connection is an optimisation over a poll that runs anyway.**
  `watcher.ts` sits in IDLE so a reply is read in seconds; `readMailboxOnce()`
  is also on the minute tick. Every failure path in the watcher degrades to the
  tick, which is why it is safe to run a socket inside a web process.
- **Consequences are code and run whether or not a model does.** Stop the
  sequence, suppress a bounce, honour an opt-out, log the conversation, move a
  NEW lead to Qualifying. None of that is contingent on an API key, because the
  sequence that keeps writing to somebody who replied is the failure this whole
  module exists to end.
- **An out-of-office is not a reply.** It carries `Auto-Submitted`, arrives
  seconds after a send, and treating it as an answer stops the sequence and
  loses the prospect in silence. `parse.ts` decides from the headers whether a
  machine wrote it and nothing acts on one — except a bounce, which suppresses
  **the address in `Final-Recipient`**, never `mailer-daemon@`.
- **The model says what a letter is; a table says whose it is.** `triage.ts`
  chooses between sixteen named intents; `ROUTES` in `router.ts` maps each to
  an agent, with a `known`/`stranger` split because the same question from a
  client and from a stranger is two different jobs. A model that picked the
  agent could hand a client's complaint to the cold outreach writer, and no
  prompt wording makes that reliably impossible. Below `CONFIDENCE_FLOOR` (0.6)
  the message goes to a person, and a paused or retired agent is not a
  destination — the chain ends at the Mail Room and then at nobody.
- **Routing raises a task; it never sends.** The brief tells the agent to draft
  with `email.draft` and stop, and the existing autonomy and dry-run gates
  decide the rest. On a fresh deployment an answered cold email produces a
  draft in the outbox, never a letter that left unattended.
- **`NEEDS_NO_REPLY` is not cosmetic.** The Inbox screen is a to-do list, and
  the first render of it put a bounce and an out-of-office above a stranger
  asking for a quote. A list that fills with machine mail is a list somebody
  stops reading, and then the enquiry is lost for the reason the module exists.
- **Threading is done by finding the stored message, not by matching a key.**
  A conversation's *first* message has no `In-Reply-To` and no `References`, so
  a key derived from the reference root keys it one way and every reply to it
  another: the letter and its answer were two conversations, and a reply typed
  on a phone was a third. `findThreadByReferences()` looks the ids up against
  `MailMessage.messageId`; the subject-plus-counterpart key is the fallback for
  the many clients that answer with neither header.
- **`triage` is its own model job** (`lib/models/registry.ts`) because it is the
  only one that runs once per *arriving* message rather than once per piece of
  work somebody asked for. Separating it is what lets a busy mailbox be moved to
  a cheap model from the Settings screen without moving everything else. The
  wording is a **writer job** owned by `mail.room`, so editing that agent
  changes how the post is read — see "Writers read the agent that owns them".
- **`ensureAgents()` only ever creates**, so the routed agents — `support.desk`,
  `outreach.followup`, `billing.invoicer`, `proposal.writer`, `cco` — do **not**
  get `inbox.read` and `inbox.handled` on an existing database. Tick them on the
  Agents screen, and set `mail.room` to Active; it seeds DRAFT like every other
  specialist.

**Demos** — `src/services/demoBuilder.ts`, `designReferences.ts`,
`routes/demos.ts`. For a lead with no website or a bad one, the demo is the
strongest thing to offer instead of a call: far easier to say yes to, and it is
the argument itself rather than a claim about the argument. **Playbook v3
narrowed where it appears** — a first email's default ask is the smaller
artefact (the outline, the screenshot, the checklist), and the demo is the
stronger option where the design or the absence of a site is the whole story.
Either way it is an offer, never a request for time. When they agree,
`buildDemo` runs — design direction first (`job: "research"` → Perplexity, with
`search_domain_filter` pinned to variant.com, themeforest.net, motionsites.ai
and aura.build, so the style comes from published work rather than a model's
memory), then the page (`job: "html"` → ChatGPT). It is stored on `Demo` and
served at **`/demos/<slug>`**.

- **The demo banner is injected by `demoBuilder`, never asked of the model.** A
  page carrying a real business's name that does not say it is a concept can be
  mistaken for theirs, by them or by anyone the link reaches.
- **`/demos/<slug>` is public and mounted above the SPA catch-all in
  `index.ts`** or the React app answers it. `/demos` itself has no route there
  and falls through to the authenticated Demos screen — the list of who is
  being pitched to must not be public.
- The served page gets a strict CSP; `sanitiseDemoHtml` strips external
  scripts, iframes, offsite form actions and flags hotlinked images first, so
  the page does not arrive broken by its own headers.
- Nothing builds without a scan behind it. The route answers 409 and the tool
  throws — a guard that only exists in a button is not a guard.
- `EmailPurpose.DEMO_READY` carries the link, and `emailContext` puts the URL
  and whether it has been opened into the facts.

**The website audit team** — `src/services/audit/`, `routes/audits.ts`. Four
reviewers over one site, compiled into one document. It runs on its own at the
end of `prepareLead` (the "Look at them" button sends `withAuditTeam: true`)
and can be run on its own from `POST /api/audits/run` or the `audit.website`
tool. The result is a `WebsiteAudit` row plus two artefacts: a branded PDF for
a person to read, and Markdown the cold lead writer argues from.

```
evidence.ts   fetch once, measure once, photograph twice (1280 and 390),
              and rent a browser once (services/seoAudit.ts)
  ├ ux.ts          job: "vision"  — what a visitor sees, with a box per finding
  ├ performance.ts measured, then job: "text" for the summary only
  ├ content.ts     job: "text"    — the visible words, markup stripped
  └ security.ts    no model at all
synthesis.ts  callClaude, named rather than routed
annotate.ts   draws the boxes; markdown.ts and pdf.ts render
```

- **Two reviewers have no judgement in them and that is the point.** Every
  speed, SEO and security finding is arithmetic on a header, a tag, a DNS
  record or a measured millisecond, and each one is checkable by the person
  reading. A model asked to review a stranger's site for security will find
  *something*, and what it finds is a plausible vulnerability that may not
  exist — in a document that goes out under Dakyworld's name to somebody who
  knows the truth. The speed section's model call writes the summary and cannot
  add a finding.
- **The speed half is measured in a browser, the verdict is not**
  (`services/seoAudit.ts`, `smart-digital/complete-seo-audit-tool`, **billed per
  page analysed** — so `crawlPages` is off and `maxPages` is 1). First paint,
  speed index, blocked interaction, layout shift, image weight in real KB and
  links verified by an actual request are things a fetch cannot answer at any
  price. The actor's own 0-100 score and its own issue list are **deliberately
  thrown away**: two scoring systems in one document is one too many, and it
  would report the same missing title tag twice in different words.
- **Where a measurement and an inference overlap, the measurement wins and the
  inference is dropped.** Counting render-blocking files is a proxy for the
  browser being stuck; unsized images are the usual cause of a page that jumps.
  When a browser has since measured no delay and no movement, neither finding is
  printed — telling somebody their page keeps visitors waiting, when a browser
  timed it and it does not, is a false statement dressed up as arithmetic.
- **A section that could not run is unscored, never zero and never a hundred.**
  `DisciplineReport.scored` exists because the first render read "Content
  100/100 — nobody read the writing on the page": no findings scores a hundred.
  `overallScore` averages only the sections that ran — and refuses to publish a
  number at all below `MIN_SCORED_WEIGHT` (half the weight), because rescaling
  to the sections that ran is also what let one section at 0.22 weight become
  the whole site's score. That shipped as "92/100 — Strong" for a site whose
  certificate had expired and which nobody could open.
- **Regions are fractions of the image, never pixels.** The picture is cropped,
  shrunk for the model and resized again for the PDF. `clampRegion` also
  rescales an answer given in percentages or in 1024-pixel coordinates, which
  is what a model actually returns about a third of the time.
- **The synthesis cannot introduce a fault.** Every `priority` entry must name a
  finding id that a reviewer produced; anything else is dropped and counted in
  the notes.
- **The Markdown is assembled in code and only its prose comes from a model.**
  The next thing that reads it is another model, and a drafter that has learned
  where the evidence lives must not have to re-learn it per company. Its last
  section is the internal email brief and it is labelled as such — that is the
  one part never pasted to the business.
- **PDF text goes through `pdfText()`.** PDFKit's standard Helvetica is
  WinAnsi, which has no arrow, so every "Settings → AI models" note in the app
  rendered as `Settings !' AI models` until it did.
- Deleting a review deletes its files explicitly. The file FKs are ON DELETE
  SET NULL so losing a PDF never costs a report its findings, which means
  nothing else would ever clean them up; `orphanedFiles` covers the cascade
  from a deleted lead.
- `annotate.ts` writes pixels into `png.ts`'s decoder output and carries its own
  5x7 bitmap digits. No canvas dependency and no native build.

**The agent runtime** — `src/services/agents/`. `runner.ts` is what turns a
task into work: it claims an `AgentTask`, builds the prompt from the agent's
ten prompt layers plus its recalled memories plus the resolved record, hands it
only the tools its `toolkit` grants, and turns a manual tool-use loop
(`lib/claudeAgent.ts`) until the agent finishes or escalates. Every call still
goes through `invokeTool`, so the gate is unchanged.

**An agent turn is a job like any other, and it routes like one.** The loop
itself picks its vendor: ox-alpha through OpenRouter first, Claude the floor,
and a rehearsal dies no more on an empty Anthropic balance while ox-alpha sits
connected. A **key-level refusal** (401/402/403) hands the run to Claude
mid-flight — nothing has been spent yet, so the same turn is retried there —
and puts ox-alpha on a 15-minute cooldown so the resumes behind it start on
Claude instead of each paying one call into the same refusal. Rate limits and
timeouts still throw and requeue, exactly as before. The loop's internal state
stays Anthropic-shaped throughout: `openRouterTurn()` translates at the wire
(Anthropic blocks out as OpenAI chat messages, tool results back keyed by call
id), so a checkpoint written by one vendor resumes on the other, and the effort
travels as `reasoning_effort` mapped onto what ox-alpha accepts — low stays
low, medium steps up to high, high rides at max, because the model's own
default is max and leaving it unset would put headline-depth reasoning under
every economy run. `checks/agentLoopOpenRouter.ts` drives the real loop against
a fake OpenRouter and pins the wire shape, the checkpoint shape and the
handover.

**Check `result.dryRun` before `result.refusedReason`.** A dry run carries a
`refusedReason` too — it is the sentence explaining *why* the call was
downgraded — so checking the refusal first files prepared work as refused,
leaves `dryRunCalls` at zero, and finishes the task `DONE`. The Owner then
reads "done" about work that never happened. This shipped broken once.

**Seven tools exist outside the catalogue** and every agent has them regardless
of its toolkit, because they are how an agent takes part in the system rather
than things it does to the business. Three are about the agent itself:
`escalate` (stop and ask → `BLOCKED`), `remember` (write a memory), and
`delegate` (hand work to a *direct report* only — never sideways or upward; a
specialist does not get this one). Four are about working with the rest of the
workforce.

**Agents can reach each other now** — `workflowTools()` in `agents/runner.ts`.
Before Aug 2026 an agent had exactly two ways out of work it could not do: hand
it *down* to a report, or stop and ask a person. Neither is what a colleague
would do, and the result was agents attempting crafts that were not theirs. The
prompt teaches four steps and says to stop at the first one that answers:

1. **`findAgent`** — search the roster in plain words ("edit a video"). Free, no
   model call, matched on skills and mission rather than on tool keys.
   Everything else depends on it: an agent cannot hand work to a key it has
   never seen, and one that cannot *look* would report a gap for a craft that
   has been on the roster since March.
2. **`consult`** — ask a colleague one question and get the answer back inside
   this task. **Deliberately one model call and no tools**, not a nested agent
   run: a consult that could call tools would be a second agent working the same
   task at once, which is the thing "one agent, one task" exists to prevent, and
   it could spend money the asking agent never budgeted for. The colleague
   answers from *its own* prompt layers and *its own* recalled memories of this
   lead — which is the entire value, and is asserted in `tmp/collaboration.ts`
   with a shibboleth planted in the colleague's prompt. Capped at
   `MAX_CONSULTS` (3).
3. **`handOff`** — the work itself is somebody else's craft. Goes *sideways*
   where `delegate` only goes down, so it demands a `why` that lands on the
   brief and on the timeline. Capped at `MAX_HANDOFFS` (2): a task with three
   craft pieces in it was somebody else's brief from the start, and the honest
   answer to that is an escalation.
4. **`needSkill`** — only when `findAgent` found nobody. This is the road to the
   Agent Creator, below.

A consult's answer is put in front of the asking agent as **an opinion, not a
checked fact**, with the standing rule that the record in front of it wins. Two
agents agreeing with each other is not evidence.

**The workforce hires itself, and no model can** — `agents/hiring.ts`,
`routes/slack.ts`, the `people.recruiter` seed. Three steps, and keeping them
apart *is* the safety story:

```
needSkill          AgentGap            Agent Creator       AgentHireRequest    Agent
an agent says   →  demand, counted  →  reads the gap,   →  a design waiting →  the row
"nobody here       per craft           checks the           on a decision       (only
 can do this"      (timesRequested)    roster first                             applyHire)
```

- **`agent.hire` files a request. It never creates an agent.** `applyHire()` is
  the only thing that writes to `Agent`, and it is reached from a signed Slack
  interaction, an authenticated API call, or the AUTO policy — never from a
  model. An agent that could write that table could grant itself any tool in the
  catalogue by hiring a copy of itself with a wider toolkit, and no prompt
  wording reliably prevents that. So the wording is not what prevents it.
- **A gap is demand, and demand is counted before it is met.** A second agent
  asking for the same craft joins the existing row and bumps `timesRequested`
  rather than opening a second one; `requestedByKeys` is the set, so the same
  agent asking twice does not count twice. One agent's frustration is a bad
  reason to employ somebody permanently; three agents on three different jobs is
  a good one, and that fact only exists if the requests land together.
- **The loop closes.** A blocking `needSkill` stops the task at `BLOCKED` with
  its checkpoint kept. When a hire is approved, `nudgeWaitingTask()` appends the
  new agent's name to *both* the brief and the conversation it will rejoin, and
  requeues it — the same mechanism, and the same reason, as
  `appendOwnerAnswer()`. Without it a filled gap is a new agent nobody thinks to
  use and a blocked task that stays blocked.
- **The Agent Creator's real job is the refusal.** The easy answer to every gap
  is yes, and forty agents each doing a third of somebody else's job is worse
  than the nine crafts this started with. `findOverlaps()` puts "this is 75% the
  Video Editor" on the card, and `agent.closeGap` — which names who *should*
  have taken the work, and tells the agent that asked — is expected to be the
  common outcome.
- **The overlap threshold was tuned against real proposals, not chosen.** At
  `score >= 0.25` a proposed Bookkeeper was flagged as 27% the Proposal Writer
  on the single shared word "invoice". It is now `shared.length >= 2 && score >=
  0.4`, at which a genuine second Cold Lead Writer still scores 85%.
  `tmp/overlapCheck.ts` holds both halves: the duplicates that must warn and the
  honest new crafts that must not.
- **The guards all refuse at proposal time**, so what reaches a person would
  work if they said yes: a key already taken or already proposed, a manager that
  does not exist, `agents.maxCustomAgents` (25), `agents.maxHiresPerDay` (3) and
  `MAX_PENDING` (5) waiting. **Zero is a value in those ceilings, not an
  absence** — setting one to zero is the obvious way to stop hiring, and the
  usual `parsed > 0` guard would silently restore the default instead.
- Pending requests **expire after 72 hours** rather than sitting for ever,
  because pending requests are counted: five forgotten ones would stop the Agent
  Creator proposing anything at all with nothing on screen to say why.

**ASK or AUTO, and it is answered from Slack** — `agents.hirePolicy`.

- **ASK** (the default) posts the design to Slack with Approve / Decline /
  "approve these automatically from now on". **AUTO** creates it there and then
  and posts the same card with an Undo on it instead. `/dakyworld hiring
  auto|ask` changes the standing setting, because the moment somebody wants to
  change it is the moment they are reading a hiring card, not the moment they
  are looking at a Settings screen.
- **The policy sits under dry run, not beside it.** An agent in dry run decides
  nothing, so AUTO only comes into play once the Owner has taken the Agent
  Creator out of it. **AUTO decides who exists; it never decides what they may
  do** — every hire lands at autonomy 1 with dry run on whichever way it was
  approved.
- **A hire lands ACTIVE where `POST /agents` lands DRAFT, and that is not an
  inconsistency.** Filling in a form is not by itself a decision to employ
  somebody. Clicking Approve on a card that says *hire this* is, and making
  somebody then find the agent and switch it on turns one decision into two, the
  second of which is invisible and gets forgotten.
- **Slack must never be the only road.** A workspace nobody connected, a signing
  secret nobody pasted, an app somebody removed — each would otherwise mean
  proposals nothing can approve, and the symptom would read as the agent not
  working. `GET`/`PUT /agents/hiring/policy`, `/agents/hiring/gaps`,
  `/agents/hiring/requests` and the panel at the top of the Agents screen do
  everything the buttons do.

**Slack talks back now, and one thing guards it** — `routes/slack.ts`,
`verifySlackRequest()`. Every payload carries an HMAC over the exact bytes sent
plus a timestamp, so the router is mounted **above the JSON parser** in
`index.ts` for the same reason the two webhook routes are. Four rules:

- **An unconfigured Slack refuses everything inbound**, which is the opposite of
  the outbound rule and the right way round for each: failing to *send* an alert
  must not break the work, and failing to *verify* a click must never approve a
  hire.
- **Replay matters here**, so a payload more than five minutes old is refused
  however well it is signed.
- **The signature proves it came from Slack, not that the clicker may decide.**
  `slack.approverIds` is the second check. Blank means anybody in the channel —
  right for a one-person company, wrong the day somebody else joins it.
- **Acknowledged first, worked afterwards.** Slack retries anything it does not
  hear from within three seconds, and a retried Approve would be a second agent
  — so `applyHire` is idempotent about an already-approved request rather than
  throwing, and `tmp/slackButtons.ts` asserts that a re-delivery creates nothing.

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

**Agents come in two kinds.** The nineteen management agents recommend and
decide; the thirty-one `SUB_AGENT` specialists make things — Web Developer,
Graphic Designer, Video Editor, Ad Designer, Proposal Writer, Cold Lead Writer
and the rest, each with `skills` (a client's words, matched by a router)
separate from `toolkit` (a permission). Both kinds seed at autonomy 1 with dry
run on, and the create route cannot say otherwise.

**One agent, one job — one *deliverable*, not one department.** Applied to the
whole roster in Aug 2026, which is where eighteen of the specialists came from.
The Lead Lifecycle Manager was told to "capture, enrich, score, qualify and
route"; Commercial Operations wrote proposals, raised invoices *and* chased
payment; Business Intelligence was four analysts in one prompt. An agent
holding three jobs has one prompt that must describe all three, one toolkit
that is the union of all three, and one memory in which what it concluded about
chasing an invoice is recalled while it is writing a proposal — three separate
ways of being worse at each. The test for anything added: **does this produce
more than one kind of finished thing?** A cold email and a LinkedIn message are
one thing in two wrappers; a proposal and an invoice are two things.

`narrowSeededAgents()` is what carried that split onto a database that already
had the old wording. It runs **once** (`agents.oneJobPass`), only over the
fourteen agents in `NARROWED`, **skips any agent whose prompt the Owner has
rewritten** (`promptEditedAt`), and **never touches a toolkit** — it prints the
tools an agent no longer needs and leaves the untick to a person, because
revoking a grant silently is invisible until the day something cannot be done.

**`ensureAgents()` only ever creates, which cuts both ways.** A new seeded
agent — `design.ux` and `sec.analyst` arrived with the audit team — appears on
the next deploy. A new *tool* added to an existing agent's `toolkit` does not:
the row is already there, so `audit.website` and `audit.read` have to be ticked
by hand on the Agents screen for the SEO Specialist, the Copywriter, the Web
Developer and the Cold Lead Writer. Check that before concluding an agent
cannot do something.

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
anything whose heartbeat has been quiet for five minutes that no live process
owns.

**A run survives the browser, the deploy and the stop button**
(`agents/checkpoint.ts`, `AgentTaskCheckpoint`). `POST /tasks/:id/run` was
always fire-and-forget, so a closed tab never stopped anything; what was lost
was everything else. A task is up to sixteen model turns with tool calls in
them, and a deploy landing mid-task threw all of it away and began again from
the brief — research repaid for, an audit re-run, the same first email drafted
twice. Now the loop hands its whole state out after every model turn **and
after every single tool call**, and a claim with a checkpoint on it rejoins that
conversation instead of starting one.

- **The half-finished turn is the part that matters.** A turn asking for three
  tools with two already run is where a crash is most dangerous, because
  "again" for `email.send` means the prospect gets the letter twice.
  `pendingAssistant` and `pendingResults` hold that turn *outside* `messages`
  — an assistant turn with only some of its results after it is not a
  conversation the API will accept — and a resume runs only the calls that
  genuinely never happened.
- **The iteration cap counts across resumes**, or a task interrupted five times
  gets five times the budget. `attempts` works the other way: it resets on any
  run that *progressed*, so the cap catches a task that keeps dying in the same
  place rather than one that keeps meeting deploys.
- **Every checkpoint write proves ownership** (`runOwner`, matched in the
  update) and touches the heartbeat in the same statement. A process reaped as
  dead that later wakes up finds its token replaced and stops rather than
  writing its stale conversation over the run that took over.
- **A RUNNING task can be stopped now.** It used to answer "it cannot be
  interrupted safely", which was true of a loop that checked nothing and kept
  no place. `interruptRequested` is read between iterations and between tool
  calls — the two points where the conversation is whole — so a stop is a pause,
  and the task returns to QUEUED with its place kept. SIGTERM does the same
  thing to every run at once (`drainRunningTasks()`), and `resumeInterruptedTasks()`
  hands back on boot whatever did not make it.
- **Answering an escalation appends to the conversation, not just the brief.**
  Without `appendOwnerAnswer()` the agent resumes at the moment it asked its
  question, having never been told the answer, and asks it again.
- DONE and NEEDS_APPROVAL clear the checkpoint; BLOCKED, FAILED and CANCELLED
  keep it, which is what makes "Carry on" mean carry on. `pruneCheckpoints()`
  sweeps them after 30 days.

**One id gathers a run** — `traceId` on `AgentTask`, stamped on every
`ToolCall`, `LlmCall` and `AgentTaskTransition` it causes. Every one of those
facts was already being written down and none of them joined up: `ToolCall` had
no `taskId` though `invokeTool` has always been handed one, `LlmCall` had only a
free-text `purpose`, and `AgentTaskStep.toolCallId` was documented in the schema
as the link between the timeline and the audit trail and was **never once
written**, because nothing gave the id back. `invokeTool` returns `callId` now
and the runner puts it on all four step branches.

**Attribution is ambient, and only attribution** — `lib/runContext.ts`, an
`AsyncLocalStorage` the runner enters once around the whole task. A writer
inside a tool handler inside the loop is four frames from anything holding a
task id, and threading one through forty signatures is forty chances to forget.
An explicit argument always wins over the store, which is what stops an approval
executing weeks later from inheriting whatever happens to be running in the same
process. **Nothing in it decides what is allowed** — the grant is still read
from the `Agent` row inside `permissionFor`, because ambient state that changes
permissions is state nobody can review at the call site.

**A task's status has one writer** — `transition()` in `agents/state.ts`. It was
ten: the claim, the reaper, the interrupt, the boot resume, the rate-limit
requeue, two routes, the hiring nudge and `finishTask` twice. Each was correct
alone; together they were a state machine nobody had written down. `ALLOWED`
declares the legal moves, an undeclared one throws, and every move that happens
lands in `AgentTaskTransition` with a reason and an actor.

- **Returning `moved: false` is not an error.** Losing a claim race is normal,
  and so is a slow run finding that the reaper requeued its task — which is why
  `finishTask` passes `expect: ["RUNNING"]` and warns rather than writing its
  outcome over the run that took over.
- **No terminal state reaches another directly.** Rewriting an outcome in place
  is how a run that never happened comes to read as work that did; going back
  through QUEUED means the history shows the re-run. `NEEDS_APPROVAL → DONE` is
  the one exception, because accepting prepared work is a decision about the
  same run.
- **Token counts come from the `LlmCall` ledger, not the checkpoint.** The
  checkpoint is deleted for DONE and NEEDS_APPROVAL, so it could only ever
  answer for runs that failed — and a task short enough never to save its place
  does not write one at all.

**An outward tool call can be asked for twice and happen once** —
`InvokeOptions.idempotencyKey`, derived by the runner as
`${taskId}:${tool}:${sha256(input)}` with the object keys sorted, because a
model does not emit them in a stable order. `invokeTool` looks for a
*successful, non-dry-run* `ToolCall` with that key and returns its recorded
output rather than running again. Deliberately narrow in three ways: opt-in
rather than derived in the gate (two identical sends can be two correct sends —
a monthly reminder is the same payload every month); outward tools only (a
repeated read must not return a stale answer); and checked *after* the
permission gate, so a replay whose grant has been revoked is refused like
anything else. `dispatchWebhook` also carries an `X-Dakyworld-Event-Id` now, for
the receivers we cannot dedupe for.

**Approving a task will not close it while its actions wait.**
`POST /agents/tasks/:id/approve` predates the approval queue, and once the queue
existed the two disagreed: the route wrote DONE while the letter that task had
prepared sat PENDING under Approvals. It answers 409 and names them now.
Deciding the actions is what closes the task.

**The rehearsal room** — `src/services/rehearsals/`, `routes/rehearsals.ts`, the
`/rehearsals` screen. One real website, put through one real workflow, with
nothing able to leave the building. It exists because there was no way to answer
*what would actually happen if I pointed the workforce at this business* short
of making a real lead and giving a real agent a real task — which works, leaves
a real lead in the pipeline, and depends on every agent in the chain being at an
autonomy that cannot send anything.

Nothing is simulated. Same agents, same prompts, same tools through the same
gate, same money, same delegation rules. Exactly three things differ:

- **`AgentTask.rehearsal`** is passed to `invokeTool` as `dryRun`, and
  `delegate` and `handOff` copy it onto the tasks they create — so the
  guarantee holds across a run that fans out to nine agents.
- **`Lead.rehearsal`** marks the scratch lead: hidden from `buildWhere` in
  `routes/leads.ts` (and so from every count, group and export built on it),
  from the dashboard's pipeline count, from the phone-only list, and — the one
  that matters — **refused by `enrol()`**, which is the only door into an email
  sequence. That last one is not belt and braces: the scratch lead starts with
  no address and `leadPrep` fills one in from the business's own homepage.
- **It can be thrown away**, which is what makes the second one cheap.

**The dry run is narrowed to `outward`, and `services/rehearsals/policy.ts`
argues why.** A blanket dry run is the obvious first draft and it is wrong
twice: a read has no `preview`, so `invokeTool` refuses it outright — every
agent in the run blind, every timeline a wall of refusals — and previewing the
writes would mean a rehearsal in which every agent describes work nobody can
open. Reads, writes to our own records, and **spending** all really happen; what
the run cost is totalled on screen instead. `capture.run` is the one to watch:
it spends without being outward.

**A rehearsal has a ceiling in money as well as in tasks.** `MAX_TASKS` (24)
counts conversations, and a conversation is not a fixed price — a run can sit
well inside twenty-four tasks and still spend more than the person watching it
meant to. `Rehearsal.budgetUsd` is checked on every drain (default $3, set on
the start form, **0 means no ceiling** — a `.positive()` guard there would
silently restore the default for the one person who typed 0 on purpose), and a
run past it is stopped with what it spent and what it was allowed written on the
row. The Spent tile shows the ceiling beside the total and the Tokens tile shows
the cached share, because a run whose cache reads are zero is a run that paid
for its instructions a dozen times and nothing else on the screen would say so.

**A rehearsal wakes the agents it needs and puts them back** —
`rehearsals/wake.ts`. Every specialist and most of the board seed as a **draft**
and a draft picks nothing up, so the first version of the screen was five
greyed-out workflows and an errand: switch eleven agents on by hand, and be left
with a floor switched on because of a test, quietly taking real work. Starting a
run now wakes the starting agent plus its whole reporting tree (`reportsUnder` —
the set `delegate` can reach), and `delegate`/`handOff` wake a draft target as
they reach it, which matters most for hand-offs because those go sideways to
anybody at all.

- **A draft is woken; a paused agent is not.** Pausing is something a person
  *did* — it is how the Owner stops an agent's standing work — and a test is not
  a reason to overrule it. Retired likewise. Both refuse with the reason said.
- **`Rehearsal.wokeAgents` is written before the status changes**, in the same
  transaction. An agent awake with no record of who woke it is an agent that
  stays awake, and then a test has permanently changed how the business runs.
- **`restoreWakes()` skips agents another RUNNING rehearsal still needs.** Two
  runs at once will often wake the same specialist, and the first to finish
  putting it back would stop the second dead — with the symptom appearing on the
  *other* run.
- **`restoreOrphanedWakes()` at boot**, beside `resumeInterruptedTasks()`, for a
  container killed mid-run. It also marks that rehearsal STOPPED rather than
  leaving it RUNNING for ever.
- It restores only agents still sitting at ACTIVE, so an agent the Owner has
  since paused or switched on for good is left alone.

**Reasoning is on the timeline now, for every task and not only these.**
`AgentStepKind.THOUGHT` existed since the runtime shipped and nothing ever wrote
one — `runAgentLoop` collected every text block into `narration`, kept it on the
checkpoint and handed it back after the run, so an agent's reasoning was paid
for and shown to nobody. `onText` writes it as it happens.
`dropTrailingThought()` removes the last one, because the final text block is
the summary and gets its own FINISHED step.

The screen's own poll drives the run (`nudge`), which is unusual enough to be
commented at the route: the minute tick would eventually start every queued task
in the tree, and six hops at one a minute is five minutes of a still screen that
reads as a hang. `checks/rehearsal.ts` is the committed half — 51 assertions,
database only — and every claim in it carries the **negative** that catches the
mistake worth catching: an unrestricted agent must still really be allowed to
send, a rehearsal must not blind its own agents, an ordinary lead must still
enrol, an ordinary delegation must *not* come out marked as a rehearsal, and a
paused agent must stay paused. `tmp/rehearsalDrive.ts` drives a whole run
against a local Anthropic stub, starting from a floor where every agent is a
draft.

**What it all costs, and a ceiling on it** — `src/services/costs.ts`,
`src/services/budgets.ts`, `routes/costs.ts`, the `/costs` screen. `llmLedger.ts`
has said since the day it was written that the question the ledger exists to
answer is *"what did this month cost and which feature spent it"*. Nothing
answered it. Every model call had been priced and attributed for months — by
feature, by agent, by task, by trace — and the only way to read any of it was one
task at a time in the agent drawer, one run at a time in a rehearsal, or as a
single number inside `analytics.read`. The screen is entirely read-only
aggregation over `LlmCall` and `ToolCall`, grouped on columns those tables were
already indexed by, so none of it needed a migration.

- **The cache tile is the one worth watching.** The prompt cache went missing
  once for a month: nothing broke, no check failed, every answer was right, and
  the bill was the only symptom. Its denominator is **input + cache reads +
  cache writes**, because all three are input — dividing by `inputTokens` alone
  reports a healthy cache on a run that cached nothing, which is exactly the
  failure it exists to catch. Zero reads says so in amber.
- **Failed, refused and prepared are three different things.** A failure is
  spend (a timeout after the tokens burned costs real money) and is never a
  denominator. A refusal and a dry run are the gate working, and are counted
  apart from a fault — a night when nothing happened looks identical to a night
  when nothing was *allowed* to.
- **A window with none of something says so.** Cost per proposal in a week with
  no proposals is not zero and is not a dash; it is a thing we have no evidence
  about. `costEachUsd` is nullable for that reason and the screen prints "none in
  this window".
- **The outcome ratios share one numerator and do not add up.** Said on the page,
  because attributing each model call to the one business outcome it eventually
  contributed to is much harder than it looks — one research call feeds an email,
  an audit and a proposal — and a made-up allocation is worse than an honest
  ratio because it looks precise.

**A ceiling is `warn → downgrade → approve → pause`, not an on/off switch.**
Lead capture has had `capture.monthlyBudgetUsd` since it could spend and a
rehearsal has had `budgetUsd` since it could fan out; the four model vendors had
nothing. At 50% the screen says so, at 75% the workforce carries on **on the
economy model** (`effortUnderBudget` in `agents/runner.ts`), at 90% spending work
is **prepared for a decision** instead of done, and at 100% nothing new starts.
The middle two are the point: a ceiling that can only stop work is one nobody
dares set low enough to be useful, and both reuse machinery that already exists
rather than inventing a third way for work to be held.

- **Usage is never a stored counter.** It is summed from the two ledgers, which
  are indexed for it. `recordLlmCall` is explicitly allowed to fail silently —
  accounting must not break the work it accounts for — so a counter would drift
  the first time a write failed, and a ceiling that has quietly lost count is not
  a ceiling.
- **Enforced at three points, all of them places where stopping is already
  safe**: the claim in `runDueTasks` (nothing has started, so nothing is
  half-done), the gate in `tools/invoke.ts` for `spends` tools only, and
  `shouldStop` between iterations. **Never inside `callModel`** — stopping
  mid-turn leaves the half-finished turn the whole checkpoint design exists to
  avoid.
- **A read is never held.** Only a tool that spends is gated. A blanket hold
  blinds every agent without saving a penny, which is the mistake
  `rehearsals/policy.ts` argues out at length.
- **A task over its own `budgetUsd` goes BLOCKED, not back to QUEUED.** An
  interrupt requeues, and a task over budget put back in the queue is picked up
  next tick, stopped before it does anything and requeued — once a minute, for
  ever, with nothing on any screen to say why. BLOCKED keeps the checkpoint just
  as an escalation does.
- **Zero is a ceiling, not an absence** — `hardLimitUsd: 0` means stop
  everything on that scope. The usual `> 0` guard reads it as unset, which is the
  same trap `Rehearsal.budgetUsd` carries a comment about.
- **A hard ceiling outranks an approval; a person driving a tool is not stopped
  at all.** Approving a letter is a decision about the letter, not a decision to
  go over budget. `asOwner` skips it like every other check.
- **Nothing is enforced until a ceiling exists**, and a deployment with none
  pays one cached `count()` every thirty seconds for the whole feature.
- `BudgetExceeded` joins `AnalystError`, `ApifyError` and the messaging classes
  as an error whose own sentence reaches the Owner (402), because a fixable
  setting must never render as "Something went wrong".

**A refusal is a third state on the roster screens, and it was invisible.**
`permissionFor` returns `allowed`, `mustDryRun` and a reason; both the Agents and
Tools screens printed the reason **only when `mustDryRun` was true**. So an agent
refused outright — paused, retired, or over a ceiling — rendered exactly like one
that could act freely, and the only symptom was the call failing later. `allowed`
is carried through both rosters now and the sentence is printed whenever there is
one.

**Effort decides the model, not only how hard it thinks** — `lib/claude.ts`.
`callClaude` resolved the model with `defaultModel()` and passed `effort` to the
API as the thinking budget alone, so **every one-shot call in the app ran on the
headline model however cheap the work was**. `modelForEffort` existed and was
wired into the agent loop only, which made the split look finished: a sub-agent
reading a record paid the economy rate while `mailbox/triage.ts`, which asks for
`low` in so many words and runs once per *arriving* message, paid Opus rates on
every one. An explicit `request.model` still wins.

**A job has a tier as well as a vendor** — `models/registry.ts`. `providerModel`
answers "which Gemini"; `modelForJob` answers "how much is reading the post worth
paying for", which is a different question and was not being asked. `triage` and
`organise` ship on the **economy tier** — following a schema, on a job with a
right answer, where nothing returned is read by a customer — and the Owner can
override any job from Settings → AI models (`models.jobModels`, holding only what
differs, like `models.routes`). A model with no published rate is refused on write
and ignored on read: an unpriced model prices at the dearest rate we know of,
which is the safe direction for a ceiling and a terrible place to find a typo.
**A job with no tier declared is `standard`** — named that way round so a job
added later and not thought about costs too much rather than quietly being done
badly.

**Reading a lead sheet is a routed job, so its plan is checked rather than
trusted** — `services/sheetPlan.ts` → `repairPlan()`. `normalizePlan` clamps a
plan to something that *can* be run — real indices, known field targets, unique
keys — and says nothing about whether it makes sense, and it was the only thing
between the analyst and the pipeline. That was survivable while one model read
every sheet and read them well; the honest position on a routed job is that the
next model to serve it is one nobody here has tried. Three repairs, and every
one of them is **reported** at the top of the review screen rather than done
quietly:

- **A table split at a blank row is joined back up.** The prompt calls this
  "the most damaging mistake available to you" and it is not overstating it:
  the fragment sits below the header, so it has no header, so every column in
  it is unnamed, so nothing in it is a name — and `extractRows` drops a row it
  cannot name. The Owner gets an empty group beside a full one that stops
  halfway down their file. Two of five leads, gone quietly.
- **Two tables claiming the same rows are separated.** The opposite failure and
  the worse one, because it does not look like a failure: the same business
  written into two groups, scored twice, written to twice.
- **A table where nothing was mapped as the name gets one anyway.**
  `buildTable` has always rescued this; the analyst's plans went through
  `normalizePlan` instead and did not, so a whole table could import as an
  empty group. Chosen by reading the cells (`nameishness`), not by taking the
  first column going — the leftmost column of a lead sheet is very often S/N,
  and four leads called "1", "2", "4" and "5" are saved in the same sense that
  a shredded document is filed.

**A plan that came back *from* the review screen is never repaired.** A person
who splits a table there has decided to split it, and an "obvious" correction
that undoes what somebody just did by hand is the worst thing this could do.
The other negative that matters as much: two genuinely different tables must
not be merged, so a continuation is only recognised when the later block has no
header of its own, sits at most two *blank* rows below, and fills the same
columns.

`checks/sheetAnalyst.ts` (39) is the committed half — it drives the real
`analyzeGrids` against a fake OpenRouter and a fake Anthropic and asserts on the
request body, then runs the repairs over a sheet shaped like the one the prompt
describes.

**And `repairPlan` had never once been called.** It is the paragraph above,
46 assertions of it, and until Aug 2026 no route reached it: `/analyze` went
straight to `normalizePlan`, which clamps indices and asks no questions. The
protection existed, was tested, was documented here, and was not wired in.
It runs on the analyse path only — a plan coming back from the review screen is
still left alone, for the reason stated above.

**A workbook is read one tab per request** — `services/sheetSource.ts`,
`POST /imports/analyze`. It used to be one request for the whole file: every
tab read and held at once, and all of them in a single analyst prompt. On a
real 39-tab workbook that is a third of a million cells and ~100,000 tokens,
and what came back was `502` with no way to tell whether any of it had run.

The first call opens the import and names the tabs without reading any of them;
each call after it reads exactly one and returns *that tab's* tables. Four
things get fixed rather than one: nothing is held but the tab being read, the
analyst sees one sheet and reads it better than it read thirty-nine, no request
is long enough to be cut off, and the screen gets a count that moves. A tab
that fails stops the run and keeps the ones behind it — "Carry on from <tab>"
resumes at the one that broke.

- **`GridSource` replaced `SheetGrid[]` everywhere it mattered.** It holds one
  grid — ask for the next and the previous is dropped — and `each()` serves a
  whole plan in a single pass while still holding one. Preview went from 18.5s
  to 3.3s on 39 tabs that way. `commitPlan`, `normalizePlanFrom` and
  `buildPreviewsFrom` all take one.
- **The cache holds the file, not the parse.** 20 MB of bytes rather than a
  third of a million cells, so the browser sends the workbook once instead of
  attaching it to all 39 calls.
- **Re-reading a tab replaces its tables rather than appending them.** A retry
  after a dropped connection would otherwise double that one group, silently,
  and only that one.
- `checks/bulkImport.ts` (16) is the committed half. The assertion that matters
  most is that reading tab by tab produces the plan reading them together does.

`checks/modelChoice.ts` (18), `checks/costs.ts` (32) and `checks/budgets.ts` (33)
are the committed halves. The first asserts on **what went over the wire** against
a fake Anthropic, because a correct `modelForJob()` that nothing calls is
precisely the defect it was written for; the other two need only Postgres. All
three carry the negatives that matter more than the positives — a standard-tier
job must stay on the good model, an explicit model must still win, an unbudgeted
agent must still really spend, and a read must never be held.

**Client** — Vite + React + React Router + TanStack Query, in `server/client/`.
The server serves the built client from `client/dist` when it exists, and falls
back to an API-only status page when it doesn't.

**Database** — Prisma, 62 models. `prisma/schema.prisma` is the source of truth.

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

**A lead belongs to a list, and the list is the unit** — `routes/leads.ts`
(`GET /grouped`), `services/leadSearch.ts`, `resolveGroup()` in
`services/scraperRunner.ts`. Grouping was already the leads screen's default
and was doing none of the three things that word implies. Four defects, one
shape:

- **A list was whatever fell in the first page.** `GET /api/leads` returned up
  to 300 rows by date and the *browser* bucketed them, so a list of 400
  rendered as a block of 300 with "300" in its header and the older list under
  it did not appear at all. The number in a block header is what somebody sizes
  an outreach batch against. `GET /leads/grouped` groups where the counts are:
  `total` and `withEmail` are the whole list under the current filters, `leads`
  is only the preview that was asked for, and the two are separate fields
  because conflating them is the bug. Filtering to one list asks for 200 rather
  than 25, or "open this list" would answer with the same rows.
- **Search reached seven Lead scalars.** A list's own columns live in
  `Lead.customFields` — that is the whole point of an imported list keeping its
  columns — so typing a value *visible on the screen* returned nothing.
  `leadSearch.ts` adds the list's name and every custom column of every list,
  the latter through a raw `jsonb_each_text` scan because Prisma's JSON filters
  need a `path` and the keys differ per list. **Values only**: matching keys
  too would make a search for "notes" return every lead in every list with a
  Notes column. One asymmetry is written down rather than papered over — that
  arm escapes `%`, and Prisma's `contains` cannot, so a bare `%` is a wildcard
  in the scalar half.
- **Searching dissolved the lists.** It flattened to one ranked run of rows on
  the reasoning that a search is a question about everything. True, and the
  conclusion does not follow: "which list is this business in" is most of what
  is being asked. Lists with no match drop out server-side, so what is left is
  the answer.
- **A scrape could never add to a list, only open one.** Every shipped template
  ended its group name in `{{date}}`, so the daily healthcare capture produced
  "Healthcare · 2026-08-24", then "Healthcare · 2026-08-25". Nobody wanted a
  list per run — `Lead.scraperRunId` already answers which run, and the leads
  page already filters by it — and an audience only exists if the same list is
  added to. `ScraperSource.leadGroupId` pins the list a source fills: the pin
  first, then **adoption** of a list already carrying the name, then a new one.
  The pin wins over the name, so renaming a list does not fork it, and adoption
  is `update: {}` — a source landing in somebody's existing list must not
  rename it, re-tag it or touch what is in it. `{{date}}` still works for
  somebody who genuinely wants a list per day; nothing ships with it.

**A column nobody named is named from what is in it** — `readColumn()` in
`services/sheetPlan.ts`. "Column F" is what the file calls a position, not a
name, and a blank header matches no header rule — so an unnamed column of email
addresses was mapped to `custom` and the leads it created had **no
`contactEmail` at all**. Reachable businesses filed as unreachable because a
header cell was empty. The cells answer both questions: what to call the column
and, where the contents can only be one thing, which Lead field it belongs in.

- **Only the first three suggest a field.** An address with an @ in it is an
  email address whatever the column is called; a column of dates could be a
  follow-up date or a date added and nothing in the cells says which.
- **A column of Facebook pages is not a website column.** It is named after the
  host it points at, and mapping it to `website` would send the audit to read a
  login page.
- **A date is excluded from the phone rule by shape.** "2026-01-04" is ten
  characters of digits and separators, which also describes 0244 987 654 — so a
  column of follow-up dates read as phone numbers and went onto `contactPhone`.
- **A column somebody named is never renamed from its contents**, in either
  direction. The review screen exists so a person can decide, and reading the
  cells over the top of that undoes what they just did. Wired into `buildTable`
  *and* `normalizePlan`, because every plan goes through the second one — the
  analyst's, the rules' and the one the review screen sends back — and only
  that path had no way to look at the cells.

`checks/leadGroups.ts` (41) is the committed half, database only, and half of
it is the negatives above.

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
implicit Owner and is force-disabled when `NODE_ENV=production`. Sign-in is
email + password + an optional TOTP second factor (`lib/totp.ts`,
`routes/auth.ts`).

**Access is data, not code** — `lib/permissions.ts`, `lib/accessRoles.ts`,
`middleware/permissionGate.ts`, `routes/access.ts`, the `/team` screen. Until
Aug 2026 it was six values in a Prisma enum and `requireRole("OWNER", …)`
written into twenty routers, so "can a Project Manager see invoices" was a code
change and a deploy — and there was no screen for any of it: the endpoints to
invite somebody and set their role existed and **nothing in the client had ever
called them.**

- **The catalogue is code; the grants are rows.** `PERMISSION_MODULES` is the
  list of every gateable action, because a permission is only real if a route
  checks it — a row in a table no gate names is a tick that reads as a
  restriction and enforces nothing. `AccessRole` stores only *which* of those
  keys a role holds, so the Owner can invent "Lead" without a deploy.
- **`gateBy` is one line per router, keyed on the HTTP method**, with a `routes`
  list for the actions that are not CRUD (sending, importing, anything that
  spends). The alternative was `requirePermission` on each of ~300 routes, whose
  failure mode is not a compile error but one POST somebody forgot.
  **`view` is required for every request**, so nobody can write into a module
  they cannot read.
- **Effective access is `(role + extra) − denied`, and deny wins.** A revocation
  that silently reverses itself when somebody later widens the role is the kind
  of thing nobody notices until it is in a log.
- **The Owner role short-circuits before the list is read.** That is what makes
  a lockout impossible, and therefore what makes every other role safe to narrow
  to nothing.
- **`ensureSystemRoles()` sets permissions on create and never on update.** The
  single most important line in the feature: a seeder that reinstated the
  shipped list would undo the Owner's own tightening on the next deploy, with
  nothing on any screen to say why access came back.
- **A new account and a new role both start with nothing.** The old invite route
  defaulted people to `DEVELOPER`, which on the day this shipped meant every
  lead, client, proposal and invoice in the business, chosen by a `.default()`
  in a Zod schema.
- **`STARTER_ROLES` is the exception, and a different category from
  `SYSTEM_ROLES`.** A system role is furniture — undeletable, fixed name,
  referred to by key in this codebase. A starter role is a *head start*: an
  ordinary editable row that arrives with sensible ticks on it and can then be
  renamed, narrowed or thrown away. `Lead` is the one, and its permission list
  is **derived from `moduleKeys("leads")` rather than written out**, so a lead
  permission added in six months is in the role whose entire definition is "all
  of them" without anybody remembering. Seeded once behind
  `SETTING.ACCESS_STARTER_ROLES`: checking whether the row is *absent* instead
  would resurrect a deleted role on every boot, for ever, with nothing on any
  screen to explain it. `ensureStarterRoles()` takes the seed list and the
  marker as arguments because that is the only way `checks/access.ts` can
  exercise it without deleting and recreating the real `Lead` row — a check that
  quietly widens somebody's access is worse than anything it catches.
- **Nobody may grant what they do not hold**, and nobody edits their own access.
  Without the first, `team.access` is equivalent to every permission in the
  catalogue.
- The `Role` enum survives on `User` and **decides nothing** — it is kept in
  step with the seeded role for the old rows and for `OWNER_PASSWORD`
  bootstrapping. `scopeExternal` replaces `scopeClientViewer` and keys off
  `AccessRole.external`, still a closed door until a client portal exists.
- Three keys were **deleted rather than shipped** because no route could enforce
  them (`leads.assign` — `Lead` has no assignee column; `inbox.reply` —
  answering is a send, governed by `emails.send`; `settings.security` — no such
  route). `checks/access.ts` fails if a catalogue key is never gated, or if a
  gate names a key that cannot be granted.

`checks/access.ts` is the committed half (55 assertions, database only).
`tmp/accessOverHttp.ts` is the one that cannot be faked: it signs a real person
on a narrow role in over real HTTP and asserts the 403s, because a gate that is
registered but never mounted compiles, unit-tests green and lets everything
through. **Run it with `DEV_NO_AUTH=false`** — `.env` sets it true, and against
an implicit Owner every refusal assertion fails and the cause looks like the
gate.

**[SECURITY.md](SECURITY.md) is the security runbook** — what protects what,
where each control lives, the two accepted risks, and the four things still
waiting on somebody with a login. Read it before touching auth, headers, uploads
or the webhook intake. Four rules from it that are easy to undo by accident:

- **Never write `include: { user: true }`.** A whole `User` row carries the
  password hash, the TOTP secret and the recovery-code hashes, and
  `GET /api/projects/:id` shipped all three to every signed-in user for months.
  `select: PUBLIC_USER` from `lib/userSelect.ts`.
- **`trust proxy` is a hop count, never `true`.** The login limiter reads
  `req.ip`; trusting the whole chain means trusting whatever the caller put at
  the front of `X-Forwarded-For`, which turns a per-address limiter into a
  per-request one that stops nobody.
- **Every path that sets a password goes through `lib/passwordPolicy.ts`.**
  There were three copies of `min(10)` in two files before it; the weakest path
  is the one an attacker uses.
- **Uploads are judged on their bytes** (`lib/fileType.ts`), never on the
  filename or the `data:` prefix, both of which the caller writes.
- **A 500 is deliberately uninformative, and two error classes are exempt.**
  `AnalystError` and `ApifyError` are raised on purpose, at a known point, with
  a sentence somebody wrote for the person reading — "Add a ChatGPT key under
  Settings → AI models" is the answer, not a leak — so the handler in
  `index.ts` passes their status and message through. Everything else that
  reaches there is an accident, and an accident's message is a map of the
  system. This mattered: building a demo with no model connected threw a 503
  saying exactly what to do about it, and the Owner was shown "Something went
  wrong." The client now appends the log reference to that sentence so the
  useless version is at least traceable.

## The website editor

`src/services/website/`, `routes/website.ts`, the `/website` screen, and
`admin/index.html` at the repository root. Lets a non-technical person change
the words, links and pictures on a page of dakyworld.com and publish it, without
touching HTML and without waiting for a developer. The same module is what would
carry a client's site: `Site` has a `clientId` and nothing in it is shaped around
Dakyworld being the only row.

**The editable-region model, not the block model.** Pages become a list of
fields — headings, paragraphs, list items, link labels and destinations, image
sources and alt text — grouped by the section they sit in, with each section
named after its own heading. Adding, removing and reordering sections is
deliberately **not** offered: that needs a component library that knows how to
render a new section, and rebuilding this homepage's arches, orbs and count-up
figures as generic blocks would be a redesign wearing a migration's clothes.

```
GitHub (or the live site)  →  parse.ts     offsets for every element
                              regions.ts   fields, grouped into sections
                              sanitize.ts  what a client may put back
   SitePage.draft ──────────→ applyValues  splice the original bytes
                              publishPage  one commit → Pages rebuilds
```

- **Nothing is re-serialised.** `parse.ts` exists to answer one question — which
  bytes may be replaced — and an edit is a splice at recorded offsets. Every
  ordinary parser gives you *a* document back rather than *the* document, and the
  diff on a publish would be the whole file instead of the heading that changed.
  `checks/website.ts` holds it to that against every real page in this repo.
- **The repository is the source of truth; only the edits live here.** A draft is
  `{ fieldId: { value, original } }` — never a copy of the page — so a developer
  goes on editing these files underneath. Ids are positional, which is why
  `original` exists: a draft written against a heading that has since moved
  **refuses to publish and says so** rather than writing itself into whatever now
  sits at that position.
- **Read from GitHub when a token is configured, from the live site when not.**
  The second is the honest fallback rather than a blank screen. **Writing has one
  route**, and publishing without a token that can write says so — it does not
  save a draft and call it published. The repository must also be on the writable
  list under Settings → Developer; that list denies by default.
- **What a build script owns is not offered.** Everything between a `BEGIN`/`END`
  comment pair is excluded, keyed on the convention rather than the two block
  names, so the generated `<head>` metadata and the visible breadcrumbs cannot be
  edited into something `npm run site` silently reverts a week later. The title
  and description sit *outside* the markers and are editable, and carry a note
  saying their generated link-preview copies need `npm run site` afterwards.
- **The preview needs three things and is wrong without any one of them** —
  `previewDocument()`. A `<base>`, because the HTML is served from the OS's
  origin where the site's CSS does not exist. The page's own CSP widened so
  `'self'` includes the website, sent **as a header**: a `<meta>` policy can only
  narrow what a header already allows, so the app's own header went on forbidding
  the site's stylesheet however the tag was rewritten, and the preview rendered
  as unstyled black text. And `form-action 'none'` plus `frame-ancestors 'self'`,
  because a preview of the contact page must not send a real enquiry. Analytics
  hosts are stripped from the policy so an afternoon of editing does not appear
  in the owner's own traffic.
- **Stripping a tag is not the same as removing the code.** `sanitize.ts`
  unwraps unknown elements and keeps their words, which is right for a pasted
  `<div>` around a sentence and nonsense for `<script>`: the parser never reads
  into one, so "its children" is the raw source, and a heading cheerfully
  displayed the words `alert(1)` to every visitor. `CODE_ELEMENTS` are dropped
  whole.
- **`class` and `data-*` survive sanitising on purpose.** The homepage figures
  are a `<strong class="count-up" data-target="70">`, and dropping the attributes
  would freeze the number at zero.
- **Pages are discovered, never seeded.** From the repository tree where a token
  exists, from `sitemap.xml` otherwise — and **a file the sitemap does not list
  arrives hidden**, which is how the plan document and the 404 stay out of a
  client's page list without anybody naming them in code.
- `dakyworld.com/admin` is a static page that hands you to
  `os.dakyworld.com/website`. It does **not** ask for a password: Pages has no
  server to check one against, so a form there would post credentials to another
  origin, which is the shape of a phishing page. It does not redirect on its own
  either — a page that bounces you onward bounces you onward when you press back.

**Three modes, and Visual is the one people use.** *List* is the form — every
field under its section, the only view that can answer "did I miss anything"
and the only one that reaches a field with nothing visible to click (the title,
the description). *Preview* is the page with no editor furniture on it at all.
*Visual* renders the real page and you click the thing you want to change.

- **No drag and drop, and nothing moves.** What that phrase usually means is a
  layout builder with a component model; this site has none, and turning
  somebody's hand-written HTML into something only the builder can open is the
  opposite of the point. Selection, words, and look — nothing else.
- **The server marks the elements, the browser does not find them.**
  `previewDocument(html, url, fields)` inserts `data-dw-field` at each field's
  `attrInsert` under `?pick=1`; the frame posts up which one was clicked. The
  ids are positional, so working them out on the other side of the frame would
  be a second `readPage` that has to agree with the first for ever.
- **The picker's script and styles carry a nonce the response's CSP names**, so
  the page's own inline scripts stay forbidden and only this one runs. Clicks
  are swallowed rather than followed, for the same reason `form-action` is
  `'none'`.
- **A style is an inline `style` on the element that was selected**, never a
  rule in a stylesheet — a rule applies to every page at once and to elements
  nobody was editing. Anything the panel has no control for is left as the
  developer wrote it and named on screen, so it is visible that it survived.
- **`safeStyle` filters what is stored as well as what is written.** Nothing in
  the panel can produce a bad declaration, so it is not the editor this guards
  against: a draft is stored JSON that outlives its session and is spliced into
  a public page. `url(` goes because it fetches from a page with a strict CSP,
  `expression(` because old IE ran it, and anything with a quote or an angle
  bracket in it because that is how you leave an attribute.
- `checks/websiteVisual.ts` (165) runs against every real page here: marking 203
  elements changes no field's value and lands no mark outside a tag, and a style
  edit is still a one-line diff in a 474-line file.

Built from `reusable_website_editor_system_plan.pdf` (23 Aug 2026), whose block
model was deliberately not followed for this site; the plan lists converting an
existing hard-coded website as a non-goal for version one, and this is why.

## The website's metadata is generated

Everything between the `BEGIN SEO` / `END SEO` markers in each `<head>`, the
visible breadcrumbs, `robots.txt` and `sitemap.xml` all come from
`scripts/build-seo.mjs` and `scripts/build-breadcrumbs.mjs`. **Hand-editing
inside the markers fails CI.** Change the table at the top of the script and run
`npm run site`; the page copy itself (title, description) is read *out* of each
page rather than written into it, so the words stay the owner's.

```bash
npm run site        # regenerate metadata + breadcrumbs, then check links
npm run security    # secret scan (tree and history) + dependency audit
npm run links:fix   # rewrite any .html internal link to the canonical form
```

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

- **ExcelJS is read by streaming, and both halves of that bite.**
  `workbook.xlsx.load()` builds the entire file as an object model — a 4.5 MB
  workbook peaked at ~600 MB resident and never gave it back, and the wizard
  pays for it twice (tab list, then analyse), which is how a large sheet took
  the service down mid-request. `parseWorkbook` streams. Two traps in the
  replacement: **`styles: "cache"` is not optional** (a date is a number plus a
  number format that lives in the styles part — ignore it and every date column
  comes back as `46023`), and **every worksheet must be drained, wanted or
  not**. ExcelJS buffers each sheet to a temp file and opens a read stream per
  sheet on the way back; skipping one deletes the file and leaves the
  descriptor. Reading one tab out of 39 leaked 38, and a bulk import died
  partway through the commit with `EMFILE: too many open files` naming a file in
  `node_modules`. The reader also **races on workbooks small enough for every
  zip entry to land in one tick** — an 8 KB file with hyperlinks failed 14 times
  in 20, a 560 KB one with sixteen thousand failed none — so it retries three
  times and then falls back to loading the workbook whole.
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
- **Both audit actors can be checked without a token.** `tmp/actorWiring.ts`
  builds each run body against the actor's live published schema and asserts
  every key sent is one it declares, then reads the actor's own documented
  example output back through the parser. That is the trap: an undeclared key is
  ignored in silence, so a misspelt `crawlPages` is not an error — it is a
  five-page crawl at five times the price. `tmp/renderedFindings.ts` covers what
  the speed section does with the measurements, including both suppressions.
- **The audit team can be exercised without a key, a token or a real site.**
  `server/tmp/` is gitignored and is where the throwaway harnesses go: a stub
  screenshot built with `encodePng`, handed in as `desktopShot`, is what
  exercises the annotation and the PDF's image path; pointing the base URLs at
  a local vendor stub is what exercises the four reviewers, the region clamp
  and the synthesis's invented-id filter. Then rasterise the PDF and look at
  it — four defects in the first render survived a clean typecheck, including a
  section scored 100/100 under the headline "nobody read the writing on the
  page".
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
- **Every job can be proved to work on its assigned vendor.**
  `tmp/modelJobs.ts` sends one real tiny request per job and reports what came
  back — a key that is present is not a key that works. Against `tmp/vendorStub.ts`
  all six answer; against a laptop with no keys all six say "waiting on a key",
  which is not a fault. The stub gained a `/v1/sonar` route because without it
  Perplexity's three jobs — factcheck, research, and the plain-English pass over
  every outbound email — could not be exercised at all without a prepaid key,
  which is how a defect in that pass went unnoticed.
- **Agent prompts are refreshed, not migrated one marker at a time.**
  `refreshUneditedSeedPrompts()` runs on every boot and updates any agent whose
  prompt is still exactly what shipped; `promptEditedAt` is what protects the
  Owner's own wording. It replaced a growing pile of one-off marked passes, each
  of which only landed if somebody remembered to add a marker. **Compare layer
  by layer, never by stringifying the prompt** — Postgres normalises `jsonb` key
  order, so serialising both sides reports a difference every time, and the
  first version rewrote all forty-nine agents on every boot and called it work.
- **The playbook engine is checked without a key or a database.**
  `tmp/coldEmailPlaybook.ts` asserts the scenario chooser picks the certificate
  over four other findings, that a manual scenario can be asked for by name but
  never fires on its own, that no findings yields no scenario rather than an
  invented one — and runs the checklist over a deliberately terrible draft to
  prove each of the nine items catches what it claims to.
- **The certificate bypass is verified against live broken hosts.**
  `tmp/certBypass.ts` uses badssl.com — expired, self-signed and wrong-hostname —
  because a mocked error code proves nothing about what Node does with a real
  socket. Two of its five cases are negatives and matter more than the
  positives: a *good* certificate must still be verified, and a domain that does
  not resolve must still report as not resolving. `tmp/certFinding.ts` runs the
  whole `auditCompany` path and checks the finding a cold email would argue from.
- **The agent loop's interrupt and resume are verified against a real
  database.** `tmp/checkpointResume.ts` runs the whole runner against a local
  Anthropic stub using `remember` as the tool — every call leaves a row, so
  "was this called twice" is a count rather than an opinion — and
  `tmp/agentRecovery.ts` covers the deploy kill, the silent hang, the slow run
  that must be left alone, and the cap. The first attempt at the first one gave
  six false failures because three tool calls against a local database finish
  before a poller can ask the task to stop: an interrupt test needs enough work
  in flight to have a window to land in. `tmp/rosterCheck.ts` checks every seed
  for a duplicate key, a `managerKey` pointing at nobody (which silently breaks
  `delegate`) and a `toolkit` naming a tool the catalogue does not have.
- **The hiring loop and the collaboration tools need no key either.**
  `tmp/hiringLoop.ts` runs the whole thing against a real local database — the
  line that matters most in it is that a proposal under ASK creates *nothing*.
  `tmp/collaboration.ts` drives a real `runTask` against an Anthropic stub that
  plays two parts, the asking agent's loop and the consulted colleague, told
  apart by what is in the system prompt; a shibboleth in the colleague's prompt
  is what proves a consult is not the asker talking to itself.
  `tmp/slackButtons.ts` mounts the Slack router exactly as `index.ts` does and
  drives it over real HTTP, which is the only way to catch the classic failure
  here: a router below the JSON parser sees a parsed object rather than the
  bytes Slack signed, and every signature then fails with a message that says
  nothing about body parsing.
- **A harness that creates rows must delete them, including the ones it expects
  to be refused.** Two leftovers came out of writing these: `reset()` called at
  the *end* of a run re-created the pair of test agents it was meant to remove
  (it deletes and creates — the final call has to be the delete-only half), and
  a cleanup list naming only the keys expected to succeed left a stale PENDING
  hire request behind, which counts against the next run's proposal limit.
- **The mailbox reader is verified against a real IMAP server, not a mock.**
  `tmp/mailboxLive.ts` drives the real `ImapFlow` client against GreenMail
  (`docker run -d --name dakyworld-greenmail -p 3025:3025 -p 3143:3143 -e
  GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0
  -Dgreenmail.users=dan:pass@mailroomcheck.test" greenmail/standalone:2.1.0`)
  — connect, wrong password, the UID cursor, a renumbered `UIDVALIDITY`, the
  Sent folder found **by name with no special-use flag**, and an IDLE push
  arriving with nothing polling. Two things it taught: GreenMail's login is the
  local part while the address is the whole thing (which is why `ImapConfig`
  keeps `user` and `mailbox` apart), and **it keeps its folders between runs**,
  so a harness that appends a fixed `Message-ID` reads the *previous* run's copy
  and calls the new one a duplicate. Fresh ids per run, not a looser assertion.
  `checks/mailroom.ts` is the committed half and needs only Postgres.
- **`res.json` throws outright on a `BigInt`** — "Do not know how to serialize a
  BigInt" — so `MailMessage.uid` and `uidValidity` are excluded by an explicit
  `select` in `routes/inbox.ts` (`MESSAGE_FIELDS`). A route that returned a whole
  row would 500 on a message it had stored perfectly.
- **A bounce is very often *from* your own domain.** `mailer-daemon@dakyworld.com`
  is us by every test the loop guard applies, so a delivery report was filed as
  something we sent and suppressed nothing. Direction is `isOurs(from) &&
  !parsed.bounce` for that one reason.
- **Verifying an API response through `curl | python` on Windows mangles UTF-8**
  — Python decodes stdin as cp1252/gbk, so `·` comes back as a CJK ideograph and
  a correct render looks broken. Write the body to a file and read it with
  `encoding="utf-8"`, and set `PYTHONIOENCODING=utf-8` before printing any.

## Committing

Push and deploy without asking — the owner has given standing approval for
finished work. Railway auto-deploys `server/` and GitHub Pages auto-publishes
the root on every push to `main`.
