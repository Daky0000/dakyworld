/**
 * Publishing a framework page across every file it is made of.
 *
 * A page's heading is in a component and its cards are in a data module, so a
 * single publish routinely touches several files. Doing that as several commits
 * would leave a history saying the heading changed at 14:02 and the cards at
 * 14:03, with a build in between showing a page that never existed.
 *
 * So what is pinned here is "one commit, or none":
 *
 *  - two files changed in one publish arrive in one commit;
 *  - every file is guarded against the bytes it was reviewed at, so a developer
 *    editing the same component loses nothing;
 *  - a refusal anywhere commits nothing at all, and names the part;
 *  - a draft prepared against a different set of files is refused rather than
 *    written into whichever ids happen to still collide;
 *  - the rendered HTML is never committed.
 */
import assert from "node:assert/strict";
import type { Site, SitePage } from "@prisma/client";
import { buildSourceManifest } from "../src/services/website/manifest.js";
import { discoverPageFields, matchPageToHtml } from "../src/services/website/pageFields.js";
import { frameworkChangeSet, publishFrameworkPage } from "../src/services/websiteFrameworkPublish.js";
import { WebsiteError } from "../src/services/website/site.js";

let passed = 0;

const site = { id: "site-1", repoOwner: "dakyworld", repoName: "customer", repoBranch: "main", repoPath: "", publicUrl: "https://customer.example", name: "Customer" } as unknown as Site;
const page = { id: "page-1", title: "Home", path: "/", filePath: "app/page.tsx" } as unknown as SitePage;

const project: Record<string, string> = {
  "app/page.tsx": [
    'import { Hero } from "../components/Hero";',
    'import { Cards } from "../components/Cards";',
    "export default function Home() { return (<main><Hero /><Cards /></main>); }",
  ].join("\n"),
  "components/Hero.tsx": 'export function Hero() { return <h1>Websites that work</h1>; }',
  "components/Cards.tsx": [
    'import { cards } from "../data/cards";',
    "export function Cards() { return (<div>{cards.map((card) => (<article key={card.title}><h3>{card.title}</h3></article>))}</div>); }",
  ].join("\n"),
  "data/cards.ts": 'export const cards = [{ title: "Fast to build" }, { title: "Yours to keep" }];',
};

const html = [
  "<!doctype html><html><head><title>Home</title></head><body><main>",
  "<h1>Websites that work</h1>",
  "<div><article><h3>Fast to build</h3></article><article><h3>Yours to keep</h3></article></div>",
  "</main></body></html>",
].join("");

async function context(files: Record<string, string> = project) {
  const read = async (path: string) => files[path] ?? null;
  const manifest = await buildSourceManifest({ entry: page.filePath, files: Object.keys(files), read });
  const discovery = await discoverPageFields({ manifest, read });
  return { manifest, discovery, read, repoPathFor: (path: string) => path };
}

const base = await context();
const view = matchPageToHtml({ discovery: base.discovery, html });
const target = (value: string) => view.mappings.find((mapping) => {
  const field = base.discovery.fields.find((entry) => entry.id === mapping.sourceFieldId);
  return field?.value === value && mapping.property === "value";
})!;

const headingTarget = target("Websites that work");
const cardTarget = target("Fast to build");
assert.ok(headingTarget, "the heading in the component is a publishable target"); passed++;
assert.ok(cardTarget, "the card in the data file is a publishable target"); passed++;

type Commit = { repo: string; branch: string; message: string; files: Array<{ path: string; content: string }>; expectedFiles?: Array<{ path: string; content: string }> };
function recorder() {
  const calls: Commit[] = [];
  const commit = async (input: Commit) => { calls.push(input); return { sha: "abc123", url: "https://github.com/dakyworld/customer/commit/abc123" }; };
  return { calls, commit: commit as never };
}

// ── Two files, one commit ───────────────────────────────────────────────────
{
  const { calls, commit } = recorder();
  const result = await publishFrameworkPage(
    {
      site, page, html, author: "Ama", changed: 2,
      values: { [headingTarget.htmlFieldId]: { value: "Websites that convert" }, [cardTarget.htmlFieldId]: { value: "Quick to build" } },
    },
    { manifest: async () => base, commit },
  );
  assert.equal(calls.length, 1, "two files changed arrive as exactly one commit"); passed++;
  const written = calls[0]!;
  assert.equal(written.files.length, 2, "and the commit carries both files"); passed++;
  const paths = written.files.map((file) => file.path).sort();
  assert.deepEqual(paths, ["components/Hero.tsx", "data/cards.ts"], "the component and the data file, not the route file"); passed++;
  assert.ok(!paths.some((path) => path.endsWith(".html")), "the rendered HTML is never committed"); passed++;
  assert.deepEqual(result.files.sort(), paths, "the result names every file it wrote"); passed++;
  assert.equal(result.sha, "abc123", "and the commit it wrote them in"); passed++;

  const hero = written.files.find((file) => file.path === "components/Hero.tsx")!;
  assert.ok(hero.content.includes("Websites that convert"), "the component holds the new heading"); passed++;
  const cards = written.files.find((file) => file.path === "data/cards.ts")!;
  assert.ok(cards.content.includes("Quick to build"), "the data file holds the new card"); passed++;
  assert.ok(cards.content.includes("Yours to keep"), "and the untouched card is still there"); passed++;

  // ── Each file guarded against the bytes it was reviewed at ────────────────
  assert.equal(written.expectedFiles?.length, 2, "both files are guarded"); passed++;
  const guard = written.expectedFiles!.find((file) => file.path === "components/Hero.tsx")!;
  assert.equal(guard.content, project["components/Hero.tsx"], "the guard is the exact bytes the edit was computed against"); passed++;
  assert.ok(written.message.includes("components/Hero.tsx"), "the commit message names the files for anybody reading the history"); passed++;
  assert.ok(written.message.includes("Ama"), "and who published"); passed++;
}

// ── One file only, when only one changed ────────────────────────────────────
{
  const { calls, commit } = recorder();
  await publishFrameworkPage(
    { site, page, html, author: "Ama", changed: 1, values: { [headingTarget.htmlFieldId]: { value: "Only this" } } },
    { manifest: async () => base, commit },
  );
  assert.equal(calls[0]!.files.length, 1, "one change writes one file"); passed++;
  assert.equal(calls[0]!.files[0]!.path, "components/Hero.tsx", "the right one"); passed++;
  assert.ok(!calls[0]!.message.includes("Files:"), "and the message stays short when there is only one"); passed++;
}

// ── A refusal commits nothing ───────────────────────────────────────────────
{
  const { calls, commit } = recorder();
  await assert.rejects(
    () => publishFrameworkPage(
      { site, page, html, author: "Ama", changed: 2, values: { [headingTarget.htmlFieldId]: { value: "Fine" }, [cardTarget.htmlFieldId]: { newTab: true } } },
      { manifest: async () => base, commit },
    ),
    (error: unknown) => error instanceof WebsiteError && error.status === 400,
    "a change with nowhere to go is refused",
  ); passed++;
  assert.equal(calls.length, 0, "and nothing at all is committed, including the part that would have worked"); passed++;
}

// ── A draft prepared against different files is refused ─────────────────────
{
  const { calls, commit } = recorder();
  await assert.rejects(
    () => publishFrameworkPage(
      { site, page, html, author: "Ama", changed: 1, manifestHash: "a-hash-from-an-hour-ago", values: { [headingTarget.htmlFieldId]: { value: "Fine" } } },
      { manifest: async () => base, commit },
    ),
    (error: unknown) => error instanceof WebsiteError && error.status === 409 && /have changed since/.test(error.message),
    "a draft whose page is now built from different files is refused",
  ); passed++;
  assert.equal(calls.length, 0, "and commits nothing"); passed++;

  // The matching hash is accepted, so the guard is not simply refusing everyone.
  const ok = await publishFrameworkPage(
    { site, page, html, author: "Ama", changed: 1, manifestHash: base.discovery.manifestHash, values: { [headingTarget.htmlFieldId]: { value: "Fine" } } },
    { manifest: async () => base, commit },
  );
  assert.equal(ok.sha, "abc123", "the hash the draft was prepared against is accepted"); passed++;
}

// ── A file that moved under the draft ───────────────────────────────────────
{
  const { calls, commit } = recorder();
  const moved = await context({ ...project, "components/Hero.tsx": 'export function Hero() { return <h1>Something else</h1>; }' });
  await assert.rejects(
    () => publishFrameworkPage(
      { site, page, html, author: "Ama", changed: 1, values: { [headingTarget.htmlFieldId]: { value: "Fine" } } },
      // The manifest is rebuilt at publish time, as it is in production: the
      // draft's field ids no longer name anything in the moved file.
      { manifest: async () => moved, commit },
    ),
    (error: unknown) => error instanceof WebsiteError,
    "a component edited by a developer meanwhile refuses the publish",
  ); passed++;
  assert.equal(calls.length, 0, "and commits nothing"); passed++;
}

// ── Nothing to do is said, not committed ────────────────────────────────────
{
  const { calls, commit } = recorder();
  await assert.rejects(
    () => publishFrameworkPage(
      { site, page, html, author: "Ama", changed: 1, values: { [headingTarget.htmlFieldId]: { value: "Websites that work" } } },
      { manifest: async () => base, commit },
    ),
    (error: unknown) => error instanceof WebsiteError && error.status === 400,
    "republishing the value that is already there is refused rather than committed as an empty change",
  ); passed++;
  assert.equal(calls.length, 0, "and makes no commit"); passed++;
}

// ── Marker discipline, when a site asks for it ──────────────────────────────
{
  await assert.rejects(
    () => frameworkChangeSet(
      { site, page, html, author: "Ama", changed: 1, requireMarker: true, values: { [headingTarget.htmlFieldId]: { value: "Fine" } } },
      { manifest: async () => base },
    ),
    (error: unknown) => error instanceof WebsiteError,
    "an integrated site refuses an unmarked literal",
  ); passed++;
  const loose = await frameworkChangeSet(
    { site, page, html, author: "Ama", changed: 1, values: { [headingTarget.htmlFieldId]: { value: "Fine" } } },
    { manifest: async () => base },
  );
  assert.equal(loose.writes.length, 1, "and a site that has not been integrated still publishes, as it did before"); passed++;
}

// ── The site's folder prefix reaches the commit ─────────────────────────────
{
  const { calls, commit } = recorder();
  const nested = { ...base, repoPathFor: (path: string) => `apps/web/${path}` };
  await publishFrameworkPage(
    { site, page, html, author: "Ama", changed: 1, values: { [headingTarget.htmlFieldId]: { value: "Nested" } } },
    { manifest: async () => nested, commit },
  );
  assert.equal(calls[0]!.files[0]!.path, "apps/web/components/Hero.tsx", "a site in a folder of a larger repository commits to that folder"); passed++;
  assert.equal(calls[0]!.expectedFiles![0]!.path, "apps/web/components/Hero.tsx", "and its guard names the same path"); passed++;
}

console.log(`websiteFrameworkPublish: ${passed} whole-page publish checks passed`);
