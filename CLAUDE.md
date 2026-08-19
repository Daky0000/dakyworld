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
Gemini writes, ChatGPT draws, builds pages and looks at pictures, Perplexity
researches companies, checks facts against live sources and rewrites drafts
into plain English. **A job whose chosen vendor has no key falls through a
chain: the declared fallback first, then every other vendor that can actually
do that job**, so nothing waits on a credential and each key the Owner pastes
moves one job onto its chosen model. `registry.ts` holds the vendors, the
shipped routing, the published rates and `standInsFor()`; `call.ts` holds one
adapter per vendor.

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

**The cold email playbook is the authority, and it is v3** —
[`server/docs/cold-email-playbook.md`](server/docs/cold-email-playbook.md). It
is the owner's doctrine, and the code implements it rather than the other way
round; where the two disagree the playbook is right and the code is the bug.
Four things in it overturn what the drafter used to do, so check before
"restoring" any of them:

- **The sender identifies himself in the first two lines**, before the
  observation. The drafter used to be told the opposite — "not who you are" —
  on the theory that a stranger only cares about themselves. A stranger who
  cannot tell in one line who is writing has already stopped reading.
- **Say what it makes harder, never what it has cost.** "People on a phone may
  find it harder to contact you", not "customers are leaving your website". The
  second states an outcome nobody measured to the one person who can check it.
- **No price in a first email**, and **no meeting as the ask.** The ask offers
  something — the screenshot, the setting, the checklist. Time is the largest
  thing you can request from somebody who has not yet agreed there is a problem.
- **No same-day or free promise on a certificate.** The cause is not visible
  from outside; it may be hosting or a renewal setting. This one is a
  correction: the sentence was added on 19 Aug and the playbook removed it.

`coldEmailScenarios.ts` holds the **eighteen scenarios as data** — signals,
subject, guidance, the one question, and the guard that belongs to that letter
and no other. Eleven are chosen in code from the finding ids the audit produced,
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
drafter, and the `outreach.writer` / `outreach.followup` prompts — plus the
`dakyworld-cold-email` skill for writing outside the app.
`applyColdEmailPlaybook()` is the one-off pass that puts the v3 wording onto
agents that already exist, marked by `agents.coldEmailPlaybookV3` and skipping
any prompt the Owner has rewritten.

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
Sign-in is email + password + an optional TOTP second factor (`lib/totp.ts`,
`routes/auth.ts`); `scopeClientViewer` refuses the internal API to the
`CLIENT_VIEWER` role entirely, because there is no client portal to scope one
down to yet.

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
- **Verifying an API response through `curl | python` on Windows mangles UTF-8**
  — Python decodes stdin as cp1252/gbk, so `·` comes back as a CJK ideograph and
  a correct render looks broken. Write the body to a file and read it with
  `encoding="utf-8"`, and set `PYTHONIOENCODING=utf-8` before printing any.

## Committing

Push and deploy without asking — the owner has given standing approval for
finished work. Railway auto-deploys `server/` and GitHub Pages auto-publishes
the root on every push to `main`.
