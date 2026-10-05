# DakyXTech infrastructure current state

Last verified: 2026-10-04.

## GitHub

- Repository: `Daky0000/dakyworld`
- Default and production branch: `main`
- Marketing site: repository root, published with GitHub Pages
- Internal OS and Multi-Product backend: `server/`, deployed to Railway
- GitHub Pages custom domain is `dakyx.com` (both `dakyx.com` and `www.dakyx.com` active with valid TLS certificates).

## Railway production

- Project: `discerning-recreation` (`9b8234d5-ae2e-4576-b96d-8ae2f53c3b42`)
- Environment: `production` (`528cacfc-99ae-43e4-aa94-dd12241b8e69`)
- API service: `dakyworld` (`251ee1f3-c169-47f8-828a-589dfd5ddc68`) with `SERVICE_ROLE=api`
- Dedicated worker: `worker` (`ad9ebe10-b5d3-4506-aac0-e6ac35c935e1`) with `SERVICE_ROLE=worker`, no public domain
- PostgreSQL: `Postgres` (`9c52b82d-b813-4432-ba89-88969d3c1ad2`)
- Redis: private `redis` service (`1b3eb748-be14-40f9-8f37-dd18780a8dd2`)
- Region: `us-west2`
- Production domains registered on API service:
  - `os.dakyx.com` (Active, valid TLS, 200 OK)
  - `editor.dakyx.com` (Attached in Railway; CNAME target: `pf5fc5xw.up.railway.app`)
  - `app.dakyx.com` (Attached in Railway; CNAME target: `0kg4s78c.up.railway.app`)
  - `os.dakyx.com` (Legacy domain)
- Object storage: Cloudflare R2
- Staging environment: `staging` (`b8a2bf9e-c93e-4e39-a11a-0e6a81cf1ed8`) with isolated services

Production PostgreSQL uses a persistent 5 GB volume. Connection uses private Railway networking. Secret values are intentionally omitted.

A readable PostgreSQL backup was verified at `/var/lib/postgresql/data/dakyx-pre-migration-20261004.dump` on the production Postgres volume (320,944,680 bytes).

## Multi-Product Surface Routing & Isolation

- Direct native architecture on `dakyx.com` with no redirects required.
- Dynamic per-request surface detection implemented:
  - `editor.dakyx.com` / `APP_SURFACE=editor`: Isolated Website Editor; denies access to internal OS APIs (leads, invoices, proposals, staff tools).
  - `app.dakyx.com` / `APP_SURFACE=app`: Customer Workspace & Multi-Product Launcher (Website Editor, Automations, Analytics); denies access to internal OS APIs.
  - `os.dakyx.com` / `APP_SURFACE=os`: DakyXTech internal company OS for staff.
- Worker resiliency: Live site fallback enabled in `server/src/services/website/site.ts` to prevent business-context sync failure when GitHub App repository read permissions are restricted.
- IaC in source control: `.railway/railway.ts` and `.railway/README.md`.
