# Dakyworld OS

Internal operations platform — leads, proposals, projects, invoices, care
plans, time tracking, and a live revenue dashboard. Built from the Phase 1
MVP scope of the original system spec (`18_Dakyworld_Custom_Operating_System.pdf`).

> **Security:** [SECURITY.md](SECURITY.md) is the runbook — what protects what,
> how to run the checks (`npm run security`), and the four things still waiting
> on somebody with a login rather than a commit.

**Stack:** React + TypeScript + Tailwind (client) · Node + Express + TypeScript
(server) · PostgreSQL via Prisma · built-in email/password auth · Stripe (payments) ·
Cloudinary (file storage, PDF hosting).

## What's built (Phase 1 MVP)

- **Lead & Pipeline** — full CRUD, source/status tracking, lead scoring,
  filtering and grouping, bulk actions, per-lead contact history.
- **Lead capture (Apify)** — configurable scrapers that pull prospects off
  Google Maps and the web on a daily schedule. See below.
- **Spreadsheet import (AI)** — point at an `.xlsx`/`.csv`, or a sheet in a
  connected Google Drive, and Claude reads it: every table it holds becomes
  its own batch with its own columns, however messy the file. See below.
- **Configurable lead columns** — rename, reorder, hide and add columns from
  the table header itself, per list or across the whole pipeline, without a
  schema change. Any row can be edited in place, including the name.
- **Export** — the current view, filters and all, to Excel (one sheet per list,
  every column) or a printable PDF.
- **Settings** — every integration key (Apify, Anthropic, Google, Stripe,
  Cloudinary) pasted in the app and stored encrypted in the database, so
  adding or rotating one never needs a redeploy.
- **Proposal & Negotiation** — create, generate a branded PDF, send, and
  accept (which auto-creates the Client + Project) or reject.
- **Project & Delivery** — milestones, tasks, team assignment, time logging.
- **Invoicing & Payments** — line-item invoices, PDF generation, Stripe
  Checkout payment links, manual mark-paid.
- **Care plans (retainers)** — the recurring half of the business: tiers,
  included hours, and an invoice raised on the plan's own billing day every
  month, with hours over the allowance charged in arrears. See below.
- **Email** — write to a lead or client with a draft the AI wrote from their
  own record, send the invoice or the finished work as an attachment, and let
  follow-up sequences send themselves. See below.
- **The inbox** — the mailbox is read as well as written to: replies are
  matched to the lead or client they belong to, sequences stop the moment
  somebody answers (including when *you* answer from your phone), bounces and
  opt-outs act on themselves, and each message is handed to the agent whose job
  it is. Nothing is ever sent on your behalf. See below.
- **Revenue Dashboard** — live MRR, outstanding invoices, pipeline value,
  leads-by-status — computed on read, no manual reporting.
- **Role model** — Owner / Project Manager / Developer / Designer /
  Operations-Finance / Client Viewer, enforced server-side (`requireRole`).
  Today, only the Owner-role check on team management is actually wired up
  as a gate — extend `requireRole(...)` on other routes as the team grows.

Not yet built (later phases per the original spec): AI-powered churn/upsell
insights, Slack notifications, a client-facing portal.

## Email

The **Email** page (`/emails`, Owner / Finance / PM) is where everything
outbound happens: one-off letters, deliverables, and the follow-up sequences.

**Connect a mailbox first**, in **Settings → Email**, one of two ways.

**Hostinger — one API token.** The mailbox on the domain is Hostinger's, and
Hostinger gives it an MCP server, so this route asks for a token and nothing
else: click **Hostinger · MCP**, paste the token, done. The address it sends
from is read back from Hostinger rather than typed in, because the token is
already scoped to mailboxes. Make the token in hPanel under **Emails → your
domain → Agentic mail → API → Create API token** — it is shown once. Sending
then goes through `mcp.mail.hostinger.com`: the app handshakes, reads the tool
list and fills the send tool's arguments from the schema the server publishes,
so a renamed tool doesn't break it. If the MCP server can't be reached, the
same token sends through Hostinger's Mail API instead and the panel says which
path is live. Two things this path can't do, both stated on the screen: a
reply-to address different from the mailbox, and the `List-Unsubscribe` header
(the opt-out link inside every cold email is unaffected).

**Anything else — SMTP.** Google Workspace, Zoho, a cPanel mailbox: all of
them already speak it, and none need a new account opening or a domain
re-verifying before the first email can go out. On Google Workspace it must be
an **App Password** — Google refuses plain logins from applications.

Either way the credentials are checked against the server before they are
stored, so a wrong paste fails on that screen rather than silently at 8am
inside a sequence.

### How an email looks

Every message goes out on the same letterhead, drawn by
[`services/emailLetterhead.ts`](server/src/services/emailLetterhead.ts) — the
screen counterpart to the one `letterhead.ts` prints on proposals and
invoices. A white sheet on a cream ground: the lock-up top left, the contact
line quiet on the right, a hairline rule with one lime segment, the letter,
the signature, and an ink footer band carrying the on-dark lock-up, the
positioning line, the contact details and the legal line — the website's own
footer at the width of a letter.

**The logo travels with the message.** Both cuts are attached as inline parts
and referenced as `cid:`, not linked from a server. Outlook blocks remote
images by default and the apex domain has been unreliable enough to lose them
for real (see [DOMAINS.md](DOMAINS.md)); an embedded part needs nothing
outside the message. They are palette-reduced to about 3 KB each and flattened
onto their backgrounds, because a client in dark mode inverts the background
behind an image but never the image — a transparent ink wordmark would
disappear. If the files are missing the letterhead falls back to a
typographic wordmark rather than a broken image.

**Fonts are Space Grotesk and DM Sans where a client will have them.** Apple
Mail, iOS Mail and Samsung Mail load the linked webfonts and show the real
faces; Gmail and Outlook strip the link, so every stack falls to a system sans
with the same proportions, and Outlook is given Arial explicitly because the
Word engine renders an unknown family as Times. This is the one medium where
brand type cannot be insisted on.

The body of the letter stays deliberately plain — paragraphs, one accent
colour for links, no images, no tracking pixel. A business email that arrives
looking like a newsletter reads as a campaign, and a campaign is easier to
ignore. **Settings → Email → Send test** is the way to see the whole thing in
a real inbox.

### Drafting

Pick a lead or a client and the composer shows **what we actually know about
them**, in the same words the drafter is given: the city the scraper found,
that they have no website, the 4.6 stars from 212 reviews, the proposal sent
three weeks ago that nobody answered, the invoice eleven days overdue.

Press *Write a draft* and Claude writes the email from exactly those facts,
under Dakyworld's own voice and positioning, for one of fourteen purposes — a
cold approach reads nothing like an invoice reminder. Two rules do most of the
work: it may use only the facts supplied, and it produces a draft rather than
an outbox. A tailored email that invents a branch office is worse than a
generic one, and nothing sends without a person reading it first.

Without an Anthropic key the whole page still works — the thirteen built-in
templates are written out in full, and `{{first_name}}`, `{{company}}`,
`{{city}}` fill from the recipient's record the same way.

### Sending deliverables

*Email* on an invoice or a proposal opens the composer with the PDF already
attached. The PDF is **rendered when the message sends**, not when it is
drafted, so what the client receives is the document as it stands then. Any
other file attaches by link.

### Sequences

A sequence is the follow-up nobody remembers to send by hand, which is where
most of a cold pipeline is lost. Each step waits its own number of days and
sends inside a local window (08:00–18:00, weekdays, by default) so nothing
lands at 3am on a Sunday. A step can use a template, be written inline, or be
drafted per person at send time from that person's own record.

Sequences can enrol **every new lead** that matches a filter — score, city, no
website — so a scrape at 06:30 becomes a first email the next morning without
anyone opening the app. `requireApproval` turns the whole thing into a drafts
queue instead, for when you want to read each one.

**Three things stop a sequence**, all checked at send rather than at
enrolment: the address is suppressed, the lead has moved out of the pipeline
(converted, disqualified, lost), or someone replied. A reply stops every
sequence that person is in, not just the one they answered.

### Not writing to people who asked you not to

Every cold email carries a signed one-click unsubscribe, in the body and in
the `List-Unsubscribe` header that Gmail and Outlook read. The unsubscribe
endpoint is public and takes effect immediately — a link that needs a login is
not an unsubscribe link — and it honours the request even if the signature
doesn't match, because refusing an opt-out over a token mismatch is
indefensible. Suppressed addresses are checked before **every** send, including
from inside a running sequence.

### Attaching a file, and looking before you send

Drop a file onto the composer or pick one — it uploads the moment it is chosen
rather than when Send is pressed, so a 6 MB scan is already on the server while
the letter is still being written and Send stays instant. Ten megabytes is the
ceiling per file: providers reject a message over about 25 MB once base64 has
added its third, and a message carries more than one attachment. Anything
bigger has a better answer, and *Attach a link instead* is still there for it.

An invoice or a proposal attached from its own page is different again: those
are rendered **at send time**, so what a client receives is the document as it
stands when it goes out, not as it stood when the email was drafted three days
earlier.

**Preview** is the second tab of the composer, and it is the server's own
render — the same `renderEmail` a real send runs. The letterhead, the
signature, the opt-out and the filled-in placeholders are the ones that will
actually leave, not an approximation drawn in the browser. It shows the
envelope as an inbox will (from, to, subject, the attachment chips with their
sizes), a desktop/mobile width toggle, and the plain-text half underneath.

The single most useful thing it does is name the placeholders **nothing fills**
for this recipient. A typo renders as the literal braces — deliberately, since
blanking it would send "Hi ," to a client — so an email opening
"Hi {{frist_name}}" is a real failure mode, and reading one line above the
preview is cheaper than reading every line of the letter.

Every message in the outbox has a Preview too, including the sent ones. A sent
message is shown exactly as it went out rather than re-rendered on today's
letterhead: what the recipient received is the record, and re-rendering it
would misrepresent it.

### What it deliberately doesn't do

There is no open tracking and no click tracking — a tracking pixel is how a
business letter starts being filtered as marketing.

It **does** read the mailbox now, which it did not until August 2026. See below.


## The inbox

Everything above this point writes *out*. For most of a year the app could
compose, schedule, sequence and send, and had no idea whether anybody ever
answered — a reply was something you noticed in your own webmail and then
remembered to type in. That one manual step is where a pipeline is actually
lost: a sequence goes on writing to somebody who has already said yes, a dead
address is written to for weeks, and the fastest thing that happens to this
business — a stranger replying to a cold letter — reaches the system last.

**Outreach → Inbox** is the other half of the door. It opens on what is still
owed a reply, not on what is newest.

### Connecting it

**Settings → Email → Reading the inbox.** The form arrives filled in: the IMAP
server is your SMTP server with `smtp` swapped for `imap`, the port is 993, the
username is the same, and the password is usually the same App Password already
stored for sending — leave it blank to reuse it. Press Connect and it is checked
against the real server before anything is saved, exactly as the sending half is.

It is a separate connection on purpose. A mailbox that sends perfectly can be
unreadable — a host with IMAP switched off, an App Password scoped to sending —
and one "email is connected" covering both would hide precisely that.

### What happens when something arrives

A live connection sits on the mailbox, so a reply is read within seconds rather
than on the next minute. Then, in order:

1. **It is filed** — against the lead or client whose address it is, and joined
   to the letter it answers by the threading headers.
2. **What needs no judgement happens immediately.** Every sequence that person
   is in stops. An opt-out suppresses the address everywhere and cancels what is
   queued. A bounce suppresses the address that actually failed. A lead that has
   never been spoken to moves from New to Qualifying. **None of this needs an AI
   key** — it is arithmetic, and it happens whether or not a model is connected.
3. **It is read once**, and labelled: interested, a question, wants to talk,
   about an invoice, a new enquiry, an out-of-office, junk.
4. **It is handed to whoever owns it.** A client's complaint goes to the Support
   Desk; a prospect saying yes goes to the Follow-up Writer; an invoice query
   goes to the Invoicer. Who gets what is a table in the code, not a decision a
   model makes — you can read it, and it is the same every time.

**Nothing here ever sends.** The agent that picks a message up drafts the reply
into the outbox and stops; you send it. That is the same autonomy gate every
other agent works under, and on a new deployment it means an answered cold email
produces a draft waiting for you, never a letter that left while nobody was
looking.

### The Sent folder, which is the half people forget

It reads what you sent as well as what arrived. If you answer a prospect from
your phone at the weekend, the app has never heard of that message — and on
Thursday the sequence writes to them again, under your name, asking whether they
saw your first email. Reading Sent is what stops that. A message the app itself
sent is told apart from one you typed by looking it up in the outbox.

### An out-of-office is not a reply

The single most expensive mistake available here, so it is handled from the
headers rather than by a model: an autoresponder, a receipt, a newsletter and a
delivery report are recognised as machine-sent, they stop no sequence, they are
given to nobody, and they are kept off the "owed a reply" list. They are still
filed, and still on the Everything tab.

### What you can change

Two switches under Settings → Email:

- **Read each message with a model.** Off still files everything, still stops
  sequences and still suppresses bounces.
- **Hand messages to the agent whose job it is.** Off labels the post and leaves
  every message for you, which is a reasonable way to run the first fortnight.

A message the model was not confident about is never handed to an agent — it
waits for you with an honest note saying who it *would* have gone to. So is one
whose intended agent is paused or was never switched on.

### After a deploy

`mail.room` — the Mail Room agent, which places anything the table cannot —
arrives as a **draft**, like every seeded agent. Set it Active on the Agents
screen. The agents that receive post (Support Desk, Follow-up Writer, Invoicer,
Proposal Writer, the CCO) also need `inbox.read` and `inbox.handled` ticked:
a deploy adds new agents but never widens an existing one's toolkit, because
granting a capability silently is not something software should do to you.


## WhatsApp and SMS

Most of the leads a scrape brings in have a phone number and no email address.
Until this module they could not be written to at all, which made capturing
them close to pointless. **Outreach → WhatsApp & SMS** opens on exactly that
list: every lead with a number and no address, best first.

### The one thing worth understanding first

WhatsApp lets a business write freely to somebody only **within 24 hours of
that person's last message to it**. Outside that window it will carry a
template Meta approved in advance, and nothing else.

A lead who has never messaged you has never opened that window. So a first
WhatsApp is always a template, and a template always waits for Meta to review
it — usually minutes, sometimes a day.

**You do not have to wait for any of that.** Every message in the composer can
be sent as a `wa.me` link instead: it opens WhatsApp on your own phone with the
message already typed, and you press send. No Business account, no review, no
per-conversation fee — and it arrives from you rather than from a brand, which
is what a small business here actually replies to. A message sent that way sits
in the outbox as *waiting for you to send it* until you say you did, because
copying a link is not sending a message.

### The screens

- **Who to reach** — leads with a number and no email. Each row says whether
  that number can carry a message at all: a landline says so, an unreadable
  number says so, and somebody who opted out says so.
- **Conversations** — replies as they arrive, with how long is left of the
  window to answer freely in.
- **Outbox** — what went, what is queued, what is waiting for you to send by
  hand, and what failed with the reason in plain words.
- **Templates** — what Meta has approved, and four starters written to the
  playbook that can be submitted with one click.
- **Opted out** — anyone who replied STOP. It applies to both channels at once:
  somebody who stopped a WhatsApp has not asked to keep getting texts.

### What it costs, and what it says

A text is billed per 160 characters, and a single curly apostrophe — the kind a
word processor inserts — re-encodes the whole message and drops that to 70,
tripling the price of a message that looks identical. The composer counts it
live, names the character responsible, and offers to swap it.

Messages are drafted from the same evidence an email is: the research, the site
audit, the homepage screenshot. The same rules apply, with the shape adjusted —
who is writing goes in the first line (there is no signature to append), one
thing noticed, one small ask, no price, and 70 words at the outside.

### Connecting it

Under **Settings → Messaging**. WhatsApp needs an access token and a phone
number ID from the Meta app dashboard; add the App Secret too or replies are
recorded and never acted on. The callback URL on that panel has to be pasted
into Meta's Configuration tab, or a prospect's reply never reaches the app.

SMS goes through Hubtel and shares the credentials under **Settings →
Payments**. What is set under Messaging is the address Hubtel posts replies and
delivery reports back to — Hubtel signs nothing, so that URL carries a secret
and must not be shared.

## System settings

**Settings → System** is the one place the company describes itself.

The name, the address, both phone numbers, the website, the social links, the
registered company number and the logo used to be constants in the code:
correct, single-sourced, and changeable only by a developer with a deploy. They
are now a record, and everything that describes Dakyworld reads it — the email
letterhead and its dark footer band, the plain-text half of every email, the
PDF letterhead on every invoice and proposal, the Word cut of a proposal, the
unsubscribe page, and the brief the AI drafter and the proposal writer are
given before they write a word.

Change the phone number here and the next email, the next invoice and the next
proposal carry the new one. There is no second copy to keep in step, which was
the entire point of holding them in one file before and is the entire point of
holding them in one record now.

**Blank means "use the default".** Every required field shows its shipped value
as placeholder text; leaving it empty falls back to that rather than printing
nothing, because a letterhead with no email address on it is never what anyone
meant. The genuinely optional details — a second phone line, a VAT number, a
social handle — have no default, so blank there means what it looks like and
the line simply isn't printed.

### The logo

Four slots: the lock-up on light, the lock-up on dark, the mark on its own, and
a favicon. Anything uploaded wins over the artwork shipped in `server/assets/`;
remove an upload and it falls back. If neither exists the wordmark is set in
type, which is why an email never arrives with a broken image at the top.

Uploads are held **in the database**, not written to disk. Railway's filesystem
is ephemeral: a file written at runtime survives until the next deploy and then
silently reverts, which is worse than not working because it looks like it
worked.

Keep them under 1 MB — the limit is enforced, and these ride along on every
single message. A logo is embedded in the message rather than linked to, so it
shows in Outlook with images blocked and on a domain that is mid-migration; the
cost of that is that its size is paid on every send.

## Care plans

The **Retainers** page (`/care-plans`, Owner and Operations-Finance) is where
recurring revenue actually comes from — the MRR figure on the dashboard is the
sum of what is configured here.

**In advance, in arrears.** A plan bills on its own day of the month, in its
own timezone, for the month ahead — because that is what a retainer is. Hours
can't work that way: how many were used is only known once the month has
ended. So each invoice carries the coming month's fee *and* the closing
month's overage, and every cycle is settled one cycle late.

**Hours are counted, not typed.** `includedHours` is measured against billable
time logged on the plan's delivery project, so the bar on the page is the same
number the team's timesheets produce. A plan with no project linked, or no
included hours, is unmetered and never bills overage. Overage needs a rate —
without one the extra hours are shown but not charged, and the page says so.

**Billing twice is the failure that matters.** Not billing is visible; billing
twice is a refund and an apology. Three things prevent it: `nextBillingAt` is
advanced before any invoice is written, the period billed is derived from the
calendar rather than from when the job happened to run, and a unique key on
(plan, period) makes a duplicate a database error rather than a duplicate
invoice. "Bill now" and the scheduler therefore can't collide, and a plan
signed mid-month is never back-charged for the weeks before it existed.

**Nothing is sent automatically.** Invoices are raised as **drafts**. There is
no email provider wired into this app, so "sent" would be a status flip with
nothing behind it — the dashboard counts the drafts waiting instead.

**A long outage bills the months it missed**, up to three, rather than
silently skipping them — the opposite of the lead-capture scheduler, where a
stale slot is dropped because a stale scrape is worthless.

Pausing keeps the history and stops the billing; resuming picks up from today
rather than back-billing the gap. Churn records why. Each plan also carries a
review cadence (quarterly by default) that shows as overdue on both the page
and the dashboard until it is marked held.

## Running it locally

You need Node 20+ and Docker.

Local Docker, so development never touches the live database (this is what
`.env.example` points at, on port 5433 to stay clear of a system Postgres):

```bash
docker run --name dakyworld-os-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dakyworld_os -p 5433:5432 -d postgres:16
```

Production uses Railway's own `DATABASE_URL` from its service variables —
don't copy that into a local `.env`.

### 1. Server

```bash
cd server
cp .env.example .env      # already points at the Docker database above
npm install
npm run prisma:migrate    # creates all tables
npm run seed               # optional: adds a sample client/lead/project/invoice
npm run dev                 # http://localhost:4000
```

`DEV_NO_AUTH=true` (the default in `.env.example`) runs the API as a single
implicit Owner with no login, so everything works immediately. It is ignored
when `NODE_ENV=production` — it can't accidentally unlock the live app.

To exercise the real login locally, set `DEV_NO_AUTH=false` and fill in
`OWNER_EMAIL` / `OWNER_PASSWORD`; the server creates that Owner on boot.

### 2. Client

```bash
cd server/client
cp .env.example .env
npm install
npm run dev                 # http://localhost:5173
```

Open http://localhost:5173 — the dashboard, leads, proposals, projects,
invoices, and clients pages are all live against the API.

## Lead capture

The **Capture** page (Owner only, `/lead-sources`) runs [Apify](https://apify.com)
actors and files what they find into the pipeline as leads.

**Connect once.** Paste an Apify API token into **Settings → Lead capture**.
The token is verified against Apify before it is accepted, then stored
AES-256-GCM encrypted in the `AppSetting` table — not in an env var, so lead
sources can be added and changed without a redeploy. (`APIFY_TOKEN` in the
environment still wins if you'd rather pin it there.)

**Add sources without code.** A source is one actor plus its input JSON. Add
one from a template (Google Maps businesses with no website, Google Maps +
email enrichment, contact sweep over a list of URLs), by searching the Apify
Store from inside the app, or by typing an actor id. Nothing about a new
source requires a deploy.

### What a capture costs, before it runs

Every actor behind lead capture bills **per event**, and the events are not the
results. A Google Maps run is charged per place, *plus* a filter charge on every
place for every filter applied, *plus* another per place if it crawls the site
for an email. So "100 places" is anywhere between $0.40 and $4.00 depending only
on which switches are set in the input — and nothing said so until the invoice.

The app now reads Apify's published rates at run time and works the arithmetic
out itself ([`services/captureCost.ts`](server/src/services/captureCost.ts)).
Three things come out of that:

- **An estimate before you spend it.** Quick capture shows what the paste will
  cost beside the button that runs it.
- **A ceiling when you didn't set one.** Every actor here is pay-per-event,
  which means `maxItems` does nothing to them — until August 2026 an unattended
  overnight run had no number at which it stopped. It now gets a
  `maxTotalChargeUsd` of roughly twice its estimate.
- **Warnings about paid switches that buy nothing.** `maxReviews: 10` on a Maps
  source costs $0.005 a review for text the app never reads.

Runs record what they actually cost next to what was estimated, so the estimate
either earns its trust over time or visibly doesn't.

**The actors were re-priced against those rates in August 2026** and three
changed. Google Maps moved from `lukaskrivka/google-maps-with-contact-details`
to `compass/crawler-google-places` — the same underlying scraper, one being a
wrapper on the other, and cheaper on every event: a 60-place search with emails
costs $0.42 instead of $0.63. Instagram's "about this account" add-on came off
every capture: $0.007 a profile on top of the $0.0026 for the profile itself,
for the account's country and the month it was created. And `skipClosedPlaces`
came off every Maps template — it is billed as a filter on *every* place
scraped, so on 100 places it spent about $0.10 to avoid roughly $0.012 of
closed ones, which the mapper already discards for nothing.

### Why a run found nothing

"40 found, 0 new" reads exactly the same whether the actor returned rubbish, the
score floor was too high, every business was already in the pipeline, or the
mapper couldn't read the rows at all. Each run now records why every dropped row
was dropped, with a count and a sample, and the runs table has a **why?** link
against the filtered column.

That last case was real: the Instagram, Facebook and LinkedIn quick-capture
actors were stored with the `CUSTOM` preset, which switched off every candidate
field path, so each of their rows failed the "no usable name" check and
vanished. The run charged, the dataset filled, and the pipeline stayed empty.
The mapper now recognises a row by its own keys — a Maps place, a contact sweep,
an Instagram profile, a Facebook Page, a LinkedIn company — and `CUSTOM` means
"try my field map first", not "try nothing else".

### Quick capture: type the thing, the right actor runs

Most capture is one company, not a campaign, and the ritual of adding a source
to read one website was the reason it didn't get used. **Quick capture** takes
what you type and works out which of five tasks it is — a website, a Google
Maps search, a LinkedIn company, a Facebook Page, an Instagram account — then
runs the actor paired with that task. Pasting a link costs nothing to read: a
classifier does it in memory, and only prose reaches Claude.

**Every pairing is visible and changeable.** Settings → Lead capture → *What
runs what* lists each task, what it takes, and the actor behind it. Point one
at a different actor when a better one turns up or the current one starts
failing; *Put back* returns it to the one the app ships with. Only what you
change is stored, so an override reads as an override. See
[`services/captureActors.ts`](server/src/services/captureActors.ts).

**Being read wrong costs a click, not a run.** Each target carries its task as
a dropdown — "no, that is their Facebook Page, not their site". And when the
words can't be read at all (no Anthropic key, or a request too vague to guess
at), the same five tasks are offered directly: pick one, give it the input it
asks for, run it. Reading is a convenience, never the only way in.

**A task checks its input before anything is charged.** These actors bill per
event, so an Instagram handle sent to the Facebook actor is money spent on
nothing. Each task normalises what it is given — a profile URL becomes the bare
handle, a bare domain gains its scheme — and refuses in a sentence when the two
don't match, naming the task it should have been. A LinkedIn `/in/` profile and
a Facebook personal profile are refused outright: those actors can only read
company pages.

**One place decides how every source behaves.** **Settings → Lead capture**
holds what a source shouldn't have to repeat:

- *The market.* One location, country and language. Any actor input containing
  `{{location}}`, `{{country}}`, `{{countryCode}}` or `{{language}}` is filled
  in at run time, so widening from Accra to Lagos is one edit rather than ten.
  (`{{date}}` and `{{yesterday}}` work the same way for moving search windows.)
- *What a run may cost.* A monthly Apify budget, a per-run charge cap, a wall
  clock timeout, and a limit on simultaneous runs. Runs are refused — free —
  once the month's spend reaches the budget. The timeout matters most: actors
  ship defaults measured in days, so a bad search string would otherwise run
  until it had spent everything.
- *What a new source starts as.* Row cap, score floor, qualify threshold,
  timezone.
- *Who hears about it.* A run report by email — off, failures only, or every
  run. Failures-only still reports a run that succeeded and filed nothing,
  because that is the failure that otherwise goes unnoticed.
- *Housekeeping.* How long run history is kept. Captured leads are never
  deleted by it.

**Proxies are per actor, not guessed.** Actors disagree about proxies: the
Google Maps ones take none, `vdrmota/contact-info-scraper` *requires*
`proxyConfig`, most crawlers want `proxyConfiguration`. The app reads each
actor's published input schema and only ever fills a field the actor actually
declares — writing the key yourself in the input JSON always wins.

**The actors themselves are checked.** An actor is someone else's code on
someone else's account: it gets renamed, made private or repriced. Settings →
Lead capture lists every actor in use with its pricing model and whether Apify
still returns it, and flags any input key an actor doesn't accept — those are
dropped silently by Apify, so a misspelt key is a filter that looks set and
isn't.

**Schedule them.** Each source takes up to six run times a day (`06:30`,
`18:00`, …) in its own timezone. An in-process scheduler ticks every minute
and starts whatever is due. The next slot is written to `nextRunAt` *before*
the run starts, so a failing actor can't retry-loop and a restart can't fire
the same slot twice. Slots missed by more than six hours — a long outage —
are skipped rather than stampeded through on boot. Runs interrupted by a
deploy are re-attached to on the next boot.

**Every lead says how it got in.** A `captureMethod` tag — Apify, Excel, CSV,
Google Sheet, Manual — sits beside the name on the Leads page, filters in the
bar next to "Any source", and groups under "How it got in". It's set by
whatever created the row and never changed afterwards: a lead that arrived on
a spreadsheet and is later found again by a scrape still arrived on a
spreadsheet. `source` is *where the business was found*; `captureMethod` is
*which door it came through* — the two sound alike and answer different
questions. PDF, DOCUMENT and API are declared but nothing writes them yet;
they're there because adding a Postgres enum value and using it need separate
migrations, and reserving them costs nothing.

**What arrives.** Each row is mapped to a lead (`GOOGLE_MAPS`,
`GENERIC_CONTACT`, automatic detection, or a custom field map), scored 0–100
on how reachable and how sellable-to it is, and filed into a named batch.
Scoring rewards a missing website and page-builder domains — the clearest
signal that a business needs what Dakyworld sells.

**Nothing duplicates and nothing is overwritten.** Every lead gets a
`dedupeKey` — place id, else website domain, else email, else phone, else
name+city. A re-run of the same search fills in blanks and refreshes ratings
and review counts, but never overwrites an edit, never downgrades a status,
and never creates a second row. Permanently closed businesses and rows below
the source's minimum score are dropped rather than saved.

**A run that stops early still counts.** Apify charges for what it did, so a
timed-out or aborted run has its dataset read and filed like any other, with
the reason kept alongside the results rather than instead of them.

Actor runs cost money on Apify. The whole feature is Owner-gated server-side
(`requireRole("OWNER")`), the cost ceiling goes to Apify with the run rather
than being applied to the results afterwards, and the monthly budget stops
runs starting at all.

## The letterhead

Proposals and invoices are the two things a client actually keeps, so they go
out on the printed identity rather than as plain typed pages. Every page of
every PDF is stamped by `services/letterhead.ts`: the diagonal corner ribbons,
the wordmark lock-up with its tagline, the contact block, the footer rule with
"ONE PARTNER. ALL YOUR IT.", and the oversized D watermark low on the right.
A three-page proposal is branded all the way through, not just on page one.

Colour and type come from `01 Brand/Dakyworld_Visual_Identity_Guide` — the
five-colour palette, and the 60-30-10 rule that keeps gold to accents. The gold
on a page here is two corner wedges, four hairline icons and one rule, which is
deliberately under that ceiling.

**The logo.** The identity guide says outright that logo artwork was never
produced and that the mark is a wordmark — "no icon crutch". The letterhead
template has since gained a D monogram, but that artwork isn't in this
repository, and a wrong logo on a document a client keeps is worse than a clean
typographic one. So the wordmark is drawn from type, and the moment somebody
puts a file at `server/assets/logo.png` it is used instead — no code change.
See `server/assets/README.md` for the export size.

### Preview and download

**Preview** on any proposal opens the finished document in the app. It is the
real rendered PDF in an iframe, not an HTML approximation — an approximation is
a second implementation of the same document, and the two drift, so you end up
approving a layout on screen and sending a different one. What is previewed is
byte-for-byte what downloads.

Two formats, both on the same letterhead:

| | |
|---|---|
| `GET /api/proposals/:id/document.pdf` | The preview and the PDF download (`?download=1` switches the disposition). |
| `GET /api/proposals/:id/document.docx` | Word, for clients who want to edit or redline. |

Both are side-effect-free GETs, which is what lets an `<iframe>` and a download
link point straight at them; the session cookie rides along on same-origin.
The writer's review screen also has **Preview the document**, which renders an
*unsaved* draft through the same renderer — so the layout is approved before
the proposal is committed.

Word gets its letterhead the way a printer does: the identity lives in the
page's header and footer so it repeats on every page, and the corner ribbons
are floating images anchored to the page behind the text. Word cannot draw a
diagonal, so those two ribbons are generated as PNGs at run time by
`services/png.ts` — a small hand-rolled encoder, which keeps the geometry
defined once, in points, next to the numbers the PDF strokes.

## Drafting a proposal

The proposal writer (**Proposals → Draft a proposal**, or **Draft proposal** on
any lead) writes about one company, from evidence about that company.

The difference it exists to make is the difference between these two sentences:

> A modern website helps businesses like yours build trust.

> adjeidental.com is served over plain HTTP, so Chrome shows every visitor
> "Not secure" before they see your name — and your domain has no DMARC record,
> so anyone can send an invoice that appears to come from you.

The first is a brochure and gets deleted. The second is a reason to reply. The
only difference is that someone looked.

**So it looks first.** `services/companyAudit.ts` fetches their homepage and
queries DNS, and reports what it finds: HTTPS or not, mobile viewport or not,
what the site is built on (a Wix page and a three-year-old WordPress are
different arguments), the year in the footer, response time, whether a visitor
can contact them at all, whether a link to them previews properly when shared,
whether anything measures the site, whether the domain receives mail, and
whether SPF and DMARC exist. A business with no website at all gets the
strongest findings of the lot.

**Every claim carries its evidence.** Each finding records the URL, header or
DNS record it came from, and the review screen shows them beside the argument
built on them. A prospect who checks one claim and finds it true believes the
rest; one who finds an invented claim stops reading. Checking takes ten seconds
and the Owner does it before sending.

**It cannot claim what it did not check.** The audit reports what it examined,
not only what it found, so "no backups" is never asserted — nobody looked at
their backups. A DNS query that fails is recorded as *not checked*, never as
*no record*: those look identical in code and only one of them is safe to put
in front of a prospect.

**It cannot invent a price.** Only prices Dakyworld publishes — the website
build from-price and the three care plan tiers, in `services/dakyworld.ts` —
may be quoted as firm. Everything else is priced after the discovery call and
marked as such. The Owner sets the final number on the review screen before
saving; the writer proposes, the founder prices.

**Nothing is sent by a model.** The draft is reviewed, edited and saved as an
ordinary proposal, which the existing PDF and email flow then carries. The
audit and the writer's own confidence are stored with it, so a claim can be
defended — or retracted — months later when their site has changed.

The writer needs an Anthropic key (**Settings → AI analyst**). The audit does
not, and runs free: **Just check them** on the same screen gives the evidence
with no model call, which is also the fastest way to prepare for a call.

## Importing a lead sheet

The **Import** page (Owner only, `/leads/import`) turns a spreadsheet into
leads. It exists because a real lead sheet is never one clean table: there's a
banner across row 4, headers on row 6, a second block of organisations further
down with different columns, an unlabelled column whose cells all read
"Switched off", and a phone number Excel turned into `2.56742E+11`.

**Where the file comes from.** Upload an `.xlsx`, `.csv` or `.tsv`, or connect
a Google account and pick a sheet straight out of Drive (read-only; native
Google Sheets are read through the Sheets API, and an `.xlsx` sitting in Drive
goes through the same parser an upload would). Multi-tab workbooks let you
choose which tabs to read.

**What the analyst does.** The grid goes to Claude, which returns a *plan*: the
tables it found, the exact row each one starts and stops at, and what every
column means — mapped to a lead field where one genuinely fits, kept as a
column of its own where none does, ignored only for row numbers and blank
filler. Nothing is written yet. The plan comes back for review: retitle a
table, untick one, drag a row boundary, remap a column, then re-preview.

**One file, several batches.** Each table in the plan becomes its own
`LeadGroup` with its own `LeadField` set. A sheet holding a table of people and
a table of companies lands as two batches that look nothing alike — which is
the point, since forcing them into one shape is exactly what loses the data.
Columns the fixed schema has never heard of ("Alternate phone", "Call outcome")
are kept in `Lead.customFields` and shown as real columns.

**Without an Anthropic key** the import still works — the file is mapped by
pattern rules instead, which handle a tidy sheet (blank-row-separated blocks,
banner rows as titles, header synonyms, a second phone column as its own
column) and hand you the same review screen to correct.

**Nothing duplicates.** Imported rows get the same kind of `dedupeKey` scraped
leads do — email, else website domain, else phone, else name+city — so
re-importing an updated sheet refreshes the same leads, filling blanks and
merging custom values rather than doubling the pipeline. Rows with no usable
name are skipped and counted.

### Editing leads and columns

**Any row edits in place.** The pencil at the end of a row turns it into
inputs — every column, including the name and any custom column the sheet
brought with it. Enter saves, Escape cancels. Status and source become
dropdowns so a typo can't invent a pipeline stage.

**Leads are grouped by list, not by status.** A lead belongs to the sheet or
scrape it arrived in, and that's how the page reads by default. Bucketing
everything under NEW / QUALIFYING / QUALIFIED instead throws away where each
lead came from and implies a judgement nobody has made yet — status is still
there as a grouping option, and as a filter, when you want it. **Searching
crosses every list**: type in the search box and the results come back as one
set drawn from all leads rather than re-bucketed.

**Export** hands back what you're looking at. Excel gives one worksheet per
list, each with that list's own columns; PDF is a landscape read-out of the
first eight columns, for printing or sending. Both take the same filters as
the table, and both cap at 5,000 rows.

### Tags

Leads carry tags, and so do lists. They answer different questions and are
deliberately kept apart: a lead is tagged with what the business *is* ("dental
clinic", "no website"), and a list with what the batch is *for* ("cold
outreach", "Q4 push", "do not contact until March"). Tagging a batch does not
put that label on the two hundred businesses inside it.

- **Filter by them** from the row above the status chips. Pick two and you get
  either; switch to *All of them* and you get both.
- **Tag in bulk.** Select leads and press *Tags…* — you can add and remove in
  one action, which is what retagging a segment usually needs: the leads that
  stop being *to-call* are the ones that become *called*.
- **Tag one lead** from its drawer.
- **Tag a list** from its heading on the leads table.

**Leads → Tags** is the vocabulary itself: every tag, how many leads and lists
carry it, a colour, and a note on what it means. The counts are the point —
a tag on four hundred leads is a segment and a tag on one is a typo, and until
they were counted there was no telling them apart.

Tags marked *auto* were coined by a capture, an import or a webhook rather than
by you; a scrape opens one per business category. Naming one adopts it: it
keeps every lead already carrying it and stops being marked as invented.

**Renaming a tag is always safe.** What a lead stores is the tag, not the word,
so every lead carrying it follows the rename. Deleting one is the opposite —
it comes off everything that had it, and the confirmation says how many.

### Editing the columns

**Leads → Columns** edits the table itself. Rename anything, reorder it, hide
what you don't need, add a column of your own (with a type — email, phone,
URL, currency, date…), or add a lead field that isn't currently shown.

Scope follows what you're looking at: with a batch filtered, you're editing
that batch's columns and the rest of the pipeline is untouched; with no batch
filtered, you're editing the default set every batch without its own falls back
to. Removing a column only takes it off the table — the values stay on the
leads, and adding it back shows them again.

Columns marked *lead field* address a `Lead` scalar (`contactName`, `city`, …)
and feed filtering, scoring and the conversion to a Client, so their meaning is
fixed even though their label isn't. Everything else lives in
`Lead.customFields`.

## Turning on the real integrations

Everything below is fully coded and wired — each just needs real keys to go
live. **Paste them into Settings** (Owner only, `/settings`), where they're
stored AES-256-GCM encrypted in the `AppSetting` table; nothing needs a
redeploy and nothing needs to be rewritten.

Each panel says what the integration unlocks, what state it's in, and where to
get the credential. Keys are verified against the provider *before* they're
saved, so a typo fails on the screen rather than silently at 6am.

The environment variables below still work and still win where one is set —
the panel then shows the value as env-managed and refuses to edit it, so the
deploy stays the source of truth wherever you chose to make it one.

| Settings panel | Get keys from | Env override |
|---|---|---|
| Lead capture (Apify) | https://console.apify.com/settings/integrations | `APIFY_TOKEN`, `SCRAPER_TIMEZONE`, `APIFY_MONTHLY_BUDGET_USD`, `APIFY_MAX_CONCURRENT_RUNS` |
| AI analyst (Anthropic) | https://console.anthropic.com/settings/keys | `ANTHROPIC_API_KEY` |
| AI models — ChatGPT | https://platform.openai.com/api-keys | `OPENAI_API_KEY`, `OPENAI_MODEL` |
| AI models — Gemini | https://aistudio.google.com/apikey | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| AI models — Perplexity | https://www.perplexity.ai/account/api/group | `PERPLEXITY_API_KEY`, `PERPLEXITY_MODEL` |
| Google Drive | https://console.cloud.google.com/apis/credentials | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` *(only behind a proxy that rewrites the host)* |
| Payments (Stripe) | https://dashboard.stripe.com/apikeys | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| File storage (Cloudinary) | https://console.cloudinary.com | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| Email (SMTP) | Your own mailbox — Workspace, Zoho, cPanel | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM_EMAIL` |
| Email (Hostinger MCP) | hPanel → Emails → Agentic mail → API | `HOSTINGER_MAIL_TOKEN`, `HOSTINGER_MAILBOX_ID`, `HOSTINGER_MAILBOX_ADDRESS`, `MAIL_TRANSPORT` |
| Reading the inbox (IMAP) | The same mailbox — usually the SMTP host with `smtp` swapped for `imap` | `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_ENABLED`, `MAIL_OWN_DOMAINS` |
| Alerts (Slack) | https://api.slack.com/messaging/webhooks | `SLACK_WEBHOOK_URL`, `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL` |
| Developer (GitHub) | https://github.com/settings/personal-access-tokens | `GITHUB_TOKEN`, `GITHUB_OWNER` |
| Calendar | Rides on the Google connection above | `GOOGLE_CALENDAR_ID` |
| Webhooks | Nothing to get — the secret mints itself | `WEBHOOK_SECRET` |
| General (public URL, timezone) | — | `APP_URL`, `SCRAPER_TIMEZONE` |

`MAIL_TRANSPORT` picks between the two email panels — `SMTP` or `HOSTINGER`.
Leave it unset and the app follows whichever was connected last.
`HOSTINGER_MCP_URL` and `HOSTINGER_MAIL_API` exist only for pointing the client
at a stand-in server; neither needs setting in production.

`APP_SECRET` is the one that isn't a panel: it's the key those stored secrets
are encrypted with, so it belongs in the environment.

Set `APP_SECRET` to any long random string. Without it, stored tokens are
encrypted with a key derived from `DATABASE_URL` and have to be re-entered if
that URL ever changes.

Without a mailbox connected, emails and sequences can be written and queued
but nothing sends — the Email page says so rather than failing quietly.
Without Cloudinary configured, "Generate PDF" still works — it streams the
PDF directly to your browser instead of uploading and storing a URL.
Without Stripe configured, invoice payment links return a clear 503 rather
than failing silently. Without an Anthropic key, sheet imports fall back to
pattern-rule mapping; without Google credentials, imports still accept
uploaded files.

The Google OAuth client must be of type **Web application**, with the Drive
API, Google Sheets API and **Google Calendar API** enabled, and with the
redirect URI shown in **Settings → Google** added to it verbatim — the app
derives it from the public URL (Settings → General, or `APP_URL`, or the
request host), and Google matches it character for character.

### Which model does what

Under **Settings → AI models** every job the system asks a model for is listed
with the model chosen for it:

| Job | Goes to | What it covers |
|---|---|---|
| Writing | Gemini | Every piece of prose — proposal copy, email drafts, ad concepts, page copy, cold outreach |
| Images | ChatGPT | Pictures for ads, social posts and mock-ups |
| Web pages | ChatGPT | Complete HTML pages on the brand design system |
| Fact-checking | Perplexity | Checks a draft's claims against live sources |
| Plain English | Perplexity | Rewrites a draft to sound like a person wrote it |

**You do not have to fill any of it in for the system to work.** Every job
falls back to Claude while the model picked for it has no key, and the screen
says which jobs are falling back rather than pretending they are configured.
Paste one key and that job moves onto its own model; nothing else changes.

Each key is checked against its provider before it is stored, so a typo fails
on the screen. Every call is priced and written to the spend ledger whichever
vendor served it — including Perplexity's per-search fee, which is larger than
the tokens on a short call.

Any job can be pointed somewhere else from the same screen. A vendor that
cannot do a job is not offered for it: Gemini will not appear under Images,
because a setting that looks saved and is never honoured is worse than no
setting.

**Fact-checking says who checked it.** Answered by Perplexity, the result
carries the sources it read. Falling back to Claude, it says so plainly and
reports that it was not checked against live sources — because checking a claim
against a model's training data is a much weaker thing, and you have to be able
to tell which one you got.

### The four the agents were waiting on

These were named in the agent blueprint and reported as "not built yet" until
August 2026. All four are now real, so the Tools screen has no unbuilt column
left — everything is either ready or waiting on a key.

**Slack** is for the things worth interrupting you: a scheduled capture that
failed at 06:00, an agent that escalated. An incoming webhook URL is one paste
and covers it. A bot token (`xoxb-…` with `chat:write`) is only worth the setup
once escalations should land in a different channel from run reports, which is
the one thing a webhook can't do.

**GitHub** gives the technical agents repository context — recent commits, open
issues, what shipped. A fine-grained token with *Contents: read*, *Issues: read
and write* and *Metadata: read* is enough. They can raise an issue; they cannot
touch code.

**Calendar** rides on the Google connection rather than asking for a second
one. A connection made before calendar access existed doesn't carry the scope,
and Settings → Google says so with a Reconnect button instead of failing at the
moment somebody tries to book a consultation.

**Webhooks** take events in from other systems. The contact form on
dakyworld.com posting to `/api/webhooks/website-form` creates a scored,
de-duplicated lead in the pipeline — an enquiry from somebody already found by
a scrape merges into that lead instead of duplicating it. Senders other than
the form must sign: HMAC-SHA256 over `` `${timestamp}.${body}` `` in an
`x-dakyworld-signature` header, with the timestamp in `x-dakyworld-timestamp`,
and anything over five minutes old is refused. The form itself is deliberately
allowed unsigned — a static GitHub Pages site has nowhere to keep a secret, and
losing real enquiries to that is worse than accepting an unsigned post that can
only ever create a lead. Everything that arrives is recorded either way.

### What the agents can actually do

**Tools** (`/tools`) has two halves. *Connections* is one row per integration —
the only place a red dot means work for you. *The catalogue* is the individual
things an agent calls: `lead.read`, `email.send`, `capture.run`, and about
thirty others.

The toolkit on each agent is a **real grant**: the tool layer checks it before
every call, so ticking a box on the Agents screen hands over a capability and
clearing it takes the capability away. Three separate things can stop a granted
tool from firing, and the agent's drawer names which — the integration isn't
connected, the agent's autonomy level is too low, or dry run is on. Outward-
facing tools (sending an email, booking a meeting, opening an issue) need
autonomy 3; spending money needs 4. Below that they *prepare* the action and
show you what they would have done.

Every call is recorded in `ToolCall`, including the ones that were refused.
That log is what answers "why did nothing happen last night".

### The specialists

The management tier recommends and decides. Under it sit eleven
**specialists**, and these are the ones that make things:

| | Reports to | What it is for |
|---|---|---|
| Web Developer | Technical Director | Builds and fixes the sites, from markup to DNS to the handover |
| Automation Engineer | Technical Director | Maps a workflow, wires the systems together, removes the manual steps |
| QA Tester | Technical Director | Finds what is broken before a client does |
| Graphic Designer | Growth & Content | Identity, layout, social templates, the artwork clients keep |
| Video Editor | Growth & Content | Structure, captions, motion, the cut per platform |
| Ad Designer | Growth & Content | Paid-social creative and the test that settles it |
| Copywriter | Growth & Content | Pages, case studies, email copy, SEO briefs |
| SEO Specialist | Growth & Content | The technical faults costing a client rankings, then the words |
| Support Desk | Operations Director | Triage, first response, and routing before an SLA is at risk |
| Proposal Writer | Commercial Operations | The proposal that wins the work: their words, the scope, the price, what happens next |
| Cold Lead Writer | Outbound Communications | The first message to somebody who has never heard of you |

Each is deliberately narrow. "A creative agent" would be one prompt asked to
design a logo, cut a video and write an ad, and it would be mediocre at all
three — those are three crafts with three vocabularies and three definitions of
finished. One job each also means "who do I ask for a video edit" has an answer.

**Skills and tools are different things.** Skills are what a specialist is
asked for, written in a client's words — "Subtitles and burned-in captions",
"Local SEO and Google Business Profile" — and they are what a job is matched
against. Tools are what it can reach, and only tools are a permission.

The last two are the reason this list grew. A proposal used to be drafted by
the Commercial Operations Manager in between pricing an invoice and chasing a
payment, and a cold email by the Outbound Communications Manager in between
running a sequence and checking a suppression list — by managers, in the gaps,
as a task rather than as a craft. Writing to somebody who has never heard of
you is a craft, and so is the document that decides a deal.

**Hire a specialist** adds one of your own: a 3D artist, a bookkeeper, a
translator. It arrives at level 1 with dry run on and no tools, exactly as the
built-in ones do. A built-in agent can be retired but not deleted — deleting
one would only mean the next deploy created it again.

### Changing what an agent is told

Open an agent and press **Edit** under *Its instructions*. Every layer of the
prompt is a box: who it is, what it is for, where it stops, how it works
through a job, what makes it stop and ask, and the shape of what it hands back.

This used to be read-only for the eleven built-in agents, which left two bad
options for changing how one of your own agents works: edit a TypeScript file,
or hire a duplicate and write the job out again. A prompt is the instruction —
it is yours.

Three things make that safe rather than reckless:

- **The shipped wording is one click away.** *Reset to shipped* puts every
  field back. *Show shipped* marks which layers you have changed without
  undoing anything.
- **A deploy never overwrites your edit.** The seed only ever creates agents it
  has never seen; it has never updated one.
- **Nothing about permissions is in there.** The toolkit, the autonomy level
  and dry run are elsewhere, and neither an edit nor a reset touches them.
  Changing what an agent is told to do is a different decision from changing
  what it is allowed to reach.

An edit takes effect on that agent's **next task**. One already running
finishes on the wording it started with, and the screen says so.

### One at a time

An agent works on one task at a time. Queue five and it takes them in order,
finishing each before it starts the next, and the fifth waits rather than
racing the first.

That is partly so the roster reads honestly — "the Proposal Writer is working
on the Adom Clinic proposal" is a sentence you can act on, and "working on
four things" is not. Mostly it is about memory: an agent writes down what it
concluded as it goes and reads it back on the next task about the same
subject, so two tasks about one lead running side by side would interleave
those notes and the agent would end up contradicting itself with nothing in
the timeline to explain why.

### They run the work

Click an agent and you see what it is doing. That is the point of the whole
layer, and until now the answer was "nothing" — the roster was a list of jobs
and a set of permissions with no engine behind it.

**A task is the unit of everything.** You give one to an agent in the words you
would use with a person; the clock raises them on a cadence; an event raises
them when something happens; and a manager hands one to a report. It carries a
brief, a priority, and the record it is about.

**Then it works.** It claims the task, is told who it is (its ten prompt
layers, its skills, the company's own details), is told what it already
concluded about this subject, is handed only the tools its toolkit grants, and
turns a loop: call a tool, read the answer, decide again. Every call still goes
through the same four gates — nothing here can act outside what the Agents
screen allows.

**The timeline is written as it happens**, so a task that is still running shows
what it has done so far rather than a spinner. Each step says which it was:

| | |
|---|---|
| **Tool call** | It ran, and it took effect. |
| **Prepared** | It was downgraded to a preview — the agent is in dry run or below the autonomy that tool needs. The step says exactly what would have happened. |
| **Refused** | The policy said no, with the reason. The agent is told, and carries on or escalates. |
| **Remembered** | It kept something for next time. |
| **Delegated** | It handed a piece to one of its reports. |

**Five ways a task ends**, and they mean different things. *Done* — everything
took effect. *Ready to approve* — some or all of the work was prepared and
nothing has happened yet; read the timeline and approve it, or raise the
agent's autonomy to stop being asked. *Stopped and asked* — it escalated
rather than guessing; answer in the drawer and it carries on from there.
*Failed* — the reason is on the task; a rate limit re-queues itself. *Cancelled.*

At the shipped settings — level 1, dry run on — the normal outcome is **Ready
to approve**: one thing to read rather than five things to do. That is what
autonomy level 1 is for, not a limitation to work around.

### What they remember

Every agent's prompt has always ended with *retain decisions, their reasons and
their outcomes; never retain secrets*. There was nowhere to put them, so every
task started from nothing and an agent could reach the same wrong conclusion
about the same lead every morning without noticing.

Now it writes them as it works — a decision and why, what came of it, a fact
about a client, a lesson about its own approach — and is handed them back the
next time the same subject comes up. You can also tell it something directly
from its drawer; that is filed as a standing preference and shown on every task.

**Recall is by subject, not by similarity.** A memory is filed against a lead,
a client, or `self`, and an agent is handed what *it* concluded about *that*
subject and nothing about anybody else. A search across everything would
occasionally surface a fact about a different client in the context of this
one, and the failure mode of that is a letter to the wrong company containing
the right facts.

**A memory can never hold a credential.** Not because an agent would not be
told — every prompt says so — but because a memory is re-read into a prompt
every time its subject comes up, so a token in one is a token re-read every
morning for a year. The store refuses anything credential-shaped outright.

### What every agent knows

At the bottom of the Agents screen is the company's own memory: written once,
and put in front of every agent alongside whatever that one has worked out for
itself.

This is where a house rule goes. *We do not take on unregistered businesses.*
*Quote every price in cedis.* *Never promise a delivery date in December.*
Each of those used to have to be typed into every agent separately — and the
one you hire next month would never have heard any of them.

An agent can add to it too, when it concludes something about how Dakyworld
works rather than about its own way of working. Those are marked with the
agent that wrote them, so *why does it think that* stays answerable.

**Sharing changes who sees a memory, never when it comes up.** Recall is still
by subject, so a shared note about one client surfaces on tasks about that
client and nowhere else. Left on `company` — which is the right answer nearly
every time — it is shown on every task.

Both kinds can be edited rather than only deleted. A conclusion that has gone
stale should be corrected, not thrown away along with the record that it was
ever held.

### Connected tools

The catalogue is code on purpose: what a tool *does* is behaviour, and
behaviour that can be edited at runtime is behaviour nobody can review. That
left one thing impossible — adding a capability without a deploy — and **MCP**
is the way out that doesn't break the rule.

Connect a server under *Tools → Connected tools*. It declares its own tools
with their own schemas, and each becomes a grantable catalogue entry named
`mcp.<server>.<tool>`, called through the same invoker, the same grant check,
the same autonomy gate and the same `ToolCall` audit row as a built-in one.
Nothing about the policy is different because the tool came from outside.

Three things are **never** taken from the server, and they are the three the
form asks you for: how risky its tools are, whether calls cost money, and
whether calls are visible outside the company. A server describing its own tool
as harmless is a server asking to act unwatched.

A connection arrives switched off. Connecting a server and letting agents call
it are two decisions, and doing both in one step means the first silently makes
the second. Removing a connection revokes every grant that named it.

### The studio tools

Seven tools exist for the specialists specifically. Most produce a
**specification**, which is the honest boundary of what this app does on its
own and also what a designer, an editor or a developer actually wants handed to
them:

- `design.brief` — purpose, audience, hierarchy, the exact set-ready copy, the
  palette from the brand system, and real pixel dimensions per placement.
- `video.plan` — structure with second counts that add up, the shot list, the
  caption script, the cut per platform.
- `ad.concept` — genuinely different angles rather than variants of one idea,
  with the platform specs, the test plan, and the claims that need checking.
- `web.page` — a complete self-contained HTML page on the brand design system,
  with real copy, plus a list of what a developer must change before it ships.
  Built by ChatGPT when a key is set.
- `content.factcheck` — pulls every checkable claim out of a draft and judges
  each against live sources: confirmed, outdated, unsupported or wrong, with
  the URL it read. It says who checked it and whether the sources were live,
  because those are different levels of assurance.
- `content.humanise` — the same draft in plain English: the consultant
  vocabulary gone, one idea per sentence, and every number, date and promise
  left exactly as it was. Anything it cut is listed separately so you can put
  it back.

`image.generate` makes an actual picture. It is a **named capability rather
than a named provider**: an agent's toolkit says "this one draws", and what
draws is a connection you make. It goes to ChatGPT when a key is set, and to a
connected MCP server otherwise; with neither, it refuses with a sentence saying
which to set up rather than failing obscurely.

## The rehearsal room

**Agents → Rehearsal.** Give it a website, choose a workflow, and watch the
whole floor work on that business as if it were a real prospect. It is the
answer to the question you can otherwise only answer by finding out the hard
way: *what would these agents actually do if I turned them loose?*

Nothing is faked. The same agents read the same prompts, call the same tools
through the same gate, spend the same money on the same models, and hand work
to each other by the same rules. Three things differ, and only three:

1. **Nothing can leave the building.** Every call that would reach outside the
   company — an email, a WhatsApp, a payment, a booking, a page published under
   somebody's business name — stops at a preview, whatever autonomy the agents
   are on. They are listed at the bottom of the run under *Prepared, and not
   carried out*, each with the case the agent made for doing it: why, what it
   gains, what the risk is. That list is exactly what you would be approving one
   by one if the run were real.
2. **The lead is a scratch lead.** The workflow needs one — looking a business
   up, drafting to them and building them a page all take a lead — so a real row
   is created and marked. It stays out of the leads list, out of the dashboard's
   pipeline count, and out of every email sequence.
3. **You can throw it away.** *Throw it away* deletes the tasks and the scratch
   lead and everything that hung off them. What it spent stays on the ledger.

**Research, reviews and drafts really run, and really cost money.** That is
deliberate: a rehearsal that previewed the site audit would be a rehearsal in
which every agent describes work you cannot open. The cost of the run is on the
screen for the same reason — it is worth knowing what one prospect costs before
the workforce is turned loose on four hundred.

### The five workflows

| Workflow | Starts with | What it shows you |
|---|---|---|
| **Website to first letter** | Sales Director | Whether anybody looks at the site before writing to them, and which finding the letter leads on |
| **Four reviewers over the site** | Growth & Content Director | Whether the audit team is reached at all, and what the four reviewers disagree about |
| **Build them a demo page** | Technical Director | Where the design direction comes from, and whether anything about the business gets invented |
| **Scope and price the work** | Sales Director | Whether scope is argued from evidence, and what happens when the catalogue has no price for it |
| **The whole floor** | Chief Executive | How the directors split it up, whether any of it is done twice, and where the chain breaks |

Each one names **one agent to start with** and writes **one brief**, and
everything after that is the workforce deciding for itself. That is the point:
a scripted pipeline would prove the script works, which nobody doubts. What is
in question is whether an agent given a website and a goal reaches the right
colleague — and this is the only way to watch it happen.

### Reading a run

The timeline is **merged**: every step from every agent, in the order it
happened, grouped by whoever was speaking. It reads like the transcript of a
meeting, so a handover looks like a handover. The filters above it narrow to
one thing at a time — *Reasoning* is what the agents said on the way, *Tools*
is what they called, *Handovers* is who reached whom. Clicking an agent on the
left reads only their part.

*Who it went to* is built from what each agent recorded doing, not from a
separate record — an agent appears under another because it wrote a delegation
or a hand-off in its own timeline. *What it produced* is read off the records
rather than off the timeline, because "the audit team ran" and a review you can
open are different claims and only the second is evidence.

### It switches the agents on for you

Every specialist and most of the board ship as a **draft**, and a draft picks
nothing up. You do not have to go and switch them on: **starting a rehearsal
wakes the agents it needs, and puts them all back when the run ends.** Each
workflow card says how many it would wake before you press anything, and the run
itself says which ones it woke while it is going and confirms they were put back
when it is done.

- It wakes the agent it starts with and everyone under them on the chart, and
  wakes anyone else the moment an agent hands work sideways to them.
- **Anyone you have deliberately paused stays paused**, and so does anyone
  retired. Being a draft means never having been switched on; pausing is a
  decision you made, and a test is not a reason to overrule it.
- If the process running a rehearsal is killed mid-run, the next boot puts the
  agents back and marks that run as stopped — so an abandoned test never leaves
  the floor switched on.

The one-agent-one-task rule still applies, so a wide run works through the floor
a task at a time rather than all at once.

## Deploying

Client and server deploy as **one Railway service** on one domain
(`os.dakyworld.com`): the Express process serves `client/dist` as static
files and the API under `/api`, so there's no second service, no CORS setup,
and `VITE_API_BASE=/api` just works.

The service's **Root Directory is `server`**, which is the entire build
context — a folder alongside it at the repo root does not exist at build time.
That is why the client lives at `server/client` rather than `client/`: it has
to be inside that directory to be built at all. `server/railway.json` is the
config Railway reads.

| Phase | Command | What it does |
|---|---|---|
| Build | `npm run build` | builds `server/client/dist`, then compiles the API |
| Start | `npm start` | `prisma migrate deploy` then boots the server |

The root `package.json` and `railway.json` mirror this for the case where
Root Directory is ever changed to the repo root; keep them in step.

Required service variables: `DATABASE_URL`, `NODE_ENV=production`,
`OWNER_EMAIL`, `OWNER_PASSWORD`. Deploys happen on push to `main`.

## Authentication

Email and password, built into the app — no third-party identity provider.
Railway hosts it and holds the variables, but nothing else is involved.

- Passwords are hashed with **scrypt** from Node's standard library, so
  there's no native module for Railway's builder to compile.
- A session is 32 random bytes in an `HttpOnly; Secure; SameSite=Lax` cookie.
  Only its SHA-256 is stored, so a database dump can't be replayed as a login.
  Sessions last 30 days and slide forward while in use.
- Login failures are deliberately uniform — unknown address, wrong password,
  no password set and deactivated account all return the same message and
  take about the same time, so nobody can enumerate who has an account.

### The first account

`OWNER_EMAIL` / `OWNER_PASSWORD` create the Owner on boot, and re-apply that
password on every boot. **Lockout is always recoverable**: change
`OWNER_PASSWORD` in Railway, redeploy, sign in.

The trade-off is that the deploy owns this password, so `/api/auth/password`
refuses to change it from the UI — it would be reverted on the next deploy.
Change it in Railway instead.

### Adding someone

`POST /api/users` as an Owner, with a `password`, then pass it on out of band.
There's no invitation email — this is a handful of internal people, not public
signup. An Owner resets a forgotten password with
`PATCH /api/users/:id/password`, which also drops that person's live sessions.
Anyone else changes their own via `POST /api/auth/password`.

Not built: password reset by email, MFA, and social login. Each needs either
an email provider or a third-party identity service.

## Project structure

```
Dakyworld OS/
  server/            Express + TypeScript API
    prisma/
      schema.prisma  Full data model — 11 entities from the original spec
      seed.ts        Sample data for local development
    src/
      lib/           Prisma client, password hashing, sessions, timezone maths,
                     SMTP mailer, AI email drafter, Stripe, Cloudinary,
                     Apify REST client, Anthropic sheet analyst, Google Drive/Sheets
                     client, encrypted settings store
      middleware/    Session auth (or dev bypass) + role permission gate
      routes/        auth, clients, leads, proposals, projects, invoices,
                     care-plans, emails (+ the public unsubscribe), users,
                     dashboard, scrapers, imports, settings (every runtime key)
      services/
        pdf.ts           Proposal and invoice documents, laid out on the letterhead
        letterhead.ts    The printed identity: ribbons, wordmark, contacts, footer, watermark
        proposalDocx.ts  The same proposal as Word, letterhead in the header/footer
        png.ts           A small PNG encoder — the corner ribbons, for Word
        leadMapping.ts   Scraped row -> lead: field resolution, scoring, dedupe keys
        leadFields.ts    The leads table's shape: built-in columns, custom ones, coercion
        spreadsheet.ts   .xlsx/.csv -> plain grids, nothing interpreted
        sheetPlan.ts     Table detection, header synonyms, plan validation, row extraction
        leadImport.ts    Runs an approved plan: groups, columns, leads, dedupe
        scraperRunner.ts Starts Apify runs, polls them, ingests the results
        captureConfig.ts How every scrape behaves: market, cost ceilings, proxy, defaults
        captureNotify.ts The run report — failures, and runs that quietly found nothing
        companyAudit.ts  Fetches their site, asks DNS: what is actually wrong, with evidence
        proposalContext.ts What the proposal writer may know — the record plus the audit
        dakyworld.ts     The brand, the voice, and the priced service catalogue
        carePlanBilling.ts  Retainer periods, overage settlement, invoice raising
        invoiceNumber.ts    Monthly invoice numbering, collision-safe
        emailContext.ts     What we know about a recipient, as facts
        emailRender.ts      Placeholders, text+HTML, signature, unsubscribe
        emailSender.ts      Compose, suppression check, attachments, send
        emailSequences.ts   Enrolment, send windows, step running, stopping
        emailTemplates.ts   The thirteen letters that ship with the app
        scheduler.ts     Minute tick: lead capture, care plan billing, email
        scraperTemplates.ts  Pre-filled starting points for the Capture page
    client/          React + TypeScript + Tailwind SPA (nested so Railway builds it)
      src/
        pages/       Login, Dashboard, Leads, LeadImport, LeadSources, Proposals,
                     CarePlans, Emails,
                     Projects(+detail), Invoices, Clients(+detail), Settings
        components/  Layout/nav, shared UI primitives, LeadDrawer, LeadColumns
                     (dynamic cells + column editor), SourceEditor
        lib/         Typed API client, auth context, shared types
```

## Data model

See `server/prisma/schema.prisma` for the authoritative model. It covers
all eleven entities from the original spec — `User` (with `Role` enum),
`Client`, `Contact`, `Lead`, `Proposal`, `Project`, `ProjectAssignment`,
`Milestone`, `Task`, `TimeEntry`, `CarePlan`, `Invoice` + `InvoiceLineItem`,
`Communication` + `Attachment` — plus what lead capture added: `LeadGroup`
(capture batches), `ScraperSource` (a configured actor and its schedule),
`ScraperRun` (one execution and its tally), `AppSetting` (encrypted runtime
config), and the firmographic columns on `Lead` itself; plus what the
spreadsheet import added: `LeadField` (a column of the leads table — global or
per-batch, built-in or custom), `LeadImport` (one import run and the plan it
ran), and `Lead.customFields` (values for columns that aren't `Lead` scalars)
— even though the UI currently only exposes
Phase 1's slice (Leads, Proposals, Projects, Invoices, Clients). Care Plans,
Time & Capacity reporting, and Communications logging have working API
routes' data model in place and can get a UI page added the same way the
existing pages were built, without any schema changes.

And `LeadTag` — the tag vocabulary, with the label, colour and description
behind the slugs that `Lead.tags` and `LeadGroup.tags` actually store, which is
what makes renaming a tag cost one row.

Since then: `Agent` and `ToolCall` (the workforce and its audit trail),
`StoredFile` (an uploaded email attachment, held as bytes so attaching a file
works before any storage credential has been pasted), and `McpServer` (a
connected tool server and the tools it advertises). The company's own details
and its logos live in `AppSetting` rather than in a model of their own — see
**System settings** above.
