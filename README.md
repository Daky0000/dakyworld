# Dakyworld OS

Internal operations platform — leads, proposals, projects, invoices, care
plans, time tracking, and a live revenue dashboard. Built from the Phase 1
MVP scope of the original system spec (`18_Dakyworld_Custom_Operating_System.pdf`).

**Stack:** React + TypeScript + Tailwind (client) · Node + Express + TypeScript
(server) · PostgreSQL via Prisma · Clerk (auth) · Stripe (payments) ·
Cloudinary (file storage, PDF hosting).

## What's built (Phase 1 MVP)

- **Lead & Pipeline** — full CRUD, source/status tracking, lead scoring.
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

You need Node 20+ and a PostgreSQL database. Two ways to get one:

**Option A — Railway (recommended, matches your existing account):**
1. Create a new Railway project → **+ New → Database → PostgreSQL**.
2. Open the Postgres service → **Variables** tab → copy `DATABASE_URL`.

**Option B — local Docker, just for development:**
```bash
docker run --name dakyworld-os-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dakyworld_os -p 5432:5432 -d postgres:16
# DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dakyworld_os?schema=public"
```

### 1. Server

```bash
cd server
cp .env.example .env      # then paste your DATABASE_URL
npm install
npm run prisma:migrate    # creates all tables
npm run seed               # optional: adds a sample client/lead/project/invoice
npm run dev                 # http://localhost:4000
```

`DEV_NO_AUTH=true` (the default in `.env.example`) runs the API as a single
implicit Owner user with no real login — everything works immediately. Set
it to `false` and add real `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` once
you're ready for real accounts and roles.

### 2. Client

```bash
cd client
cp .env.example .env      # blank Clerk key = matches server's DEV_NO_AUTH mode
npm install
npm run dev                 # http://localhost:5173
```

Open http://localhost:5173 — the dashboard, leads, proposals, projects,
invoices, and clients pages are all live against the API.

## Turning on the real integrations

Everything below is fully coded and wired — each just needs real keys
dropped into `server/.env` (and `CLERK_PUBLISHABLE_KEY` into `client/.env`
for auth) to go live. Nothing needs to be rewritten.

| Integration | Get keys from | Env vars |
|---|---|---|
| Auth (Clerk) | https://dashboard.clerk.com → API Keys | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` (+ `VITE_CLERK_PUBLISHABLE_KEY` on client), set `DEV_NO_AUTH=false` |
| Payments (Stripe) | https://dashboard.stripe.com/test/apikeys | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| File storage (Cloudinary) | https://console.cloudinary.com | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |

Without Cloudinary configured, "Generate PDF" still works — it streams the
PDF directly to your browser instead of uploading and storing a URL.
Without Stripe configured, invoice payment links return a clear 503 rather
than failing silently.

## Deploying

Both Railway and Hostinger (the accounts you already have) can host this:

- **Server**: Railway is the natural fit — it's already where Postgres
  lives. `railway up` from `server/`, add the env vars from `.env` in the
  Railway dashboard, set the start command to `npm run build && npm start`.
- **Client**: build with `npm run build` in `client/` (outputs `dist/`),
  deploy the static output to Railway (as a static site service) or
  Hostinger. Point `VITE_API_BASE` at your deployed server's URL and
  `CLIENT_ORIGIN` on the server at your deployed client's URL.
- **GitHub**: this folder is already a git repo (`git init` was run). Create
  a repo on GitHub and `git remote add origin ...` / `git push` when you're
  ready — nothing has been pushed yet.

## Project structure

```
Dakyworld OS/
  server/            Express + TypeScript API
    prisma/
      schema.prisma  Full data model — 11 entities from the original spec
      seed.ts        Sample data for local development
    src/
      lib/           Prisma client, Stripe, Cloudinary
      middleware/    Auth (Clerk-or-dev-bypass) + role permission gate
      routes/        clients, leads, proposals, projects, invoices, users, dashboard
      services/pdf.ts  Branded proposal/invoice PDF rendering
  client/            React + TypeScript + Tailwind SPA
    src/
      pages/         Dashboard, Leads, Proposals, Projects(+detail), Invoices, Clients(+detail)
      components/    Layout/nav + shared UI primitives
      lib/           Typed API client, shared types
```

## Data model

See `server/prisma/schema.prisma` for the authoritative model. It covers
all eleven entities from the original spec — `User` (with `Role` enum),
`Client`, `Contact`, `Lead`, `Proposal`, `Project`, `ProjectAssignment`,
`Milestone`, `Task`, `TimeEntry`, `CarePlan`, `Invoice` + `InvoiceLineItem`,
`Communication` + `Attachment` — even though the UI currently only exposes
Phase 1's slice (Leads, Proposals, Projects, Invoices, Clients). Care Plans,
Time & Capacity reporting, and Communications logging have working API
routes' data model in place and can get a UI page added the same way the
existing pages were built, without any schema changes.
