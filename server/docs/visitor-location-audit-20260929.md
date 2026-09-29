# Visitor location and demo analytics audit

Date: 2026-09-29
Scope: Local source at commit `0557e9f`, public demo links, location resolution, tracking, and analytics dashboard. Production behavior and proxy configuration were not verified. No application code was changed.

## Findings, ordered by priority

1. **High: City labels can be invented or contradict the country.** `src/lib/demoGeo.ts`, `resolveIpLocation`, uses a timezone city and then the GeoIP country's capital as the visitor city. Timezone cities are not measured locations. The timezone city is accepted even when its country differs from the IP country. `DemoAnalyticsModal.tsx:429` labels these as detected cities. Keep city null without a trusted city lookup; show “City unavailable.” Store source and confidence separately. Treat browser timezone and language as preferences, not reliable physical location. Existing guessed cities need an explicit legacy/unverified classification because their source was not stored.

2. **High: Client-controlled headers override Express's resolved IP.** `src/lib/demoGeo.ts`, `extractClientIp` and `extractGeoHints`, accept multiple proxy and location headers without checking which proxy supplied them. `index.ts:103` configures Express proxy trust, but the helper bypasses its result. Exploitability depends on which headers the production edge strips. Use the configured trusted proxy chain and accept geographic headers only from a verified edge. Add spoofed-header checks and IP syntax validation.

3. **High: Reloads split page views from engagement.** `routes/demos.ts:1420` creates a new session ID and visit on each GET. `services/demoTracker.ts` reuses an older ID from sessionStorage. After reload, engagement updates the old visit while the new visit remains empty, skewing bounce and visitor metrics. Separate visit ID, session ID, and optional anonymous visitor ID. Send engagement to the current server-issued visit ID. Add reload and concurrent-beacon integration checks.

4. **High: Public beacons can create visits without a page view.** `routes/demos.ts:1263` accepts arbitrary session IDs and creates missing visits. It does not repeat the page's password check or require a server-issued tracking token. Add a signed, expiring visit token scoped to the demo; reject unissued visits, enforce access rules, and rate-limit ingestion. Use atomic writes and event IDs to avoid duplicate or lost updates under concurrency.

5. **High: Dashboard metrics mix different populations and fabricate defaults.** `routes/demos.ts:437` caps the main analysis at 200 visits while reporting lifetime views. Unique visitors are estimated using the maximum of session and IP counts. `analytics-pro` caps visits at 100, substitutes that length for total views, and defaults scroll depth to 85% when observations are missing. This can generate a high-engagement insight without measured scrolling. Aggregate over a selected date range in the database, paginate only detail rows, and display missing measurements as unavailable. Define sessions and visitors consistently; do not identify people by IP.

6. **Medium: Delivery failures silently lose clicks.** `services/demoTracker.ts`, `flush`, clears the queue before delivery, ignores HTTP failures, and ignores a false return from sendBeacon. Retain pending events until acknowledged, retry with a bounded queue, and deduplicate by event ID. Batch writes so every active tab does not require a read and update every six seconds.

7. **Medium: Bots and local traffic affect customer engagement.** User-agent parsing identifies bots, but visit creation and summary aggregation do not exclude them. Add explicit bot, internal, and local traffic filters, with human traffic as the default. Link-preview requests should not imply a person opened the proposal.

8. **Medium: Click text can include sensitive content.** The click handler reads element text, a value attribute, and parent text. Exclude inputs, textareas, editable elements, and marked private containers; collect stable event names for important actions. Mask IP addresses in ordinary dashboard views and define a retention period for raw events.

## Recommended delivery order

- First: truthful location labels, removal of invented engagement defaults, trusted IP handling, and visit/session alignment.
- Second: authenticated visit beacons, atomic ingestion, retries, bot filters, and consistent date-range aggregates.
- Third: country/city filters, source badges, unknown-location coverage, returning-session trends, and CSV export using the same date range.
- Fourth: conversion events for contact, WhatsApp, booking, and checkout, plus campaign attribution. Show conversions beside visit counts so traffic becomes useful for business decisions.

## Validation

Ran `node_modules/.bin/tsx.cmd checks/demoAnalytics.ts`: all 95 checks passed. These are helper and generated-script checks, not production or browser integration verification. One existing assertion explicitly expects Ghana's capital as the visitor city, so passing tests currently preserve the misleading fallback. Add tests for unknown city, conflicting timezone/country, spoofed headers, reloads, concurrent beacons, failed delivery, more than 200 visits, and missing engagement measurements.
