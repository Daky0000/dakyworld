# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This repo holds two products

Read this before touching anything at the root — the layout is not obvious.

| Path | Product | Deployed to |
|---|---|---|
| `server/` | Dakyworld OS, the internal ops app (API + React client) | Railway → **os.dakyworld.com** |
| repo root (`index.html`, `about.html`, … `assets/`) | the public marketing website, static HTML | GitHub Pages → **dakyworld.com** |
| `website-drafts/` | superseded homepage explorations | served but unlinked |
| `apify/dakyworld-screenshot/` | the screenshot actor Dakyworld OS calls | Apify, via `apify push` |

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

# The screenshot actor (from apify/dakyworld-screenshot/)
npm test                 # a local misbehaving website, no Apify account needed
apify push               # build and deploy it to Apify
```

**There is no linter in this repo, and `server/checks/` is the only committed
test suite.** `npm run checks` (from `server/`) runs every file in it against a
real Postgres, with no API key and no network; `npm run checks:types`
typechecks them. Everything else is still `npx tsc --noEmit` in both `server/`
and `server/client/` plus a real build — do not claim a change is "tested" on
the strength of a passing build.

**`npm run checks` does not load `.env`, and every check needs
`DATABASE_URL`.** `checks/run.ts` passes `process.env` through unchanged and
nothing in the check files calls `dotenv` — only `src/index.ts` does — so
running one directly with `npx tsx checks/<name>.ts` fails on
*"Environment variable not found: DATABASE_URL"*, which reads exactly like a
broken database rather than a missing variable. Source it first:
`set -a; . ./.env; set +a`.

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

## Architecture — read the part you are about to touch

The architecture notes are one document split across `docs/claude/`. They are
**not** loaded automatically: **read the file for the area you are changing
before you change it**, and read more than one when a change crosses them. Each
one is dense and every paragraph in it was paid for by a defect.

| Read this before touching | File |
| --- | --- |
| Express routing, mounting order, the tool catalogue, MCP tools | [01-server-and-tools.md](docs/claude/01-server-and-tools.md) |
| `callModel`, jobs vs vendors, NVIDIA/Perplexity/ChatGPT, free ladders, structured output, effort, prompt cache, what a turn costs | [02-model-routing-and-cost.md](docs/claude/02-model-routing-and-cost.md) |
| Lead research, the scan, contact rules, `caseStrength()`, evidence rules | [03-lead-evidence.md](docs/claude/03-lead-evidence.md) |
| Screenshots, the Dakyworld Apify actor, both viewports, Apify ceilings, fetching a site | [04-capture-and-screenshots.md](docs/claude/04-capture-and-screenshots.md) |
| Cold email doctrine, red flags, the writers, prompt surfaces, WhatsApp and SMS | [05-outreach-and-writers.md](docs/claude/05-outreach-and-writers.md) |
| IMAP, the mailbox, demo landing pages, the four-reviewer audit team | [06-mailroom-demos-audits.md](docs/claude/06-mailroom-demos-audits.md) |
| Agent tasks, the loop, workflow tools, hiring, Slack, escalations, memory, prompt structure, state | [07-agent-runtime.md](docs/claude/07-agent-runtime.md) |
| Rehearsals | [08-rehearsal-room.md](docs/claude/08-rehearsal-room.md) |
| Spend, ceilings, `warn → downgrade → approve → pause`, effort, model tiers | [09-costs-effort-and-tiers.md](docs/claude/09-costs-effort-and-tiers.md) |
| Lead sheets, plans, `repairPlan`, worksheets, tags on import, workbooks | [10-lead-sheets-and-imports.md](docs/claude/10-lead-sheets-and-imports.md) |
| The React client, Prisma, encrypted keys, company details, lead tags, lists, actor choice | [11-client-data-and-actors.md](docs/claude/11-client-data-and-actors.md) |
| `DEV_NO_AUTH`, permissions as data, access roles, SECURITY.md | [12-auth-and-access.md](docs/claude/12-auth-and-access.md) |
| The Website Builder, drafts, publishing, rollback, the editor | [13-website-builder.md](docs/claude/13-website-builder.md) |
| Generated site metadata, the brand design system, the OS UI semantic tier | [14-brand-and-metadata.md](docs/claude/14-brand-and-metadata.md) |

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

- **The CSV parser is hand-rolled, and a quote is only a quote at the start of
  a field.** `parseCsvCapped` opened a quoted field on *any* `"`, so
  `6" pipe,Accra` swallowed its delimiter, then its newline, then every
  remaining row of the file into a single field — because the closing quote it
  was waiting for never came. A 46,000-row sheet imported as **one lead and
  reported success**. Inch marks, sizes and unquoted nicknames are ordinary
  content in a list of trade businesses, so this was reachable from a perfectly
  normal export. The guard is `field.trim() === ""` rather than `field === ""`,
  so `, "Accra, GH"` — a quote after the space some exporters leave — still
  opens a quoted field. Relatedly, `sniffDelimiter` counted `,` `;` and tab
  **inside** quoted fields and split the whole file to keep ten lines: one
  quoted address holding four commas outvoted the semicolons actually
  separating the fields, so a semicolon-delimited export (Excel's default
  across much of Europe) arrived with every row as one column. It strips quoted
  spans and slices to 64 KB before splitting now. `checks/spreadsheet.ts` holds
  both, and half of those assertions are the negatives — a properly quoted
  field must still keep its delimiter, its newline and its doubled `""`.
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
  replaces those default scales. `blue-500` and friends do not exist. **Nor do
  `red-*`, `amber-*` and `emerald-*` any more** — status has its own semantic
  families (below), and Tailwind's stock scales are not to be reached for again.
- **Uploads ride in the JSON body as base64**, so their paths are excluded from
  the global parser in `index.ts` (`UPLOAD_PATHS`) and each mounts its own
  larger one *inside* its router, after the role check. Adding a third upload
  route means touching both places or it fails at 100 kB.
- **The SEO actor's run body can be checked without a token.**
  `tmp/actorWiring.ts` builds it against the actor's live published schema and
  asserts every key sent is one it declares, then reads the actor's own
  documented example output back through the parser. That is the trap: an
  undeclared key is ignored in silence, so a misspelt `crawlPages` is not an
  error — it is a five-page crawl at five times the price. **The screenshot half
  no longer needs it**: that actor is ours, its schema is in this repository, and
  `checks/screenshots.ts` asserts the exact set of keys that goes over the wire.
  `tmp/renderedFindings.ts` covers what the speed section does with the
  measurements, including both suppressions.
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
- **Restoring a row is not restoring the state — `checks/roster.ts` proved it
  the expensive way.** Its reconcile section strips two tools off
  `billing.collector`, deletes `agents.toolkitOffered`, lets the reconcile grant
  them back, and then wrote the *old* toolkit over the row. The ledger was left
  saying those tools had been offered, so no boot ever offered them again: the
  Payment Chaser sat without `email.send` — a collections agent that could not
  write to anybody — caused by the check that exists to prove it can. And the
  section's final assertion, made after that restore, then failed on any
  database where the subject was behind, which is the exact state it simulates.
  Both halves are restored now, the assertion moved to straight after the
  reconcile, and the toolkit put back as **found ∪ seed** so a tool the Owner
  ticked on by hand is never taken away.
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
