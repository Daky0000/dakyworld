# Visitor location repair: deployment and validation

## Configuration

The application now ignores raw IP and geography headers in analytics. Express resolves the visitor IP. Browser language and timezone never supply geographic values. The pricing lookup module is unchanged.

Set these variables through deployment secrets/configuration, not committed files:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_PROXY_CIDRS` | empty; no trusted proxies | Comma-separated addresses/CIDRs for the verified proxy chain. Do not use `0.0.0.0/0` or `::/0`. |
| `TRUSTED_PROXY_HOPS` | unset | Alternative fixed hop count (1?8), only after verifying every public path has that topology. CIDRs take precedence. |
| `GEOIP_CITY_ENABLED` | false | Enable local GeoLite2 City lookup after staging validation. |
| `GEOIP_CITY_DB_PATH` | unset | Absolute path on the API's persistent volume, e.g. `/data/geo/GeoLite2-City.mmdb`. |
| `GEOIP_AUTO_UPDATE` | false | Run an update immediately when enabled, then once daily inside the API process. |
| `MAXMIND_ACCOUNT_ID` | unset | MaxMind account identifier for database downloads. |
| `MAXMIND_LICENSE_KEY` | unset | MaxMind download credential. Never log this value. |

The official MaxMind reader performs local lookups. No visitor IP is sent to MaxMind. Country fallback uses the existing bundled country data through an analytics-only loader that retries failed loads. Database edition/build date accompanies city records. Confidence percentages are not invented.

## Release procedure

1. Record the deployed commit and every public hostname. Verify direct Railway access, custom domains, and any additional CDN independently. Inspect the connection peer and Express-resolved IP in restricted staging diagnostics; do not publish raw IP logs.
2. Confirm which proxies overwrite or append forwarding headers. Configure only the verified proxy CIDRs. Send forged forwarding and CDN headers through each path and verify the resolved IP cannot be chosen by the client. Without verified proxy configuration, analytics may classify the proxy connection as local. The changed Express setting also affects other consumers of `req.ip`, so smoke-test pricing defaults and authentication/rate limiting.
3. Run `npm run geo:audit` before migration and retain the aggregate-only report. It reads total records and country/city coverage without modifying data. Existing rows will be interpreted as legacy; no historical locations are overwritten.
4. Apply `npm run db:deploy` and deploy the application. The migration only adds nullable columns. API startup scripts that bypass migrations still require the pre-deploy migration step.
5. Provision the database path and MaxMind credentials. Run `npm run geo:update` once on the API host/volume. Confirm the database exists and the command succeeds before enabling city lookup.
6. In staging set `GEOIP_CITY_ENABLED=true` and `GEOIP_AUTO_UPDATE=true`. Each API instance needs access to its own maintained database file. Do not assume Railway volumes can be mounted by multiple services. An external daily scheduler can instead run `npm run geo:update` on the API host; leave auto-update off in that case.
7. Test fixed and mobile networks, including Ghana, and a VPN. Record expected country/city, reported result, provider radius, database version, and source. Report observed results without treating VPN exit location as physical-device location.
8. Enable in production only after the request paths and staging sample pass. No production deployment or credentials were supplied as part of local implementation.

## Monitoring and recovery

The API emits hourly `[geo] health` records with lookup/fallback/load failure counters and database age. No visitor IPs or credentials are included. A missing database or a build older than seven days emits an alert. The updater persists consecutive failures beside the database and emits `alert: true` after two failed runs. Connect these events to the deployment's log alert system.

Updates use a sibling temporary directory and lock, validate the database edition/build, reject downgrades, and rename the validated file atomically. The reader only swaps after a successful full load. Failed downloads or corrupt files retain the last valid in-memory reader. After a killed update, inspect and remove only the stale `<database>.update-lock` directory before retrying.

Set `GEOIP_CITY_ENABLED=false` to roll back city lookup. Country fallback and truthful unknown/legacy labels remain active. Keep the additive columns and corrected proxy handling. No historical reprocessing is performed.

## Validation commands

From `server`: `npx tsx checks/demoAnalytics.ts`, `npx tsx checks/geoLocation.ts`, `npx tsx checks/geoRoutes.ts`, `npm run checks:types`, and `npm run checks:browser`. From `server/client`: `npx tsc --noEmit` and `npm run build`.

Local checks cannot establish real-world city accuracy or verify the production proxy topology. Live credentialed downloads, migration against deployment data, and the known-network sample remain rollout requirements.

References: [Express proxy trust](https://expressjs.com/en/guide/behind-proxies/), [MaxMind GeoLite](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/), [MaxMind updates](https://dev.maxmind.com/geoip/updating-databases/).

## Local verification completed

- 126 existing analytics checks pass after replacing unsafe location expectations with deterministic fixtures.
- Provider, serialization, coverage, real HTTP proxy-chain, and update/reload failure checks pass.
- Route integration checks pass for visit snapshots, reloads, beacon immutability, legacy exclusion, and CSV agreement. Database delegates are test doubles; no deployment database was used.
- The analytics browser check passes for approximate, legacy, region, and coverage labels.
- Server/check TypeScript validation, client TypeScript validation, and the client production build pass.
- MaxMind's synthetic test database verifies the actual reader and atomic file replacement. Credentialed production downloads and real-world accuracy remain unverified.

## Production proxy verification ? September 29, 2026

The only configured public domain is `os.dakyx.com`, pointing directly to Railway. The Railway DNS alias returns 404 when requested as a separate host. Synthetic readiness requests showed a private Railway socket peer, followed by a public CDN proxy in `X-Forwarded-For`. Both normal requests and requests with forged forwarding/CDN headers produced two forwarded addresses. The first address matched the probe host's independently measured public egress IP; the second was the CDN proxy. HTTPS detection remained true. Temporary observers and the local-only debugger were removed after the probes.

This production topology requires `TRUSTED_PROXY_HOPS=2`, rather than the previous value of 1. Revalidate before adding a CDN, public service domain, or alternate route. The pre-migration read-only audit found 10 visits, 10 country values, and 0 cities. MaxMind credentials are absent; deploy with `GEOIP_CITY_ENABLED=false` until they are provisioned.

The MaxMind Node reader requires Node 22 or newer. Production Nixpacks now selects Node 22; the package engine requirement makes that dependency explicit.
