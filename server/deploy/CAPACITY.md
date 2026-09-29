# Capacity rollout and operations

This implementation targets 5,000 daily users under measured usage limits. It does not establish that capacity on every Railway plan. Production deployment and the release gates below remain separate work.

## What is implemented

- Redis cache with tenant/user-scoped keys, versioned envelopes, jitter, payload limits, same-process miss coalescing, generation-checked writes, a 100 ms deadline, circuit breaker, and bounded database fallback. Redis is disposable and holds no authoritative jobs, balances, sessions, or reservations.
- Dashboard and website page-list caching after authorization; public HTML and hostname caches; bounded existing source caches. Mutation bypass and transactional PostgreSQL invalidation triggers cover API, worker, and administrative writes. Each process independently clears local source/settings caches. Undelivered events retry durably.
- Session and access relations fetched in one SQL join without credential fields; conditional daily session refresh; authoritative revocation and membership checks.
- Cursor-paginated site/page directories, frontend freshness policies, account-switch cancellation and clearing, hidden-tab polling suppression, queued-job progress and cancellation.
- Separate API/worker entry points, database scheduler ownership, job leases, transactional admission/idempotency/monthly usage reservations, daily quotas, and global model/render/publish limits. Page, shared-content, historical-version, and batch publication, assistant generation, and builder planning can run as durable worker jobs.
- Published ETags computed when HTML changes. Explicit Cloudflare hostname allowlist, durable host purges including old domain assignments, and separate CDN-pending publication status.
- Request/database/cache/memory metrics and operator-supplied cost forecast thresholds.

## Deployment sequence

1. Back up PostgreSQL. Review the three additive migrations `20260927120000_capacity_cache`, `20260927130000_hosted_domain_invalidation`, and `20260928010000_work_usage_reconciliation`. Apply with `npm run db:deploy` before starting this version. Migration backfills published ETags; schedule for low traffic on large databases.
2. Build and test with `npm ci`, `npm run checks:types`, and `npm run build`. Keep all three rollout flags false initially. Existing combined mode remains available during transition.
3. Add private Redis using `redis.conf`. Configure authentication through a Railway secret/start command; never expose a public TCP proxy. Start with 128 MiB maxmemory and approximately 256 MiB service memory. Use `allkeys-lru`, no persistence. Reserve additional memory if measured Redis overhead requires it.
4. Configure the web service with `railway.api.json`, `SERVICE_ROLE=api`, and `DB_POOL_SIZE=10`. Configure the worker with `railway.worker.json`, `SERVICE_ROLE=worker`, and `DB_POOL_SIZE=5`. Both need the same application secret, private PostgreSQL and Redis URLs, provider settings, hosting configuration, and relevant integration secrets. Worker settings are read from the same database.
5. Keep total connection pools below 70% of PostgreSQL's connection allowance, including overlapping deployments. Use Railway private endpoints, not database public proxy URLs. Confirm `/api/ready` and scheduler ownership before enabling admission. Do not leave a legacy scheduler running outside this ownership mechanism.
6. Set `OS_HOSTS` to all application hosts. Set `WEBSITE_HOST_DOMAIN` consistently. Test application login, private routes, published domains, and rejection of unknown hosts.
7. Enable `RESPONSE_CACHE_ENABLED=true` on API and worker in staging, then production after the correctness gates pass. Redis failure must produce normal bounded fallback or intentional rejection, not an unbounded database stampede.
8. Enable `JOB_ADMISSION_ENABLED=true` on both services only after a healthy worker is present. Defaults: model calls 8 globally, AI queue 200, new jobs 2/user/day, one running job/user, two running/site, two queued/user, publishing 2 globally and 1/site. CPU export concurrency is 1. API admission bounds concurrent reads at 50 and writes at 20 before authentication reaches PostgreSQL; overload returns 503 with Retry-After. Review how these limits interact with paid tiers before release; daily admission is an additional limit.
9. Onboard only proxied public customer domains to Cloudflare. Merge the example Cache Rules into existing zone rules; do not replace unrelated rules. Preserve hostname and meaningful query strings in cache keys. Exclude application hosts, APIs, previews, authorization and cookies. Respect origin headers and responses setting cookies; never force-cache errors or private responses.
10. Set `CLOUDFLARE_HOST_ZONES` to a JSON map of exact public hostname to zone ID. Give `CLOUDFLARE_API_TOKEN` cache-purge permission only for those zones. Keep previous host mappings until reassignment purges finish. Enable `EDGE_HTML_CACHE_ENABLED=true` only after testing the rules. Host purges intentionally clear query variants and all pages affected by shared navigation.

Cloudflare HTML caching is opt-in. The implementation uses approximately 5 seconds of hostname caching, 25 seconds of origin HTML caching (with jitter), and 25 seconds of edge freshness. These shorter layers keep combined ordinary staleness below 60 seconds when purge fails; stacking independent 60-second caches would not. Browser HTML revalidates. Unknown/unpublished/error responses are not cached. Invalidation backlog and network failures still require monitoring.

## Monitoring and costs

The owner-only `GET /api/operations/performance` reports process request latency histograms, database query counts/time, cache statistics, memory, CPU, and event-loop delay. Scrape per process externally; counters reset on restart and are not a durable monitoring service. Track queue age and state from `WebsiteWorkJob`, and pending invalidations from `CacheInvalidation`. Alert on growing `RECONCILIATION_REQUIRED`, retry attempts, oldest pending event, rejected admissions, connection waits, and p95 latency.

`RAILWAY_PROJECTED_MONTHLY_USD` is an operator-provided forecast, not an automatic billing integration. Update it from measured usage/billing. Threshold logs occur at $30, $40, and $45. At $40 discretionary refreshes pause and queue allowance tightens; at $45 new queued AI and source scraping are refused. Existing accepted work and editing continue. Configure real Railway billing alerts separately. Provider budgets are separate.

Illustrative cost: 1.75 GB average total RAM at $10/GB-month, 0.40 average vCPU at $20/vCPU-month, and 40 GB egress at $0.05/GB is $27.50 before storage, backups and providers. This is not a benchmark or invoice forecast. Plan subscriptions are minimum usage commitments. A hard spend limit can stop service.

## Failure handling and rollback

- Turn off response/edge caching to bypass cache use. Purge Cloudflare or disable its cache rule as part of edge rollback; changing the origin flag cannot remove responses already at the edge.
- Do not drop migrations, truncate queues, or roll back authoritative data. Keep the worker running until accepted jobs drain. Disabling admission also stops new queue execution in that worker configuration, so drain before changing the flag or retain a worker with admission enabled.
- Interrupted work with a possible external action becomes `RECONCILIATION_REQUIRED`. Network errors and provider 5xx responses do not replay chargeable actions automatically. Safe failures before external execution may retry at most three times with backoff. Known rejected provider calls may retry at most three times; exhausted rejections release the monthly reservation. Daily submission limits still count rejected jobs.
- Usage reservations settle transactionally and once. Completed/executed work records usage and provider cost; failures before external actions release the reservation. Owner-only `GET /api/operations/work-jobs` lists unresolved work. `POST /api/operations/work-jobs/:jobId/reconcile` requires evidence, an `EXECUTED` or `NOT_EXECUTED` outcome, and `FAIL` or `RETRY`. Retry requires verified non-execution, fewer than three attempts, and no cancellation. Recorded charges block contradictory non-execution claims. Decisions are audited; there is no automatic provider lookup or reconciliation UI.
- Cancellation prevents queued execution or result delivery; it cannot undo an external action already in progress. A deployment can terminate an in-flight call. Lease loss stops the process before another owner can take over.
- Delivered outbox events retain 15 minutes of history; completed/failed/cancelled jobs retain 30 days. Unfinished and reconciliation-required records remain. Database backups and long-term audit retention require a separate policy.

## Validation commands

Use an isolated local database only. Load tools reject remote databases/targets and production mode. Never use production sessions or provider keys. The fixture file contains local session tokens and stays in ignored `tmp/`.

```powershell
$env:DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/dakyworld_capacity_load_test?schema=public'
npm run db:deploy
npm run load:fixture
$env:REDIS_URL='redis://127.0.0.1:REDIS_PORT'
$env:RESPONSE_CACHE_ENABLED='true'
$env:JOB_ADMISSION_ENABLED='true'
npm run load:server
# In another terminal:
$env:LOAD_RPS='50'; $env:LOAD_SECONDS='3600'; npm run load:run
$env:LOAD_RPS='100'; $env:LOAD_SECONDS='600'; $env:LOAD_ACTIVE_USERS='500'; npm run load:run
# Repeat with LOAD_MODE=cold, edit, or ai; use separate reports per run.
```

The runner's active-user population is not a simulation of 500 simultaneously open browser editors. Add browser-driven editor sessions, realistic HTML/history sizes, and provider latency measurements before claiming editor capacity. The default fixture page is intentionally small. `cold` bypasses caches; also test a flushed Redis instance and a stopped Redis instance. AI mode measures admission, not completed-job throughput.

Run `npx tsx checks/capacityCache.ts --database --redis` using a loopback database named with `cache_check` or `cache_verify`, plus a local Redis URL. Run `checks/websiteAccess.ts --database` and the existing editor/publish tests. The legacy builder harness needs `DEV_NO_AUTH=true` and `NODE_ENV=development` supplied before import.

## Results and remaining release gates

Local tests on 2026-09-28 used PostgreSQL 16 and Redis 7 with 5,000 separate users/sites/pages. Pages were small fixture documents. Provider failure and outage tests used a separate 20-user database.

| Workload | Duration | Requests | p95 | Unexpected errors | Intentional rejections |
| --- | --- | --- | --- | --- | --- |
| Reads, 50 requests/s, 250-user population | 60 minutes | 180,000 | 31.0 ms | 0 | 50 |
| Reads, 100 requests/s, 500-user population | 10 minutes | 60,000 | 25.2 ms | 0 | 171 |
| Cache bypass, 50 requests/s | 20 seconds | 1,000 | 25.3 ms | 0 | 0 |
| Redis unavailable, 50 requests/s | 20 seconds | 1,000 | 23.9 ms | 0 | 0 |
| Mixed reads/real saves, Redis unavailable, 50 requests/s | 20 seconds | 1,000 | 54.2 ms | 0 | 0 |

No requests were dropped. The burst ran concurrently with the 50 requests/s baseline on shared local PostgreSQL/Redis. Rejections were bounded database fallback responses (503), reported separately. The baseline started before the final authentication SQL-join and job-safety refinements; the burst included the SQL join. These are local workload measurements, not a benchmark of the final Railway deployment. Raw aggregate reports are in `validation-results.json`; no session tokens are included.

The baseline process RSS ended at approximately 313 MiB; burst process RSS ended at approximately 399 MiB. These values exclude PostgreSQL/Redis and do not prove a steady-state memory or cost forecast. The baseline executed 1,200,752 database queries, while the burst executed 214,600; authorization remains authoritative and adds work on every private request. An HTTP dashboard test reduced a repeated read from 13 database queries to 1 (92% fewer). Public HTML and ETag hits required zero database queries when warm.

Cache concurrency/isolation/invalidation/outage tests, PostgreSQL session/quota/idempotency/lease tests, queued page and historical-version publication, 88 website access checks, and 55 builder checks passed. HTTP tests passed tenant isolation, immediate permission/session revocation, domain reassignment, durable purge retries, owner-only reconciliation, and duplicate-refund protection. A provider 500 fixture produced one call then reconciliation; a 429 fixture stopped after three known rejected calls and released its reservation. Killing the local worker during an external request, expiring its lease to accelerate recovery, and restarting produced reconciliation with zero repeated provider calls.

Server type checking, server compilation, isolated Prisma client generation, and client production build passed. The last full-suite run passed 129/133 files; the editor checkpoint failure was subsequently fixed and its check passed. Three existing unrelated check files remain failing: `agentToolBudget`, `marketingSiteShell`, and `websiteVisual`. The full suite is not green. Prisma generation must also run in a clean deployment build; Windows can reject replacement of a query-engine DLL still loaded by another local process.

Before release, complete a multi-hour memory soak, browser editor concurrency tests with representative HTML/history sizes, slow-PostgreSQL tests, real Cloudflare purge/domain reassignment verification, and a small separately budgeted provider sample. Confirm p95 reads <300 ms, edits <500 ms, unexpected errors <1%, memory <75% of service limits, no pool exhaustion, no cross-customer exposure or lost edits, 80% fewer repeated asset origin requests, and measured monthly forecast <$50. Measured AI completion throughput and queue delay remain separate from read/editor performance.

Document exports retain synchronous API paths with database-backed concurrency protection. Automatic provider reconciliation, automated Railway billing ingestion, comprehensive pagination of every internal list, and production capacity certification remain follow-ups. No production deployment has been performed. Keep rollout flags off until remaining gates and product-limit decisions are addressed.

## References

- [Railway resource costs](https://docs.railway.com/guides/right-size-cpu-memory)
- [Railway billing](https://docs.railway.com/pricing/understanding-your-bill)
- [Cloudflare cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
- [Cloudflare purge methods](https://developers.cloudflare.com/cache/how-to/purge-cache/)
- [Hostname purge available on all Cloudflare plans](https://developers.cloudflare.com/changelog/post/2025-04-01-purge-for-all/)
- [Redis eviction](https://redis.io/docs/latest/develop/reference/eviction/)
