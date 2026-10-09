# Audit fixes and verification

Date: 2026-09-29. Scope: the existing working tree in `repo`. Existing unrelated changes were preserved. The validated source snapshot was deployed to production on September 29; no Git commit or push was made.

## Production deployment

Railway deployment `3cf5e4d7-d065-42fb-9120-ad1155c979ee` serves https://os.dakyx.com. The old deployment was stopped before cutover. All five pending migrations applied successfully, bringing production to 77 applied migrations. The service runs in combined API/worker mode with production authentication and PostgreSQL-backed rate limiting.

Readiness, health, client HTML, owner login, authenticated operations, and rejection of anonymous private API access passed. Hashes of ten critical deployed source modules match this workspace. A readable custom-format PostgreSQL backup was created before migration at `/var/lib/postgresql/data/dakyworld-preaudit-20260929.dump` on the existing Postgres volume (311,867,188 bytes).

The release source and file hashes are preserved in `../audit-release-20260929/RELEASE_MANIFEST.json`. Deployment used that snapshot through the Railway CLI. GitHub `main` was not updated at the time. **Resolved:** these fixes were committed to `main` as `0557e9f`, so later deployments from GitHub carry them; confirmed during the 9 Oct 2026 go-live audit (the two audit migrations are in the tree).

## Changes

- **Payment durability:** Stripe and Hubtel callbacks persist provider identifiers before acknowledging delivery. A retrying worker verifies provider state before settlement. Stripe checks the session, invoice association, amount, currency, and paid status; the invoice transition compares the verified snapshot atomically. Duplicate deliveries cannot duplicate credit. Stripe amount conversion supports currencies with nonstandard minor units. Paystack retains its existing durable path.
- **Asset isolation:** Public assets resolve within one site and require a reference from a published LIVE page. The legacy route is explicitly assigned to one configured site. Draft uploads are not exposed by filename collisions. SVG responses carry restrictive headers.
- **Publication:** Renewable database leases protect page and site ownership across network calls. Only final local writes run in a short transaction, with ownership checked under row locks. External commits are recorded before finalization, and interrupted jobs retain reconciliation status. Recovery runs again after leases expire. Shared draft clearing compares revisions so a new edit survives publication.
- **Bounded work:** Grouped lead reads use bounded concurrency and indexed in-memory lookup. Production rate limits share atomic PostgreSQL counters; development counters have bounded storage and incremental cleanup. Scheduler ticks coalesce rather than overlap.
- **Cache reliability:** Environment loading precedes capacity configuration. Malformed cache entries and failed serialization do not break successful source reads. Invalidation observers no longer write acknowledgement data per event per replica; bounded local tracking, repeated keyset scans, and periodic local expiration handle missed or late commits. Redis/CDN delivery retains its durable retry path.
- **Maintainability:** Page and version publication commands moved out of the HTTP router. Workers call service commands with typed actors and validated input. Shared publication options, page context, ownership, concurrency, and shutdown behavior have dedicated modules. Shutdown stops admission, drains independent work, and disconnects resources with a deadline.
- **Editor loading:** Guide, find/replace, spotlight, command, and section dialogs load on demand and retain their state after first opening. The main editor chunk decreased from 328.67 kB to 292.47 kB (gzip 87.22 kB to 79.20 kB).
- **Regression cleanup:** The agent scope prompt no longer tells an exhausted agent to call an unavailable handoff tool. Existing assertions were updated for extracted publication code, the deliberately separate checkout header, preview-only icon attributes, and the existing HTTPS image-background capability. Unsafe script URLs remain rejected.

## Verification

All tests used a disposable local PostgreSQL 16 database with an empty dotenv file and sanitized environment. Payment/GitHub responses were stubbed; no live provider writes were made.

- All 77 migrations applied successfully, including the two new additive migrations.
- The full regression run passed 134 of 138 check files. After correcting the four failures, all four passed in targeted reruns. Publication recovery also passed its expanded 28 checks. This is not a claim of a second complete suite run.
- All 7 browser check files passed, covering editor interaction, images, responsive UI, drafts, inspector behavior, checkout, and preview interaction.
- Server and checks TypeScript validation passed. The client production build passed.
- New focused checks cover webhook persistence failures, forged callbacks, provider mismatches, retry and duplicate settlement, cross-site asset isolation, bounded concurrency, shared rate limits, stale publication owners, transaction rollback, environment initialization, and cache resilience.

## Deployment requirements

1. Apply `20260928160000_payment_webhook_inbox` and `20260928161000_shared_rate_limits` before starting the new application. Generate the Prisma client as part of the build.
2. Drain old API and worker publishers before switching to the new release. Old advisory-lock writers and new lease-based writers must not publish concurrently during rollout.
3. Run the background runtime, either in the combined role or a dedicated worker. API-only deployments require that worker to reconcile acknowledged callbacks.
4. Confirm `LEGACY_ASSET_SITE_SLUG` matches the intended site. Other sites must use their scoped hosted asset routes. Production rate limiting uses PostgreSQL regardless of the development toggle.
5. Observe outstanding `PaymentWebhookEvent` retries and `RECONCILIATION_REQUIRED` publish jobs. A repository commit and a database transaction cannot be made atomic; ambiguous external outcomes require reconciliation rather than an automatic retry that could overwrite later work.

## Remaining limits

The largest editor, settings, agent, and catalogue modules still need incremental decomposition. This change establishes service boundaries for the risky publication paths rather than attempting a behavior-changing rewrite of every large module. Some older shared/batch command entry points still accept Express request objects.

No production load benchmark or live payment-provider end-to-end test was performed. The production deployment and smoke checks are recorded above. Bundle measurements are local build results, not measured customer latency. Callback history retention and sustained inbox throughput should be monitored before materially increasing traffic; retries are deliberately retained rather than silently discarded.
