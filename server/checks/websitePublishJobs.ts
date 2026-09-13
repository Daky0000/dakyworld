/**
 * A publish, recorded before it starts and watched until it is live.
 *
 *   DATABASE_URL=<isolated local editor database> npx tsx checks/websitePublishJobs.ts
 *
 * The two things this is for are both invisible from inside a request: whether a
 * commit that landed was ever recorded, and whether the live site actually
 * changed. Both need a real row and a real clock, so this uses the database and
 * a fixed responder for GitHub and for the "live" page.
 *
 * **It needs an isolated database and refuses anything else** — it creates and
 * deletes fixture rows, which is not something to do to a production one. The
 * deciding it exercises is also covered without any database at all by
 * `checks/websitePublishVerify.ts`, which is the one to run when there is no
 * throwaway Postgres to hand.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}
process.env.NODE_ENV = "development";
process.env.DEV_NO_AUTH = "true";
process.env.GITHUB_TOKEN = "publish-job-check-stub";
process.env.GITHUB_ALLOWED_REPOS = "fixture/site";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

/* ------------------------------------------------- the world, answered */

/** What the "live site" currently says, and what the repository holds. */
let livePage = "<!doctype html><html><body><h1>The old heading nobody changed</h1></body></html>";
let liveFails: string | null = null;
let repositoryFile: string | null = null;
const { createServer } = await import("node:http");
/**
 * A real server on loopback, not a `globalThis.fetch` stub: `fetchWebsiteText`
 * reaches the live page through `node:http` with its own pinned DNS lookup, so
 * a stubbed `fetch` is never consulted and every verification silently fails to
 * resolve instead of reading the page.
 */
const liveServer = createServer((_request, response) => {
  if (liveFails) { response.destroy(new Error(liveFails)); return; }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(livePage);
});
await new Promise<void>(resolve => liveServer.listen(0, "127.0.0.1", resolve));
const livePort = (liveServer.address() as { port: number }).port;
const liveOrigin = `http://127.0.0.1:${livePort}`;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = new URL(String(input));
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  if (target.origin === "https://api.github.com") {
    if (target.pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: "pinned-head" } });
    if (target.pathname.includes("/contents/")) {
      return repositoryFile === null ? json({ message: "Not found" }, 404) : json({ content: Buffer.from(repositoryFile).toString("base64"), encoding: "base64" });
    }
    throw new Error(`Unexpected GitHub request ${target.pathname}`);
  }
  return originalFetch(input as never, init);
}) as typeof fetch;

const { prisma } = await import("../src/lib/prisma.js");
const { startPublishJob, advancePublishJob, publishJobCommitted, failPublishJob, verifyDuePublishJobs, reconcileInterruptedPublishJobs, verificationText, publishJobView } =
  await import("../src/services/websitePublishJobs.js");

const mark = `publishjob-${randomUUID()}`;
const siteIds: string[] = [];

try {
  const site = await prisma.site.create({
    data: { slug: mark, name: "Fixture", publicUrl: liveOrigin, repoOwner: "fixture", repoName: "site", repoBranch: "main" },
  });
  siteIds.push(site.id);
  const page = await prisma.sitePage.create({ data: { siteId: site.id, title: "Home", path: "/", filePath: "index.html" } });

  /* ------------------------------------------------- what to look for */

  equal(
    "the longest new sentence is what the live page is searched for",
    verificationText([
      { id: "a", label: "Heading", kind: "text", part: "words", from: "Old", to: "Ready to improve your systems?" },
      { id: "b", label: "Button", kind: "button", part: "words", from: "Go", to: "Talk" },
    ]),
    "Ready to improve your systems?",
  );
  equal(
    "a change too short to be distinctive is not used",
    verificationText([{ id: "a", label: "Button", kind: "button", part: "words", from: "Go", to: "Talk" }]),
    null,
  );
  equal("and neither is a styling change, which puts no words on the page", verificationText([{ id: "a", label: "Heading", kind: "text", part: "styling", from: "", to: "colour" }]), null);

  /* --------------------------------------- the row exists before GitHub */

  const html = "<!doctype html><html><body><h1>Ready to improve your systems?</h1></body></html>";
  const job = await startPublishJob({ site, kind: "PAGE", pageId: page.id, detail: { path: "/" } });
  equal("a publish is recorded before anything is committed", job.state, "VALIDATING");

  await advancePublishJob(job.id, "COMMITTING", { detail: { expectedHtmlHash: createHash("sha256").update(html).digest("hex") } });
  await publishJobCommitted({
    id: job.id,
    commit: { sha: "abc123", url: "https://github.com/fixture/site/commit/abc123" },
    site,
    page,
    html,
    summary: [{ id: "a", label: "Heading", kind: "text", part: "words", from: "The old heading nobody changed", to: "Ready to improve your systems?" }],
  });
  let row = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  equal("after the commit it is waiting on the host, not finished", row.state, "DEPLOYING");
  equal("and knows what to look at", row.verifyUrl, `${liveOrigin}/`);
  equal("and what to look for", row.verifyText, "Ready to improve your systems?");

  /* ------------------------------------------- the host has not rebuilt */

  let settled = await verifyDuePublishJobs(new Date(Date.now() + 60_000));
  equal("a live page still showing the old words settles nothing", settled, 0);
  row = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  equal("but it is now actively being watched", row.state, "VERIFYING");
  equal("and has been looked at once", row.attempts, 1);
  check("with another look scheduled", row.nextCheckAt !== null);

  /* --------------------------------------------------- the host rebuilds */

  livePage = html;
  settled = await verifyDuePublishJobs(new Date(Date.now() + 10 * 60_000));
  equal("once the words are on the live page it is settled", settled, 1);
  row = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  equal("and only then is it complete", row.state, "COMPLETED");
  check("with the time the host took", publishJobView(row).deployedInSeconds !== null);
  check("and nothing left to check", row.nextCheckAt === null);

  /* ------------------------------------ a host that never shows the change */

  livePage = "<!doctype html><html><body><h1>Still the old one</h1></body></html>";
  const stubborn = await startPublishJob({ site, kind: "PAGE", pageId: page.id, detail: {} });
  await publishJobCommitted({
    id: stubborn.id,
    commit: { sha: "def456", url: "https://github.com/fixture/site/commit/def456" },
    site,
    page,
    html,
    summary: [{ id: "a", label: "Heading", kind: "text", part: "words", from: "x", to: "Ready to improve your systems?" }],
  });
  for (let attempt = 0; attempt < 9; attempt++) await verifyDuePublishJobs(new Date(Date.now() + (attempt + 1) * 20 * 60_000));
  row = await prisma.publishJob.findUniqueOrThrow({ where: { id: stubborn.id } });
  equal("a live page that never changes is reported, not retried for ever", row.state, "VERIFY_FAILED");
  check("and says what is actually true", /live page still shows the old version|could not be read/i.test(row.lastError ?? ""));
  check("the commit is still recorded, because it did happen", row.commitSha === "def456");

  /* --------------------------------- a change with no words to look for */

  livePage = "<!doctype html><html><body><h1>Unchanged words, new colour</h1></body></html>";
  const styled = await startPublishJob({ site, kind: "PAGE", pageId: page.id, detail: {} });
  await publishJobCommitted({
    id: styled.id,
    commit: { sha: "ghi789", url: "https://github.com/fixture/site/commit/ghi789" },
    site,
    page,
    html: livePage,
    summary: [{ id: "a", label: "Heading", kind: "text", part: "styling", from: "", to: "colour" }],
  });
  await verifyDuePublishJobs(new Date(Date.now() + 60_000));
  row = await prisma.publishJob.findUniqueOrThrow({ where: { id: styled.id } });
  equal("a styling change is verified by the whole file instead", row.state, "COMPLETED");

  /* ------------------------------------- a live site that cannot be read */

  liveFails = "the live site refused the connection";
  const unreachable = await startPublishJob({ site, kind: "PAGE", pageId: page.id, detail: {} });
  await publishJobCommitted({
    id: unreachable.id,
    commit: { sha: "jkl012", url: "https://github.com/fixture/site/commit/jkl012" },
    site,
    page,
    html,
    summary: [{ id: "a", label: "Heading", kind: "text", part: "words", from: "x", to: "Ready to improve your systems?" }],
  });
  await verifyDuePublishJobs(new Date(Date.now() + 60_000));
  row = await prisma.publishJob.findUniqueOrThrow({ where: { id: unreachable.id } });
  equal("a site that cannot be reached is kept waiting rather than failed at once", row.state, "VERIFYING");
  check("with the reason recorded", (row.lastError ?? "").length > 0);
  liveFails = null;

  /* ------------------------------- the process died in the middle of one */

  // The commit reached GitHub; this system was interrupted before recording it.
  repositoryFile = html;
  const interrupted = await prisma.publishJob.create({
    data: { siteId: site.id, pageId: page.id, kind: "PAGE", state: "COMMITTING", detail: { expectedHtmlHash: createHash("sha256").update(html).digest("hex") } },
  });
  // And one that died before the commit landed.
  const earlier = await prisma.publishJob.create({ data: { siteId: site.id, pageId: page.id, kind: "PAGE", state: "VALIDATING", detail: {} } });

  const handled = await reconcileInterruptedPublishJobs();
  check("every interrupted publish is accounted for", handled >= 2);
  equal(
    "a commit that landed with nothing recording it needs a person",
    (await prisma.publishJob.findUniqueOrThrow({ where: { id: interrupted.id } })).state,
    "RECONCILIATION_REQUIRED",
  );
  equal(
    "one that died before committing says nothing was changed",
    (await prisma.publishJob.findUniqueOrThrow({ where: { id: earlier.id } })).state,
    "COMMIT_FAILED",
  );

  // The same interruption, where the repository does *not* hold what the job was
  // going to write: nothing happened, and it must not read as needing a person.
  repositoryFile = "<!doctype html><html><body><h1>Something else entirely</h1></body></html>";
  const missed = await prisma.publishJob.create({
    data: { siteId: site.id, pageId: page.id, kind: "PAGE", state: "COMMITTING", detail: { expectedHtmlHash: createHash("sha256").update(html).digest("hex") } },
  });
  await reconcileInterruptedPublishJobs();
  equal("a commit that never landed is just a failed publish", (await prisma.publishJob.findUniqueOrThrow({ where: { id: missed.id } })).state, "COMMIT_FAILED");

  /* ----------------------------------- the record never breaks a publish */

  await failPublishJob("a-job-that-does-not-exist", "COMMIT_FAILED", "gone");
  check("writing to a job that has gone never throws", true);

  console.log(`websitePublishJobs: ${checks} checks — recorded before GitHub, watched until live, honest about a host that never rebuilds, and reconciled after an interruption`);
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>(resolve => liveServer.close(() => resolve()));
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.$disconnect();
}
