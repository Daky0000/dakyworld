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
import { execFileSync } from "node:child_process";
import { discoverPages, nestedPages, pageDocumentUrl, pathFromFile, readSitemap, titleFromFile, WebsiteError } from "../src/services/website/site.js";

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

// 8. A sitemap index is followed to its sitemaps. dakyx.com publishes one —
//    `page-sitemap.xml` and `post-sitemap.xml` — and it was read as listing two
//    pages with those names, so every real page arrived hidden.
const xml = {
  index: (...locs: string[]) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("")}</sitemapindex>`,
  urls: (...locs: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`,
};
const served: Record<string, string> = {
  "https://fixture.example/sitemap.xml": xml.index("https://fixture.example/page-sitemap.xml", "https://www.fixture.example/post-sitemap.xml", "https://elsewhere.example/sitemap.xml", "https://fixture.example/nested-index.xml"),
  "https://fixture.example/page-sitemap.xml": xml.urls("https://fixture.example/", "https://fixture.example/about", "https://fixture.example/team/", "https://fixture.example/old.html"),
  "https://www.fixture.example/post-sitemap.xml": xml.urls("https://fixture.example/blog/a-faster-website", "https://fixture.example/blog/index.html", "not a url"),
  "https://fixture.example/nested-index.xml": xml.index("https://fixture.example/deeper.xml"),
  "https://elsewhere.example/sitemap.xml": xml.urls("https://elsewhere.example/secret"),
};
const fetched: string[] = [];
const fetchText = async (url: string) => { fetched.push(url); if (!(url in served)) throw new Error("404"); return served[url]!; };
const listed = await readSitemap("https://fixture.example", fetchText);
assert.deepEqual([...listed].sort(), ["/", "/about", "/blog", "/blog/a-faster-website", "/old", "/team"]);
assert.equal(fetched.includes("https://elsewhere.example/sitemap.xml"), false, "a sitemap on another host is not followed");
assert.equal(fetched.includes("https://fixture.example/deeper.xml"), false, "an index inside an index is not followed");
assert.deepEqual([...(await readSitemap("https://fixture.example", async () => xml.urls("https://fixture.example/pricing/")))], ["/pricing"]);
assert.equal((await readSitemap("https://fixture.example", async () => { throw new Error("no sitemap"); })).size, 0);

// 9. Pages in folders, when the site's own sitemap names them — against this
//    repository's real files, where the nine blog posts were invisible to the
//    editor and `website-drafts/`, `server/` and `scripts/` must stay out.
const repoFiles = execFileSync("git", ["ls-files"], { cwd: "..", encoding: "utf8" }).split("\n").filter(Boolean);
const posts = repoFiles.filter((file) => /^blog\/[^/]+\.html$/.test(file));
assert.ok(posts.length >= 5, "the repository's blog posts are where this check expects them");
// The sitemap is what decides: dakyx.com's lists its posts and never `server/`
// or `scripts/`, which `_config.yml` keeps off the site. An archive folder is
// refused even if a careless sitemap names it, as is tooling.
const dakyxListed = new Set(["/", "/about", ...posts.map((file) => pathFromFile(file)), "/website-drafts/index-v2"]);
const nested = nestedPages(repoFiles, "", dakyxListed, new Set(["/", "/about"]));
assert.deepEqual(nested.map((page) => page.filePath).sort(), [...posts].sort());
assert.deepEqual(nestedPages(["node_modules/pkg/index.html", ".github/x.html", "_includes/nav.html", "drafts/old.html"], "", new Set(["/node_modules/pkg", "/.github/x", "/_includes/nav", "/drafts/old"]), new Set()), [], "tooling, hidden, partial and archive folders are never pages");
assert.equal(nested.every((page) => page.listed), true);
assert.deepEqual(nestedPages(repoFiles, "", new Set(["/"]), new Set(["/"])), [], "nothing in a folder is listed without the sitemap naming it");
// A folder's index is the folder's address, as a package import names it.
assert.equal(pathFromFile("team/index.html"), "/team");
assert.equal(pathFromFile("blog/a-faster-website.html"), "/blog/a-faster-website");
assert.equal(pathFromFile("index.html"), "/");
assert.equal(titleFromFile("blog/a-faster-website.html"), "A faster website");
assert.equal(titleFromFile("team/index.html"), "Team");
assert.deepEqual(nestedPages(["team/index.html", "team/photo.jpg"], "", new Set(["/team"]), new Set()).map((page) => page.path), ["/team"]);
// …and its relative pictures are resolved from the folder, not the root.
assert.equal(pageDocumentUrl({ publicUrl: "https://fixture.example" }, { path: "/team", filePath: "team/index.html" }), "https://fixture.example/team/");
assert.equal(pageDocumentUrl({ publicUrl: "https://fixture.example" }, { path: "/blog/a-faster-website", filePath: "blog/a-faster-website.html" }), "https://fixture.example/blog/a-faster-website");
assert.equal(pageDocumentUrl({ publicUrl: "https://fixture.example" }, { path: "/", filePath: "index.html" }), "https://fixture.example/");

console.log("websiteDiscovery: ok");
