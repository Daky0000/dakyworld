# Dakyworld OS

Internal operations platform — leads, proposals, projects, invoices, care
plans, time tracking, and a live revenue dashboard. Built from the Phase 1
MVP scope of the original system spec (`18_Dakyworld_Custom_Operating_System.pdf`).

**Stack:** React + TypeScript + Tailwind (client) · Node + Express + TypeScript
(server) · PostgreSQL via Prisma · built-in email/password auth · Stripe (payments) ·
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

## Turning on the real integrations

Everything below is fully coded and wired — each just needs real keys
dropped into `server/.env` to go live. Nothing needs to be rewritten.

| Integration | Get keys from | Env vars |
|---|---|---|
| Payments (Stripe) | https://dashboard.stripe.com/test/apikeys | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| File storage (Cloudinary) | https://console.cloudinary.com | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |

Without Cloudinary configured, "Generate PDF" still works — it streams the
PDF directly to your browser instead of uploading and storing a URL.
Without Stripe configured, invoice payment links return a clear 503 rather
than failing silently.

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
      lib/           Prisma client, password hashing, sessions, Stripe, Cloudinary
      middleware/    Session auth (or dev bypass) + role permission gate
      routes/        auth, clients, leads, proposals, projects, invoices, users, dashboard
      services/pdf.ts  Branded proposal/invoice PDF rendering
    client/          React + TypeScript + Tailwind SPA (nested so Railway builds it)
      src/
        pages/       Login, Dashboard, Leads, Proposals, Projects(+detail), Invoices, Clients(+detail)
        components/  Layout/nav + shared UI primitives
        lib/         Typed API client, auth context, shared types
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
