/**
 * Finding a site's pages when nobody said where they are.
 *
 * The defect this was written against: a repository was connected, the scan
 * listed exactly one folder — the configured one, which was the root — found no
 * `.html` in it, and reported "Found 0 pages. Nothing new." The pages were in
 * `public/` the whole time, and nothing in that sentence gave anybody a reason
 * to look there.
 *
 * So the assertions are about the three things that sentence got wrong:
 *
 *  - an empty configured folder is a reason to search, not a result;
 *  - the folder found has to be saved, because a publish commits to `repoPath`
 *    and would otherwise write a page back to the folder it was not read from;
 *  - a repository with no HTML anywhere fails with the reason, rather than
 *    succeeding with nothing.
 *
 * No network and no database: the GitHub wire is stubbed here, and the site is
 * a plain object with no installation, which is the one shape that never asks
 * the database for a credential.
 */
import assert from "node:assert/strict";
import type { Site } from "@prisma/client";
import { discoverPages, WebsiteError } from "../src/services/website/site.js";

process.env.GITHUB_TOKEN = "discovery-check-stub";
process.env.GITHUB_ALLOWED_REPOS = "fixture/site";

let tree: string[] = [];
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

  // The sitemap, fetched off the live site before anything else. Absent here,
  // which is the case that makes every discovered page arrive hidden.
  if (url.origin !== "https://api.github.com") return json({ message: "no sitemap" }, 404);

  asked.push(`${url.pathname}${url.search}`);
  if (url.pathname.endsWith("/git/trees/main")) {
    assert.equal(url.searchParams.get("recursive"), "1");
    return json({ tree: tree.map((path) => ({ path, type: "blob" })), truncated: false });
  }
  if (url.pathname.includes("/contents/")) {
    const folder = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
    const inside = tree.filter((path) => (folder ? path.startsWith(`${folder}/`) : true));
    return json(inside.map((path) => ({ path, type: "blob", size: 1 })));
  }
  throw new Error(`Unexpected GitHub request ${url.pathname}`);
}) as typeof fetch;

const site = (over: Partial<Site> = {}) =>
  ({
    id: "site-1",
    name: "Fixture",
    publicUrl: "https://fixture.example",
    repoOwner: "fixture",
    repoName: "site",
    repoBranch: "main",
    repoPath: "",
    githubInstallationId: null,
    ...over,
  }) as Site;

// 1. The pages are in `public/`, the site's folder is the root, and the scan
//    still finds them — and says so by returning the folder it used.
tree = ["README.md", "package.json", "public/index.html", "public/about.html", "public/assets/app.css"];
let found = await discoverPages(site());
// Ordered by the path the public sees, so home comes first.
assert.deepEqual(found.pages.map((page) => page.filePath), ["index.html", "about.html"]);
assert.deepEqual(found.pages.map((page) => page.path), ["/", "/about"]);
assert.equal(found.repoPath, "public");
// No sitemap, so nothing is listed and every page arrives hidden.
assert.equal(found.pages.every((page) => page.listed === false), true);

// 2. A folder full of old copies does not beat the real one, even holding more
//    files — this is the `website-drafts/` shape that already exists.
tree = ["website-drafts/a.html", "website-drafts/b.html", "website-drafts/c.html", "website-drafts/d.html", "site/index.html", "site/pricing.html"];
found = await discoverPages(site());
assert.equal(found.repoPath, "site");

// 3. A configured folder that has pages is used as-is, and nothing searches.
tree = ["docs/index.html", "public/index.html"];
asked.length = 0;
found = await discoverPages(site({ repoPath: "docs" }));
assert.equal(found.repoPath, "docs");
assert.equal(asked.some((path) => path.includes("git/trees")), false, "a folder that answered should not trigger a repository-wide search");

// 4. A framework repository has no HTML in it and never will until it is built.
//    Its pages are its route files, so they are what gets listed — and which
//    framework it is gets returned, because the scan is the only thing that has
//    looked and every screen after it has to know.
tree = ["astro.config.mjs", "package.json", "src/pages/index.astro", "src/pages/pricing.astro", "src/components/Card.astro"];
found = await discoverPages(site());
assert.deepEqual(found.pages.map((page) => page.path), ["/", "/pricing"]);
assert.deepEqual(found.pages.map((page) => page.filePath), ["src/pages/index.astro", "src/pages/pricing.astro"]);
assert.equal(found.sourceKind, "astro");
// Addressed from the repository root, not from a page folder: a publish writes
// to `filePath`, and a route file relative to some chosen folder lands nowhere.
assert.equal(found.repoPath, "");

// 5. A Next project, with the HTML-folder search never getting a look in — its
//    `app/` has no `.html` for that search to have found anyway.
tree = ["next.config.mjs", "app/page.tsx", "app/(marketing)/pricing/page.tsx", "app/layout.tsx", "app/api/lead/route.ts"];
found = await discoverPages(site());
assert.deepEqual(found.pages.map((page) => page.path), ["/", "/pricing"]);
assert.equal(found.sourceKind, "next");

// 6. A plain static site is still plain: nothing claims it, and the framework
//    branch leaves its folder search exactly as it was.
tree = ["public/index.html", "public/about.html"];
found = await discoverPages(site());
assert.equal(found.sourceKind, null);
assert.equal(found.repoPath, "public");

// 7. A repository that is neither — no HTML, no framework — still fails with
//    the reason rather than succeeding with an empty page list.
tree = ["README.md", "src/lib/util.ts"];
await assert.rejects(
  discoverPages(site()),
  (error: unknown) => error instanceof WebsiteError && error.status === 422 && /no HTML pages/.test(error.message),
);

console.log("websiteDiscovery: ok");
