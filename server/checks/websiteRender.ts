/**
 * Where a framework page's HTML comes from, and what it costs to get it.
 *
 * The editor needs HTML. A framework page has none until something builds it,
 * and the three ways to get it are not equally good — an export committed
 * beside the source is this commit; the published page is whatever the host
 * last deployed, which may be a day old. Confusing the two puts somebody's
 * afternoon into a page that has since been rebuilt over.
 *
 * Nothing in this file — and nothing in `renderSource.ts` — runs a customer's
 * project. That is the point of the ordering being tested here: the two
 * strategies that need no execution are tried first, and the one that does is a
 * service the operator has to stand up deliberately.
 */
import assert from "node:assert/strict";
import type { Site, SitePage } from "@prisma/client";
import { prerenderCandidates, renderRoute } from "../src/services/website/index.js";
import { invalidateSource } from "../src/services/website/sourceCache.js";

let passed = 0;
const site = { id: "site-r", repoOwner: "fixture", repoName: "shop", repoPath: "", repoBranch: "main", publicUrl: "https://shop.example" } as Site;
const page = { id: "p1", siteId: "site-r", title: "Pricing", path: "/pricing", filePath: "app/pricing/page.tsx" } as SitePage;
const home = { ...page, id: "p2", path: "/", filePath: "app/page.tsx" } as SitePage;

// ── Which files could hold a route's HTML ───────────────────────────────────
const candidates = prerenderCandidates("/pricing");
assert.ok(candidates.includes("out/pricing/index.html") && candidates.includes("out/pricing.html")); passed++;
// Both spellings, because exporters disagree, and `out/` before `dist/` because
// that is what a Next export writes.
assert.ok(candidates.indexOf("out/pricing/index.html") < candidates.indexOf("dist/pricing/index.html")); passed++;
assert.deepEqual(prerenderCandidates("/").slice(0, 1), ["out/index.html"]); passed++;

// ── The export in the repository wins ───────────────────────────────────────
let asked: string[] = [];
let liveCalls = 0;
let serviceCalls = 0;
const overrides = {
  read: async (_repo: string, path: string) => { asked.push(path); return path === "out/pricing/index.html" ? "<html><body><h1>Built</h1></body></html>" : null; },
  live: async () => { liveCalls += 1; return "<html><body><h1>Published</h1></body></html>"; },
  service: async () => { serviceCalls += 1; return null; },
};
let rendered = await renderRoute(site, page, { fresh: true, overrides });
assert.equal(rendered?.from, "prerendered output"); passed++;
assert.equal(rendered?.detail, "out/pricing/index.html"); passed++;
assert.ok(rendered!.html.includes("Built")); passed++;
// Neither the network nor the service was touched: the answer was already in
// the same commit the source came from.
assert.equal(liveCalls, 0); passed++;
assert.equal(serviceCalls, 0); passed++;

// ── The cache ───────────────────────────────────────────────────────────────
asked = [];
rendered = await renderRoute(site, page, { overrides });
assert.equal(asked.length, 0, "a second open should not re-read the repository"); passed++;
assert.ok(rendered!.html.includes("Built")); passed++;
// `fresh` is not an optimisation switch — the publish path's conflict check has
// to see the file as it is now, not as it was ninety seconds ago.
asked = [];
await renderRoute(site, page, { fresh: true, overrides });
assert.ok(asked.length > 0); passed++;
invalidateSource(site.id);

// ── Falling back, in order ──────────────────────────────────────────────────
serviceCalls = 0;
liveCalls = 0;
const noExport = { ...overrides, read: async () => null };
rendered = await renderRoute(site, home, { fresh: true, overrides: noExport });
// No export anywhere, no service configured, so the published page it is — and
// it says so, because a person editing needs to know they may be looking at
// last night's deploy.
assert.equal(rendered?.from, "live site"); passed++;
assert.equal(serviceCalls, 1, "the service is asked before the live site"); passed++;
assert.equal(liveCalls, 1); passed++;
assert.equal(rendered?.detail, "https://shop.example/"); passed++;
invalidateSource(site.id);

// A configured service answers before the live page is ever fetched.
liveCalls = 0;
rendered = await renderRoute(site, home, {
  fresh: true,
  overrides: { ...noExport, service: async (input) => { assert.equal(input.route, "/"); assert.equal(input.repo, "fixture/shop"); return "<html><body><h1>From the builder</h1></body></html>"; } },
});
assert.equal(rendered?.from, "render service"); passed++;
assert.equal(liveCalls, 0); passed++;
invalidateSource(site.id);

// Nothing anywhere is null rather than an exception: the caller turns it into a
// sentence offering the source editor, which still works without any HTML.
rendered = await renderRoute(site, home, { fresh: true, overrides: { ...noExport, live: async () => { throw new Error("404"); } } });
assert.equal(rendered, null); passed++;

// ── The service is off unless somebody stood one up ─────────────────────────
// The default `service` reads an environment variable and returns null without
// one, so no project is ever executed by accident.
delete process.env.WEBSITE_RENDER_URL;
invalidateSource(site.id);
const untouched = await renderRoute(site, home, { fresh: true, overrides: { read: async () => null, live: async () => "<html><body>live</body></html>" } });
assert.equal(untouched?.from, "live site"); passed++;

console.log(`websiteRender: ${passed} rendered-HTML source and fallback checks passed`);
