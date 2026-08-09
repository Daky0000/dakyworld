# Dakyworld OS

Internal operations platform — leads, proposals, projects, invoices, care
plans, time tracking, and a live revenue dashboard. Built from the Phase 1
MVP scope of the original system spec (`18_Dakyworld_Custom_Operating_System.pdf`).

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
- **Configurable lead columns** — rename, reorder, hide and add columns, per
  batch or across the whole pipeline, without a schema change.
- **Settings** — every integration key (Apify, Anthropic, Google, Stripe,
  Cloudinary) pasted in the app and stored encrypted in the database, so
  adding or rotating one never needs a redeploy.
- **Proposal & Negotiation** — create, generate a branded PDF, send, and
  accept (which auto-creates the Client + Project) or reject.
- **Project & Delivery** — milestones, tasks, team assignment, time logging.
- **Invoicing & Payments** — line-item invoices, PDF generation, Stripe
  Checkout payment links, manual mark-paid.
- **Revenue Dashboard** — live MRR, outstanding invoices, pipeline value,
  leads-by-status — computed on read, no manual reporting.
- **Role model** — Owner / Project Manager / Developer / Designer /
  Operations-Finance / Client Viewer, enforced server-side (`requireRole`).
  Today, only the Owner-role check on team management is actually wired up
  as a gate — extend `requireRole(...)` on other routes as the team grows.

Not yet built (later phases per the original spec): Care Plan billing
automation, quarterly-review reminders, AI-powered churn/upsell insights,
Slack notifications, a client-facing portal.

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

**Schedule them.** Each source takes up to six run times a day (`06:30`,
`18:00`, …) in its own timezone. An in-process scheduler ticks every minute
and starts whatever is due. The next slot is written to `nextRunAt` *before*
the run starts, so a failing actor can't retry-loop and a restart can't fire
the same slot twice. Slots missed by more than six hours — a long outage —
are skipped rather than stampeded through on boot. Runs interrupted by a
deploy are re-attached to on the next boot.

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

Actor runs cost money on Apify. The whole feature is Owner-gated server-side
(`requireRole("OWNER")`), and `maxItems` caps every run.

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
| Lead capture (Apify) | https://console.apify.com/settings/integrations | `APIFY_TOKEN` |
| AI analyst (Anthropic) | https://console.anthropic.com/settings/keys | `ANTHROPIC_API_KEY` |
| Google Drive | https://console.cloud.google.com/apis/credentials | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` *(only behind a proxy that rewrites the host)* |
| Payments (Stripe) | https://dashboard.stripe.com/apikeys | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| File storage (Cloudinary) | https://console.cloudinary.com | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| General (public URL, timezone) | — | `APP_URL`, `SCRAPER_TIMEZONE` |

`APP_SECRET` is the one that isn't a panel: it's the key those stored secrets
are encrypted with, so it belongs in the environment.

Set `APP_SECRET` to any long random string. Without it, stored tokens are
encrypted with a key derived from `DATABASE_URL` and have to be re-entered if
that URL ever changes.

Without Cloudinary configured, "Generate PDF" still works — it streams the
PDF directly to your browser instead of uploading and storing a URL.
Without Stripe configured, invoice payment links return a clear 503 rather
than failing silently. Without an Anthropic key, sheet imports fall back to
pattern-rule mapping; without Google credentials, imports still accept
uploaded files.

The Google OAuth client must be of type **Web application**, with the Drive
API and Google Sheets API enabled, and with the redirect URI shown in
**Settings → Google Drive** added to it verbatim — the app derives it from the
public URL (Settings → General, or `APP_URL`, or the request host), and Google
matches it character for character.

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
      lib/           Prisma client, password hashing, sessions, Stripe, Cloudinary,
                     Apify REST client, Anthropic sheet analyst, Google Drive/Sheets
                     client, encrypted settings store
      middleware/    Session auth (or dev bypass) + role permission gate
      routes/        auth, clients, leads, proposals, projects, invoices, users,
                     dashboard, scrapers, imports, settings (every runtime key)
      services/
        pdf.ts           Branded proposal/invoice PDF rendering
        leadMapping.ts   Scraped row -> lead: field resolution, scoring, dedupe keys
        leadFields.ts    The leads table's shape: built-in columns, custom ones, coercion
        spreadsheet.ts   .xlsx/.csv -> plain grids, nothing interpreted
        sheetPlan.ts     Table detection, header synonyms, plan validation, row extraction
        leadImport.ts    Runs an approved plan: groups, columns, leads, dedupe
        scraperRunner.ts Starts Apify runs, polls them, ingests the results
        scheduler.ts     Minute tick that fires each source's daily run times
        scraperTemplates.ts  Pre-filled starting points for the Capture page
    client/          React + TypeScript + Tailwind SPA (nested so Railway builds it)
      src/
        pages/       Login, Dashboard, Leads, LeadImport, LeadSources, Proposals,
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
