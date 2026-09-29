import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
const base = new URL(process.env.LOAD_BASE_URL ?? "http://127.0.0.1:4009");
assert.ok(["127.0.0.1", "localhost"].includes(base.hostname), "This runner only targets an isolated local server");
const users = JSON.parse(await readFile(new URL("../tmp/capacity-load-users.json", import.meta.url), "utf8"));
const rate = Number(process.env.LOAD_RPS ?? 50);
const seconds = Number(process.env.LOAD_SECONDS ?? 3600);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 250);
assert.ok(rate > 0 && rate <= 1000 && seconds > 0 && concurrency > 0 && concurrency <= 5000);
const population = Math.min(users.length, Number(process.env.LOAD_ACTIVE_USERS ?? 250));
const mode = process.env.LOAD_MODE ?? "reads";
const before = await fetch(new URL("/metrics", base)).then(response => response.json());
const latencies = []; let unexpected = 0; let rejected = 0; let conflicts = 0; let dropped = 0; let active = 0;
const codes = {}; const started = performance.now(); const running = new Set();
async function request(i) {
  const user = users[i % population];
  const begin = performance.now(); active++;
  const headers = { Cookie: `dw_session=${user.token}`, "Content-Type": "application/json" };
  try {
    let path = `/api/website/sites/${user.siteId}/pages`; let method = "GET"; let body;
    if (mode === "cold") headers["X-DW-Cache-Bypass"] = "1";
    if (mode === "edit" && i % 5 === 0) {
      const page = await fetch(new URL(`/api/website/pages/${user.pageId}`, base), { headers, signal: AbortSignal.timeout(15_000) }).then(r => r.json());
      path = `/api/website/pages/${user.pageId}/draft`; method = "PUT";
      const heading = (page.sections ?? []).flatMap(section => section.fields ?? []).find(field => field.kind === "text" && field.tag === "h1");
      if (!heading) throw new Error("Fixture heading was not editable");
      body = JSON.stringify({ ifRevision: page.draft.revision, documentHash: page.draft.documentHash ?? null, sharedRevisions: {}, values: { [heading.id]: { value: `Saved load edit ${i}` } } });
    } else if (mode === "ai" && i % 10 === 0) {
      path = `/api/website/pages/${user.pageId}/assistant`; method = "POST";
      headers["Idempotency-Key"] = crypto.randomUUID(); body = JSON.stringify({ prompt: "Improve this heading", values: {} });
    }
    const response = await fetch(new URL(path, base), { method, headers, body, signal: AbortSignal.timeout(15_000) });
    codes[response.status] = (codes[response.status] ?? 0) + 1;
    if (response.status === 429 || (response.status === 503 && response.headers.has("Retry-After"))) rejected++;
    else if (response.status === 409) conflicts++;
    else if (!response.ok) unexpected++;
    await response.arrayBuffer();
  } catch { unexpected++; }
  finally { latencies.push(performance.now() - begin); active--; }
}
for (let i = 0; i < rate * seconds; i++) {
  const delay = started + i * 1000 / rate - performance.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  if (active >= concurrency) { dropped++; continue; }
  const work = request(i).finally(() => running.delete(work)); running.add(work);
}
await Promise.allSettled(running);
latencies.sort((a, b) => a - b);
const after = await fetch(new URL("/metrics", base)).then(response => response.json());
const report = { mode, requestedRps: rate, seconds, concurrency, requests: latencies.length, dropped, unexpected, rejected, conflicts, codes,
  p50Ms: latencies[Math.floor(latencies.length * 0.5)], p95Ms: latencies[Math.floor(latencies.length * 0.95)], p99Ms: latencies[Math.floor(latencies.length * 0.99)],
  databaseQueries: after.database.queries - before.database.queries, cache: Object.fromEntries(Object.entries(after.cache).map(([key, value]) => [key, value - (before.cache[key] ?? 0)])),
  memoryBefore: before.memory, memoryAfter: after.memory, jobs: after.jobs, mockCalls: after.mockCalls === undefined ? undefined : after.mockCalls - before.mockCalls,
  actualSeconds: (performance.now() - started) / 1000 };
await writeFile(new URL(`../tmp/capacity-load-${mode}-${Date.now()}.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (unexpected / Math.max(1, latencies.length) >= 0.01 || dropped) process.exitCode = 1;
