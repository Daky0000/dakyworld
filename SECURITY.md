# Security and search

What protects this system, where each control lives, and — at the bottom — the
four things that still need somebody with a login somewhere to finish. Written
for whoever picks this up next, including the owner.

Two products live in this repo (see [CLAUDE.md](CLAUDE.md)), and they have
different threat models. **Dakyworld OS** (`server/`) holds every lead, client,
invoice and mailbox credential the business has, behind a login. The **website**
(repo root) is thirteen static pages with nothing to steal, whose job is to be
found.

---

## Running the checks

```bash
npm run security      # credentials in the repo, then a dependency audit
npm run scan:secrets            # the working tree
npm run scan:secrets:history    # every commit ever made
npm run audit                   # shipped dependencies, both packages

npm run site          # regenerate the SEO metadata and breadcrumbs, check links
npm run seo:check     # CI form: fail if the metadata is out of date
npm run links         # broken and non-canonical internal links
```

All of it runs in CI on every push and pull request, plus Monday mornings for
the advisories that land against code nobody touched
([.github/workflows/security.yml](.github/workflows/security.yml)).

---

## Dakyworld OS

### Getting in

| | Where |
|---|---|
| Passwords hashed with scrypt (N=16384), params stored alongside | [`src/lib/password.ts`](server/src/lib/password.ts) |
| One password policy for every path that sets one | [`src/lib/passwordPolicy.ts`](server/src/lib/passwordPolicy.ts) |
| TOTP second factor, recovery codes, replay prevention | [`src/lib/totp.ts`](server/src/lib/totp.ts), [`src/routes/auth.ts`](server/src/routes/auth.ts) |
| Sessions as a random token, only its SHA-256 in the database | [`src/lib/session.ts`](server/src/lib/session.ts) |
| Login rate limits, per address and per account | [`src/middleware/security.ts`](server/src/middleware/security.ts) |

**The password policy follows NIST SP 800-63B rather than the older
"one uppercase, one digit, one symbol" habit.** Twelve characters minimum, a
blocklist, and a refusal of anything built out of the account's own name or
email. Composition rules mostly produce `Password1!`; length and a blocklist do
the actual work. There is deliberately no expiry — forced rotation makes people
iterate a counter on the end, and a password change here already drops every
session, which is what rotation was trying to buy.

**Two-factor is TOTP, not an emailed code.** An emailed OTP is only as strong as
the mailbox, and the mailbox this company would use is the one the app itself
sends from — so a compromise of the mail token would hand over the second factor
along with the first. An authenticator app shares nothing with this system.

Turning 2FA on is two steps, and it is the *confirm* step that enables it: a
secret stored as enabled before the app has proved it can read it is how
somebody locks themselves out with a mistyped setup key. The secret is encrypted
at rest with `APP_SECRET`, exactly like every integration token. Recovery codes
are stored as SHA-256 and shown once. A used TOTP step is recorded, so a code
lifted off a phishing page is not still good for the rest of its thirty seconds.

**The way back in, in order:** a recovery code → an Owner clearing the enrolment
(`DELETE /api/users/:id/2fa`) → changing `OWNER_PASSWORD` in Railway and
redeploying, which is what `bootstrapOwner` exists for and is why a weak
`OWNER_PASSWORD` produces a warning in the deploy log rather than a refusal to
boot.

### Who may see what

`requireAuth` closes the door; a **permission** decides what is behind it.
Client-side checks exist only to hide nav items and buttons
([`client/src/components/Layout.tsx`](server/client/src/components/Layout.tsx),
[`Guard.tsx`](server/client/src/components/Guard.tsx)) — nothing depends on them.

**Access is a set of permissions, resolved per request** (Aug 2026). It used to
be a six-value enum and `requireRole("OWNER", …)` on twenty routers, which meant
the permission model existed twice — once on the API and once as a hand-kept
copy in the client's navigation — and could only be changed by a deploy.

- [`lib/permissions.ts`](server/src/lib/permissions.ts) is the catalogue of
  every gateable action. It is **code on purpose**: a permission that no route
  checks is a tick that reads as a restriction and enforces nothing.
- [`middleware/permissionGate.ts`](server/src/middleware/permissionGate.ts)
  gates a whole router by HTTP method, with an override list for the actions
  that are not CRUD. **`view` is demanded on every request**, so a role cannot
  write into a module it cannot read.
- Effective access is `(role + extraPermissions) − deniedPermissions`, and
  **deny wins over both**. The Owner role answers every check without reading
  the list, which is what makes a lockout impossible and every other role safe
  to narrow to nothing.
- **Nobody may grant a permission they do not hold themselves**, and nobody may
  edit their own access. Without the first, `team.access` and `team.roles` are
  each equivalent to the whole catalogue: create a role with everything ticked,
  put yourself on it, done.
- **A new account with no role has no access at all.** The invite route used to
  default to `DEVELOPER` — every lead, client, proposal and invoice in the
  business, chosen by a `.default()` in a Zod schema.
- Changing somebody's access, or a role's contents, **revokes the sessions**
  affected. The permissions are already live (they are read off the row on every
  request); dropping the session is so that a narrowing is not discovered one
  403 at a time.

**An `external` role is a closed door, not a narrow one.** It means "somebody
outside the company", and until Aug 2026 the `CLIENT_VIEWER` enum value carried
no restriction at all: it could be assigned from the Team screen and then read
every lead, client, invoice and email in the business, because nothing between
`requireAuth` and the routers ever looked at it. There is no client portal yet
and no column tying a user to the client they belong to, so there is nothing to
scope a view *down to* — and the honest position with nothing to scope by is a
refusal. `scopeExternal` in
[`src/middleware/auth.ts`](server/src/middleware/auth.ts) allows the account to
sign in and see itself, and nothing else. It sits **on top of** permissions
rather than instead of them: an external role with `clients.view` ticked still
gets nothing. Widen it deliberately, per route, when the portal exists — never
by deleting the check.

**Never write `include: { user: true }`.** A whole `User` row carries the
password hash, the TOTP secret and the recovery-code hashes. `GET
/api/projects/:id` returned exactly that for every assignee, to anybody signed
in. Use `select: PUBLIC_USER` from
[`src/lib/userSelect.ts`](server/src/lib/userSelect.ts), so adding a sensitive
column to the model can never quietly widen an existing response.

### The data

- **Every integration key is encrypted at rest** (AES-256-GCM, keyed from
  `APP_SECRET`) in `AppSetting` rather than in an environment variable, so
  adding or rotating one never needs a redeploy —
  [`src/lib/secrets.ts`](server/src/lib/secrets.ts). Keys are masked in every
  API response and never unmasked. **Rotating `APP_SECRET` makes every stored
  key unreadable.**
- **Row-level security is on for all 54 tables**
  ([migration](server/prisma/migrations/20260819180100_row_level_security/migration.sql)).
  **It said 42 and meant it, and that was the problem**: enrolling a table is a
  line in a migration and nothing enforced that a new one got it, so seven
  tables added after August 19 never did — including `ActionRequest`, which
  holds the exact validated payload of every outward action an agent has
  prepared, and `Message`/`MessageThread`, which hold every WhatsApp and SMS
  conversation with a real person. They were enrolled on 21 August
  ([migration](server/prisma/migrations/20260821090000_execution_spine/migration.sql)).
  **Anything that adds a table adds an `ENABLE ROW LEVEL SECURITY` line for it
  in the same migration.** The count in this sentence is the check: if it does
  not match `model` in `schema.prisma`, something was missed.
  Read the original migration before reasoning about any of it — Postgres skips RLS for a table's
  owner, and the app owns every table, so the app is unaffected and *every other
  role reads zero rows*. That covers what actually happens to a small system: a
  read-only role handed to a BI tool, a connection string out of a dashboard, a
  psql session opened as somebody else. Per-user row scoping is not expressible
  here — Prisma holds one pooled connection as one role — so it lives in the
  application; the migration says what it would take to move it.
- **No database credential ever reaches a browser.** The client bundle receives
  exactly one variable, `VITE_API_BASE=/api`. Every query goes through the API.
  (If this ever moves to a Supabase-style architecture where the browser talks to
  the database directly, *that* is when a publishable anon key and real RLS
  policies become the mechanism — today the equivalent guarantee is that the
  browser has no database access to constrain.)
- **Every query goes through Prisma.** There is no `$queryRaw` anywhere, so
  there is no string-concatenated SQL to inject into.

### What arrives from outside

- **Every route validates with zod** before anything reaches Prisma. The two
  that do not are `dashboard` (read-only, no input) and `webhooks` (raw bytes by
  design, because a signature covers the exact bytes sent).
- **No mass assignment.** Nothing spreads a request body into a Prisma
  `create`/`update`; every field is named.
- **Uploads are checked as bytes, not as claims** —
  [`src/lib/fileType.ts`](server/src/lib/fileType.ts). A filename ending in
  `.xlsx` and a `data:image/png` prefix are both strings the caller chose. The
  bytes are sniffed against the declared type, an `.xlsx` is checked for a
  declared expansion a spreadsheet would never have, and an SVG is refused if it
  carries a script, an event handler or an external reference.

  **The spreadsheet half of that was written and wired to nothing until Sep
  2026**, which is the reason
  [`checks/uploadBytes.ts`](server/checks/uploadBytes.ts) exists and drives the
  import route over real HTTP rather than calling the validator directly. The
  rule above was true of the logo upload and false of the import: the route
  checked `isSpreadsheetName(fileName)` and handed the bytes to a zip reader, so
  a 20 MB archive declaring gigabytes of expansion was opened — and opened again
  on each of the reader's three retries. A guard that nothing calls is the defect
  class this codebase keeps producing, so **assert that a route calls it, not
  that the function works.**

  Two narrower things came out of the same pass. An SVG's markup is now
  character-reference-decoded before the scriptable test runs, and an event
  handler installed indirectly (`<set attributeName="onload">`, `<handler>`) is
  refused — both were evasions of rules already intended, by spelling rather
  than by meaning. And a webp is matched on `RIFF` *and* the offset-8 `WEBP`
  marker; on the marker alone, any file with those four bytes in the ninth
  position sniffed as a webp, and since the image rule is "sniffed must equal
  declared", declaring `image/webp` was a way to store arbitrary bytes as
  company artwork.

  None of the SVG evasions was executable when it was found, and that is worth
  writing down rather than leaving to be rediscovered: an uploaded logo is
  rendered through `<img src="data:…">` in the OS UI and in email, and through
  PDFKit (PNG and JPEG only) on documents. SVG in an `<img>` is in the browser's
  secure static mode — no script runs, no external reference is fetched. **The
  inertness is a property of the render path, not of the file.** An inline
  `<svg>` or an `<object>` on a screen later makes every one of them live, which
  is why they are refused now.
- **The public webhook is the only anonymous write**, and it is public for a good
  reason ([`src/routes/webhooks.ts`](server/src/routes/webhooks.ts)). It is rate
  limited, size capped, recorded before it is acted on, and filtered by
  [`src/services/botCheck.ts`](server/src/services/botCheck.ts) — a honeypot, a
  fill-time check, a link count and a mail-header-injection check. No CAPTCHA:
  that is a third-party key, a script on every page, a cookie the privacy policy
  would have to describe, and a measurable share of real people who give up on
  the form. Flagged posts are recorded and simply do not become leads, because
  the failure mode of a spam filter is the enquiry it eats.
- **The second anonymous route is Slack, and it is the higher-value one** —
  [`src/routes/slack.ts`](server/src/routes/slack.ts). The webhook intake can
  create a lead; a forged Slack interaction could **employ an agent**, so this
  one has no unsigned path at all. Three things must hold on every request and
  all three are checked in `verifySlackRequest()`: the HMAC over
  `v0:${timestamp}:${rawBody}` matches under `timingSafeEqual` (length-checked
  first, because `timingSafeEqual` throws on a mismatch rather than returning
  false); the timestamp is inside five minutes, so a payload captured off the
  wire cannot be replayed tomorrow; and a signing secret exists at all.
  **With no secret configured it refuses everything**, which is deliberately the
  opposite of the outbound Slack rule — failing to send an alert must not break
  the work, failing to verify a click must never approve anything.
- **A valid signature is not authorisation.** It proves the request came from
  the workspace, not that the person who clicked may decide. `slack.approverIds`
  is the second check; blank means anybody in the channel, which is right for a
  one-person company and wrong the day somebody else joins it. **Fill it in
  before adding a second person to the channel.**
- **Nothing a model produces reaches the `Agent` table.** The Agent Creator's
  `agent.hire` tool writes an `AgentHireRequest`; `applyHire()` in
  [`services/agents/hiring.ts`](server/src/services/agents/hiring.ts) is the only
  code that creates an agent, and it is reachable only from a verified Slack
  interaction, an authenticated `OWNER` API call, or the AUTO policy. This is a
  privilege-escalation boundary rather than a tidiness one: an agent able to
  write that table could grant itself any tool in the catalogue by hiring a copy
  of itself with a wider toolkit. Every hire, by every road, lands at autonomy 1
  with dry run on.
- **User content is never rendered as markup.** React escapes by default and
  there is no `dangerouslySetInnerHTML` anywhere in the client. The one place
  model-written HTML *is* served — `/demos/:slug` — is sanitised and served under
  its own far stricter CSP.

### In transit

`app.set("trust proxy", 1)`, then `forceHttps`, then `securityHeaders`
([`src/index.ts`](server/src/index.ts),
[`src/middleware/security.ts`](server/src/middleware/security.ts)):

- HSTS (2 years, `includeSubDomains`, `preload`) and a 308 redirect for the
  first visit HSTS cannot cover. A write over plain HTTP is refused rather than
  redirected — the body has already crossed the network in clear, and a redirect
  would only send it a second time.
- A real CSP: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'self'`, `form-action 'self'`. Affordable without a nonce because
  the client is a Vite build with no inline script anywhere.
- `nosniff`, `DENY`, `strict-origin-when-cross-origin`, a `Permissions-Policy`,
  COOP/CORP, `X-Robots-Tag: noindex` on the whole app, and `X-Powered-By`
  removed.
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, and the `__Host-` prefix
  in production — which the browser enforces, so nothing on a sibling subdomain
  can set or overwrite it. `Lax` rather than `Strict` deliberately: the Google
  Drive consent screen returns the user by top-level navigation, and a strict
  cookie is not sent on that. Cross-site *writes* are still blocked, which is the
  CSRF case that matters.
- CORS issues no cross-origin grant at all in production, because the client is
  served from the same origin and needs none.

**`trust proxy` is not cosmetic.** The login limiter used to read
`X-Forwarded-For[0]` by hand, which is a header the caller writes — so a script
sending a fresh value per request got a fresh allowance per request. With a hop
*count*, Express takes the entry the proxy itself wrote, which the caller cannot
reach past. Trusting the whole chain (`true`) would put the bug straight back.

**A 500 says nothing in production.** It used to return `err.message`, which is
a Prisma error naming the table and constraint, or a fetch error naming an
internal host. The body is now a fixed sentence plus a reference that ties it to
the stdout line Railway keeps.

---


### The phone-channel webhooks (added Aug 2026)

`/api/messaging/*` is public and mounted above the JSON parser, joining Stripe,
Paystack/Hubtel payments, the generic intake and Slack. Verification matters
more here than on any of them, because of what an unverified inbound could do:

- **Open a 24-hour free-form window.** `MessageThread.lastInboundAt` is the only
  thing deciding whether WhatsApp will carry a written message to a number. A
  forged inbound would let anybody who found the URL make this app willing to
  send free text to a number of their choosing.
- **Opt a live prospect out.** An inbound `STOP` suppresses the number across
  both channels, cancels everything queued for it and stops any email sequence
  the lead is in. Forging one is a denial-of-service against a real pipeline
  that would look like the prospect having asked.

What protects each:

- **WhatsApp** — `X-Hub-Signature-256`, HMAC-SHA256 over the raw body keyed on
  the Meta **app secret**, compared with `timingSafeEqual` after a length check
  (it throws on a mismatch rather than returning false, and a truncated header
  is the shape of a probe). **With no app secret configured, inbound deliveries
  are stored and not acted on** — recorded as a `WebhookEvent` with the reason,
  so a run of them is visible rather than silent.
- **The GET handshake** echoes Meta's challenge only when the verify token
  matches. The token is minted by the app, not typed by a person.
- **SMS through Hubtel** — Hubtel signs nothing whatsoever. The only control
  available is a secret inside the callback URL (`SMS_INBOUND_TOKEN`, minted by
  the app, compared in constant time). **Blank means the SMS callbacks are
  refused entirely**, which is the correct default. This is a genuinely weaker
  control than the other four routes have, and it is weaker because the provider
  offers nothing better — worth knowing before treating an inbound SMS as
  evidence of anything.

Both are answered `200` before the work is done, because both providers retry
what they do not hear from quickly, and a retried inbound would file a reply
twice. Body size is capped at 128kB.

`WHATSAPP_TOKEN` and `WHATSAPP_APP_SECRET` are stored encrypted in `AppSetting`
like every other credential and are masked in the API response.
`WHATSAPP_VERIFY_TOKEN` and `SMS_INBOUND_TOKEN` are returned **in the clear**,
deliberately: they grant nothing on their own and have to be typed into somebody
else's dashboard, which a masked value cannot be.

### Reading the mailbox

The mail room (`src/lib/imap.ts`, `src/services/mailbox/`) is the first path in
this app that ingests content written by strangers *and* stores it. Five things
about it are decisions rather than accidents:

- **The credentials are a separate grant from sending.** `imap.password` is
  stored encrypted in `AppSetting` like every other credential, verified against
  the real server before it is stored, and masked in the API response. Reading
  can be paused (`imap.enabled`) without throwing the password away.
- **Nothing renders the HTML.** `bodyHtml` is stored for the record and the
  Inbox screen shows `bodyText` in a `<pre>` — a stranger's markup is never put
  into the DOM, which is the whole of the XSS story here. Anything that renders
  it later must sanitise it the way `sanitiseDemoHtml` does.
- **Attachments are recorded, not kept.** Names, types and sizes only; the bytes
  stay in the mailbox. Storing a stranger's files is a liability nobody asked
  for, and it is also the cheapest way to fill a disk.
- **A message read is never a message answered.** Routing raises an `AgentTask`
  and the brief says to draft and stop; every send still goes through the same
  autonomy and dry-run gate as any other outward tool call. There is no path
  from "mail arrived" to "mail left" that does not cross that gate.
- **Content is data, never instruction.** A message body is put in front of a
  model as the thing being classified and as quoted text on a task brief.
  Nothing in it is executed, and the classifier's output is constrained to a
  closed list of sixteen intents that map to a routing table in code — so the
  worst a crafted email can do is get itself labelled wrongly and sent to a
  person, which is what the confidence floor already does with anything unclear.
  **Do not add a path that lets a message body choose an agent, a tool or a
  recipient.**

The Inbox routes are behind the `inbox.view` permission, which the three roles
that ship with outreach access carry — on the grounds that what a stranger wrote
to the company is at least as sensitive as what the company sent.

### Telling people where we got their details (added 5 Sep 2026)

Everything the outreach pipeline touches is data we went and found — a
business scraped off Google Maps, an address read off a homepage, a company
in a directory. **That is Article 14 GDPR, not Article 13**, and it asks for
more rather than less, because the person had no idea it was happening.

One item on its list cannot live in a privacy policy: **Art 14(2)(f), the
source**. Everything else — who we are, why, the basis, the retention, the
rights — is the same for everybody and may be linked to, which Art 14(3)(a)
permits. The source differs per person, so it has to travel with the message.
And Art 14(3)(b) puts the deadline at the first communication, which is why
it is appended by code rather than asked of a model: a rule that must hold on
every message cannot depend on anybody remembering it. Same argument, and the
same place in the file, as the reply-based opt-out.

`services/dataSourceNotice.ts` is the one implementation, shared by email and
the phone channels, because written twice it would be one edit away from two
different disclosures.

- **Email** carries the full notice in the footer, in both the HTML and the
  plain-text part — a notice given in one half has not been given to somebody
  reading the other. It is furniture, not the letter: a cold email whose body
  opens on data protection is a cold email nobody answers.
- **WhatsApp and SMS** carry a short form, and **only on the first message**.
  Art 14(3)(b) asks for the first communication, and here that distinction is
  worth making: the notice is about a hundred characters, and on a
  160-character SMS segment repeating it buys a second segment on every
  message of a sequence. The email footer repeats it because a footer is free.
- **A WhatsApp template carries none of it, and that is a real gap rather than
  a decision.** Meta approved an exact string and appending to it would send
  something it did not approve — the same rule that already keeps the opt-out
  out of a template body. Every cold WhatsApp to somebody who has never
  written to us is a template, so the notice has to go **inside** the wording
  submitted for approval. `whatsappTemplates.ts` puts an opt-out in every
  marketing template it proposes and should put this there too; until it does,
  the WhatsApp template path is the one channel not covered.
- **It never names a source we do not have.** `OTHER`, `COLD_EMAIL` and
  `OUTREACH` describe our own pipeline rather than a place anything was found,
  so they fall through to an honest general phrase. The recipient is the one
  person alive who can check where we found them, and being told the wrong
  thing about their own data is worse than being told a vague true thing.

**The email template no longer fetches its typefaces from Google either.** A
`<link>` or `@import` there is honoured by some mail clients, which tells
Google the recipient's IP address and that they opened a message they never
asked for — the same transfer taken off the website the day before, and one no
footer can consent away. Every rule in the shell already named a full fallback
stack, so the cost was nil.

`checks/sourceNotice.ts` (40) holds all of it, database only. Half of it is
negatives: a client's invoice covering note must carry no notice, a lead with
no recorded source must never be told one, a follow-up SMS must not repeat it,
and the shell must request no webfont.

### Deleting what the policy says will be deleted (added 5 Sep 2026)

Art 5(1)(e) GDPR and s.24 of Act 843 both say personal data may be kept no
longer than necessary. Neither is satisfied by intending to.

Publishing a period per category on 4 Sep made the obligation concrete and
created a sharper problem beside it: **a published retention period that
nothing enforces is a false statement in a privacy policy**, which is worse
than the vague "as long as necessary" it replaced. Vague and true beats
specific and untrue.

`services/retention.ts` sweeps **one** of the five published periods and the
file says why for each of the other four: billing is a legal obligation to
*keep*, client systems data lives in the client's own systems and its clock
starts at an offboarding a scheduler cannot see, analytics retention is set in
GA4's admin, and the 24-month enquiry period has nothing to sweep because the
contact form is still a stub. That leaves the category this pipeline creates
by the thousand and which has the weakest claim to be kept: business contact
details we found ourselves, twelve months, on a business that never became
anything.

**It is off until somebody turns it on** — `privacy.retentionEnforced`,
default false — and the housekeeping tick reports the number it would remove.
Deleting rows from the Owner's lead database on a schedule they did not ask
for is their decision, and the first run is where a wrong guard costs most. On
the database as it stands the answer is **0**, because nothing in it is a year
old yet; switching it on today deletes nothing and starts mattering next year.

Not to be confused with `capture.retentionDays`, which prunes `ScraperRun`
history and whose own comment correctly says captured leads are never touched.
Until now there was no other half: the bookkeeping about a scrape expired
after ninety days and the businesses it found were kept for ever.

`checks/retention.ts` (23) is almost entirely the guards, because the failure
here is not a missed sweep — it is deleting somebody's pipeline. A referral, a
website enquiry, a lead touched last week, one that was ever written to, one
with a logged call, one attached to a client: each must survive, and each is
asserted through a **real** delete rather than only through the query that
feeds it, since a widened `where` would pass every read-only assertion and
still empty the table.

### Running an actor on an agent's say-so (added Sep 2026)

`capture.find` and `capture.read` let an agent start an Apify run without a
person having configured a lead source first — see the module note in
CLAUDE.md. It is the second path that ingests content written by strangers, and
the first where a *model* chooses what to fetch. Six things are decisions:

- **The token never leaves the server and never reaches the model.** It lives
  encrypted in `AppSetting`, is read inside `lib/apify.ts` per call, and appears
  in no tool output and no error message. `checks/actorTools.ts` asserts both,
  including on the failure paths — an error is the likelier of the two places
  for a credential to escape.
- **An agent cannot name an actor.** It names a *capability* — Google Maps, a
  website, LinkedIn, Facebook, Instagram — and `captureActors.ts` decides which
  actor that is. There is no input anywhere on this path that reaches an
  arbitrary actor id, which is the whole of the "unauthorised actor" story: an
  agent that could pass one could run anything published on Apify, at any price,
  against any target.
- **The values are validated against the capability before anything is
  charged.** `checkForTask` normalises and refuses — a `/in/` LinkedIn URL, an
  Instagram post, a Facebook personal profile — and a refused value never
  reaches a run. Every generated number is clamped rather than trusted.
- **Four ceilings, and one of them is new.** Targets per call, results per call
  and the wait were the capability's; the monthly Apify budget, the per-run
  charge cap and the concurrency limit were already `assertCanRun`'s. What did
  not exist is a limit on *how many runs one task may start* — neither spend
  ceiling stops a loop — and `capture.maxRunsPerTask` is counted off `ToolCall`
  rows so it survives a restart.
- **Scraped content is data, never instruction.** Every business name, bio and
  description an actor returns is written by whoever owns that page, and it goes
  into a model's context. `lib/untrusted.ts` states the boundary — a fence
  around text going into a prompt, and a standing paragraph in the prompt of any
  agent holding a tool marked `external` — and the tools that carry outside text
  are marked as such in the catalogue rather than guessed at. There is no
  keyword filter, deliberately: the phrasings are unbounded, and a filter strict
  enough to catch them also deletes what a prospect wrote about their own
  business. **Do not add a path that lets a scraped string choose a tool, a
  recipient or an actor.**
- **Nothing on this path is outward-facing, and it still needs approval.** The
  tools are `charge` scope, so at the commissioned autonomy level an agent
  prepares a capture and a person approves it. A capability can also be switched
  off entirely under Settings → Lead capture, which stops the agents and leaves
  Quick capture — driven by a person — working.

**SSRF:** the fetching is done by Apify's infrastructure, not by this server, so
a target URL an agent supplies is not a request from inside this network. The
server's *own* fetches — `companyAudit.fetchSite` and every redirect hop — go
through `routability()`, which resolves the host and refuses anything that is
not a public address. That guard is the one to keep: a redirect is an address
somebody else chose, and a loop written to follow them is the easiest place in
this codebase to lose it.

## The website

Everything in each `<head>` between the `BEGIN SEO` / `END SEO` markers is
generated by [`scripts/build-seo.mjs`](scripts/build-seo.mjs), and the visible
breadcrumbs by [`scripts/build-breadcrumbs.mjs`](scripts/build-breadcrumbs.mjs),
from one table each. **Do not hand-edit inside the markers** — CI fails on it,
and thirteen hand-maintained copies of anything is how this drifted in the first
place: three pages had no canonical, one pointed at a URL nothing linked to, and
not one page carried a single Open Graph tag, so every link shared to WhatsApp,
LinkedIn or Slack rendered as a grey box.

What each page now carries: a canonical, a robots directive, keywords, geo tags,
a full Open Graph and Twitter card set pointing at
[`assets/brand/og-share.png`](assets/brand/og-share.png) (1200×630, on-brand),
and JSON-LD. The homepage carries `Organization` + `WebSite` +
`ProfessionalService`; every other page carries a type that fits it plus a
`BreadcrumbList` that matches the breadcrumb actually on the page.

`robots.txt` and `sitemap.xml` are generated by the same script.
[`404.html`](404.html) is the one page that says `noindex`, which is why it is
not in that table.

### Headers on a static site

Every page carries a Content-Security-Policy as a `<meta>` tag, because GitHub
Pages serves files and cannot set a response header. **That is not the same
thing, and the difference matters in two places:**

- **`frame-ancestors` and `X-Frame-Options` are ignored in a meta tag.** There is
  no clickjacking protection on dakyworld.com and there cannot be until the site
  sits behind something that sets headers — Cloudflare in front of Pages is the
  cheap version; serving it from the Railway service that already sets them
  properly is the thorough one. Nothing on the site takes input yet, so the
  exposure today is somebody framing the pages to misrepresent them, not to
  harvest anything.
- **HSTS cannot be set either.** GitHub Pages does redirect http→https for a
  custom domain with "Enforce HTTPS" on, which is the important half; check that
  setting is on.

What the meta CSP does buy is real: an injected script from an origin other than
the three named cannot run, a form cannot be repointed at somebody else's
server, `<base>` cannot be rewritten to redirect every relative link, and no
plugin content can be embedded at all.

### The two CDN scripts — the largest remaining exposure on the website

Every page loads `https://cdn.tailwindcss.com` and
`https://unpkg.com/lucide@latest`. Both run with full privileges on
dakyworld.com, and **a CSP naming a host does not protect against that host**.
`lucide@latest` is worse than Tailwind: the version is unpinned, so the file
served can change at any time without anything in this repo changing, and an
unpinned URL cannot carry an SRI hash either.

This was left alone rather than fixed quietly, because both fixes are real
changes to a live site and the choice belongs to whoever owns it:

- **lucide** — pin a version and vendor it into `assets/vendor/`, or inline the
  handful of icons actually used as SVG and drop the dependency. Small, contained,
  removes an unpinned remote script entirely.
- **Tailwind** — `cdn.tailwindcss.com` is the Play CDN, which Tailwind's own docs
  say is not for production: it ships a compiler to every visitor, is the reason
  the CSP needs `'unsafe-eval'`, and costs a render-blocking download on every
  page. The fix is a build step producing one small CSS file. That is a project,
  not a patch — roughly 116 places on the site use a Tailwind class, and the rest
  is already served by `assets/site.css`.

Since 4 Sep 2026 there is a second reason to do both, and it is not a security
one. Every visitor's IP address goes to Cloudflare (unpkg) and to Tailwind's
CDN on every page load, before anything has been consented to. That is the
same transfer the Google Fonts link was removed for, and the same answer
applies: it cannot be fixed with a banner, because it happens whether or not
anybody agrees to anything. It is a smaller exposure than the fonts one was —
neither host is an advertising company building a profile — but the honest
position is that the site is not fully free of unconsented third-party
requests until both are vendored.

### Cookies, consent and the fonts (added 4 Sep 2026)

**Nothing is stored on a visitor's device, and no request reaches a third
party, until they have said yes.** That is one sentence and it is the whole
control; everything below is how it is held up.

[`assets/consent.js`](assets/consent.js) is the gate — no third-party consent
platform, because a consent platform is a script from somebody else's server
that reads every visitor before they have agreed to anything, which is a
strange thing to install in order to comply with a law about reading visitors.
This site sets one category of optional storage, so the honest implementation
is its own file.

- **Prior.** Analytics is not loaded and then suppressed; it is not loaded.
  [`assets/analytics.js`](assets/analytics.js) asks
  `dakyworldConsent.onAllowed("analytics", …)` and does nothing if the consent
  layer is not there — a broken consent layer fails to measuring nobody, never
  to measuring everybody.
- **Unambiguous.** No box is pre-ticked, closing the banner decides nothing,
  and Reject is the same size as Accept and first in the tab order.
- **Withdrawable.** A *Cookie settings* control sits in the footer of every
  page. Turning analytics off deletes the `_ga` cookies immediately and
  reloads, **and** every refused category is swept again on every page load —
  gtag is still running at the moment the switch is thrown and will re-set a
  cookie in the instant between the delete and the reload, which was observed
  leaving one behind. The guarantee cannot rest on winning a race with
  somebody else's script.
- **Recorded.** `dakyworld.consent.v1` in local storage holds the choice, the
  date and a version. Bumping `CONSENT_VERSION` re-asks everybody, which is
  what keeps consent *specific* when a vendor or a purpose is added.

It still truncates the IP address, still honours Do Not Track and Global
Privacy Control (as a refusal, and without recording one — an explicit opt-in
from the panel still wins), still skips localhost, and still does nothing at
all until a Measurement ID is filled in at the top of the file. Google Consent
Mode goes out with every advertising purpose denied.

**The typefaces are served from this origin** —
[`assets/fonts.css`](assets/fonts.css) and `assets/fonts/`. A `<link>` to
fonts.googleapis.com is not a styling decision, it is a transfer: the browser
sends the visitor's IP address, user agent and referring page to a US company
before the page paints, with no consent asked and no way to refuse. A German
court awarded damages on exactly that point (LG München I, 20 Jan 2022,
3 O 17493/20), on the reasoning that the transfer was avoidable. No cookie
banner can fix it either, because it happens whether or not anyone consents.
`style-src` and `font-src` no longer name either Google host, and **that
absence is load-bearing** — leaving them would let the request quietly return.

`npm run consent:check` is the proof. It drives real Chrome against a real
copy of the site with a measurement ID filled in, and asserts on **what leaves
the browser**: no request to Google before a decision, none after a refusal,
the cookies actually gone after a withdrawal, and the fonts local on every
page. Two environment details in it are not incidental and are commented at
length in the file — it serves over HTTPS on a made-up hostname, because
`upgrade-insecure-requests` exempts loopback (so an http test on 127.0.0.1
passes while a realistic one loads nothing), and because analytics.js refuses
to run on localhost by design (so a test there cannot tell a working gate from
a preview guard). Both false results were seen while it was being written.

---

## Deploy state

The **website is live** — GitHub Pages publishes the repo root on every push and
did so for all of this.

The **OS is not**. As of 19 Aug 2026 the Railway subscription had ended, so
`os.dakyworld.com` is still serving the build from that morning and nothing in
this document's server half is in production yet. The code is on `main` and
needs no special handling when Railway is back: `npm start` already runs
`prisma migrate deploy`, so the 2FA columns and the row-level-security migration
apply on their own, and both are additive — no existing row changes and nobody
is locked out.

Confirm a deploy actually landed by looking at a header rather than at the
dashboard:

```bash
curl -sI https://os.dakyworld.com/api/health | grep -i content-security
# nothing back  -> still the old build
# a CSP line    -> the new one is live
```

## Two live configuration problems on the Railway service

Both found on 19 Aug 2026 by reading the boot log of the deploy that carried
this work. Neither is fixable from the repository — they are service variables.

### 1. `OWNER_PASSWORD` is six characters

That is the master credential for a publicly reachable admin panel holding every
lead, client, invoice and mailbox credential the business has, and it is the
account `bootstrapOwner` recreates on every deploy. Six characters does not
survive a determined guess; the login limiter slows that down and does not stop
it.

Change it to something the policy accepts (twelve characters minimum, and not
built out of the name or the address), then redeploy — the new value becomes the
Owner's password on the next boot:

```bash
railway variables --service dakyworld --set 'OWNER_PASSWORD=<a long passphrase>'
railway redeploy --service dakyworld -y
```

The app now warns about this on **every** boot rather than only on the deploy
that changed it, which is why it surfaced at all — see the note in
`bootstrapOwner`.

### 2. `DEV_NO_AUTH=true` is set on the live service

It is inert, and it should still be deleted.

`DEV_NO_AUTH` runs the API as one implicit Owner with no login. It is refused on
a deployed service, but until this pass the refusal rested on `NODE_ENV` alone —
and **nothing in this repository sets `NODE_ENV`**. On Railway it is injected by
the Nixpacks builder. So the only thing between the public internet and an
unauthenticated CRM was a variable this codebase neither sets nor controls, and
the failure mode of losing it was silent and total: no error, no crash, every
record readable without signing in.

`middleware/auth.ts` now requires two independent signals to agree that this is
not a deployment, and a missing `NODE_ENV` fails closed. Verified across all six
combinations, including the one that matters — `DEV_NO_AUTH=true`, no
`NODE_ENV`, Railway variables present — which used to evaluate to "no login
required" and now does not.

Delete it anyway. A variable that is set and ignored is one somebody believes is
doing something:

```bash
railway variables --service dakyworld --remove DEV_NO_AUTH
```

Setting `NODE_ENV=production` explicitly on the service is also worth doing, so
nothing depends on the builder injecting it.

## Still to do — these need an account, not a commit

1. **Paste the GA4 Measurement ID** into the top of
   [`assets/analytics.js`](assets/analytics.js). One line, then push. Until then
   there are no analytics at all — everything else is wired.

2. **Verify the site with Google Search Console and Bing Webmaster Tools.** Put
   the two `content` values into `VERIFICATION` at the top of
   [`scripts/build-seo.mjs`](scripts/build-seo.mjs) and run `npm run seo`. Then
   submit `https://dakyworld.com/sitemap.xml` in both. Verification is what
   unlocks the part that matters — which queries actually reach the site, and
   being told about a crawl error rather than finding it in the traffic. (Bing
   can import the whole property from Search Console, which is faster.)

3. **Fill in `sameAs` and the local details** in
   [`scripts/build-seo.mjs`](scripts/build-seo.mjs). Two gaps, both deliberate:

   - `COMPANY.sameAs` is empty because a guessed profile URL either 404s or
     points at somebody else's account. It is the single strongest signal tying
     this site to a verified identity. Real LinkedIn/Facebook/X URLs, then
     `npm run seo`.
   - `ProfessionalService` carries no street address, no coordinates and no
     opening hours, because inventing any of them would be a false statement
     about a real business. **A Google Business Profile is what actually gets a
     company into the local pack** — the schema supports the listing, it does not
     replace it. Create the profile, then bring the address it verifies back into
     this file.

4. **Turn on two-factor for the Owner account.** Settings → Security. Everything
   is built and tested; nobody is enrolled. This is the control that matters most
   on a system holding every client relationship the business has, and it is
   currently off.

## One control deliberately relaxed, in two places

**The audit will go past a certificate warning, on purpose.**
[`fetchSite`](server/src/services/companyAudit.ts) retries a TLS failure once
with `rejectUnauthorized: false`, and since 2 Sep 2026 the **screenshot actor**
([`apify/dakyworld-screenshot`](apify/dakyworld-screenshot/src/screenshot.ts))
retries the same failure once with `ignoreHTTPSErrors` on that one browser
context — both the code equivalent of clicking *Advanced → Continue to site*.

It exists because the alternative was worse: a prospect whose certificate had
expired got a review whose entire content was "we could not open it", about a
site every visitor can reach by clicking the same button, and the expired
certificate — the most urgent thing wrong with the business, and a free same-day
fix — never appeared in the report at all. The picture half followed a month
later, for a narrower reason: no external screenshot actor declared such an
input, so the audit could read the page and show nothing of it.

Why this is acceptable here and would not be elsewhere:

- **It is one call and one browser context, not a mode.** `node:https` with the
  flag on that request only, and `ignoreHTTPSErrors` on the one Playwright
  context the retry opens — never at browser launch, and never
  `NODE_TLS_REJECT_UNAUTHORIZED`, which would disable verification for every
  outbound call the process makes, including the ones carrying Anthropic,
  Stripe and Apify keys. That variable must never be set on either service.
- **Nothing of ours is sent.** A GET for a public homepage: no credential, no
  cookie, no token, no body. The exposure from an unverified connection is that
  what comes *back* may not be genuine; there is nothing going out to intercept.
- **What comes back is treated as untrusted and labelled as such.** The
  retrieved HTML is parsed for evidence and shown in a report, never executed,
  and every section of that report carries a line saying the connection was not
  verified.
- **It only fires on a TLS failure.** A good certificate is verified normally, a
  domain that does not resolve is still reported as not resolving, and the
  bypass never runs on either. `server/tmp/certBypass.ts` asserts both of those
  negatives against live hosts on badssl.com alongside the positive cases; the
  actor's own `npm test` does the same against a self-signed server it generates
  and throws away, including the negative that an ordinary page is **not**
  marked insecure.
- **A picture taken that way says so.** The dataset row carries `insecure`, it
  reaches the report as `Screenshot.insecure`, and the note beside the picture
  says the connection was not verified — the same labelling the retrieved HTML
  already gets. Before this, the picture simply did not exist: no external
  screenshot actor declared such an input, so the audit read the page and could
  show nothing of it, which is what the relaxation was introduced to stop.
- **The certificate becomes the loudest finding in the document**
  (`cert-untrusted`, CRITICAL, with the issuer and the expiry date read off the
  socket), and the `Certificate warning` tag makes it a filterable list.

The redirect loop that goes with it re-checks `routability()` on **every hop**,
not only the first. A redirect is an address somebody else chose, and a loop
written to follow them is the easiest place in a codebase to lose an SSRF guard.

---

## Two things known and accepted

- **`exceljs` depends on a vulnerable `uuid`** (GHSA-w5hq-g745-h8pq, moderate).
  Not reachable: the advisory is about a missing bounds check *when a buffer is
  passed*, and exceljs calls `uuidv4()` with no arguments
  (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`). 4.4.0 is the latest
  release, so there is no fix to take. `npm audit --audit-level=high` is
  therefore what CI enforces; the full report is printed alongside it.
- **The contact form on dakyworld.com is still not connected to anything.** It
  says so to the visitor. The honeypot and timing fields are in the markup and
  the server side is built and tested, so pointing it at
  `POST /api/webhooks/website-form` is the only remaining step — but until
  somebody does, enquiries arrive by email and phone only.
