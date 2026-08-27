/**
 * Can two people edit one website without one of them losing an afternoon?
 *
 * The editor shipped as a single-user tool for a single site, and both of those
 * assumptions are being sold away. Four of them mattered enough to be worth a
 * committed check.
 *
 * **A draft had no revision, so a save was a shout rather than an exchange.**
 * Two editors on one page both read the draft, both typed, both saved; the
 * second write won, silently, and the first person's screen went on showing
 * their own words until they reloaded. Nothing anywhere recorded it.
 *
 * **Every route authorised on a page id and nothing else.** The permission gate
 * answers "may this person edit websites"; it never sees *which* website. With
 * one site in the database those are the same question. With two they are not.
 *
 * **A publish could only be undone by hand.** `SitePageVersion` has always
 * stored the whole file precisely so a page could be put back without anything
 * else still being true, and nothing used it.
 *
 * **A version said "6 fields changed".** Which six, from what, to what, was
 * recorded nowhere a person could read.
 *
 * The negatives are the half worth reading, as ever:
 *
 *   - A refused save must change **nothing** — not the draft, not the revision.
 *   - Invalidating one site's cache must not drop another site's entry.
 *   - A version id belonging to another page must be a 404 on both routes.
 *   - A rollback with no GitHub token must refuse with a sentence somebody can
 *     act on, not with "Something went wrong".
 *   - And ordinary editing must go on working: a conflict check that made the
 *     second save by the same person fail would be worse than no check at all.
 *
 * The page's HTML comes from a local server rather than the internet. With no
 * GitHub token configured `pageSource` falls back to fetching the live site, so
 * pointing `publicUrl` at 127.0.0.1 exercises the real read path with no network
 * and no credential.
 *
 * Database only.
 *   npx tsx checks/websiteBuilder.ts
 */
import express from "express";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { attachUser, requireAuth } from "../src/middleware/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { websiteRouter } from "../src/routes/website.js";
import { categoriseChanges, describeChanges, discoverFields, type FieldValue } from "../src/services/website/index.js";
import {
  clearSourceCache,
  invalidateSource,
  readCache,
  sourceCacheSize,
  sourceKey,
  writeCache,
  LIVE_TTL_MS,
  REPO_TTL_MS,
} from "../src/services/website/sourceCache.js";

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..", "..");

/** Everything this run makes carries the mark, so cleanup cannot touch real data. */
const MARK = "websitebuildercheck";

async function reset() {
  await prisma.sitePageVersion.deleteMany({ where: { page: { site: { slug: { startsWith: MARK } } } } });
  await prisma.sitePage.deleteMany({ where: { site: { slug: { startsWith: MARK } } } });
  await prisma.site.deleteMany({ where: { slug: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: MARK } } });
}

async function main() {
  await reset();

  const html = readFileSync(join(siteRoot, "about.html"), "utf8");

  // The customer's website, served from here. Nothing leaves the machine.
  const siteApp = express();
  siteApp.get("/about", (_req, res) => {
    res.type("html").send(html);
  });
  const siteServer = siteApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => siteServer.once("listening", resolve));
  const sitePort = (siteServer.address() as AddressInfo).port;

  // The API, mounted the way index.ts mounts it. Without attachUser the router
  // answers 401 to everything and the check reports a defect in the route that
  // is really a defect in the harness.
  const api = express();
  api.use(express.json());
  api.use(attachUser);
  api.use("/api", requireAuth);
  api.use("/api/website", websiteRouter);
  // The real one, not a stand-in. Half of what this file asserts is that a
  // refusal reaches whoever is editing as a sentence they can act on, and that
  // decision lives entirely in the handler — a harness with its own would be
  // asserting the harness.
  api.use(errorHandler);
  const apiServer = api.listen(0, "127.0.0.1");
  await new Promise((resolve) => apiServer.once("listening", resolve));
  const apiPort = (apiServer.address() as AddressInfo).port;

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/website${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    // A route that answers with HTML has fallen through to a default handler,
    // which is itself a finding — so the body is kept rather than throwing here.
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      parsed = { error: text.slice(0, 200), notJson: true };
    }
    return { status: response.status, body: parsed };
  };

  const site = await prisma.site.create({
    data: {
      name: `${MARK} site`,
      slug: `${MARK}-one`,
      publicUrl: `http://127.0.0.1:${sitePort}`,
      // No repository, so reads fall to the live site and publishing refuses —
      // which is itself one of the things under test.
      repoBranch: "main",
      repoPath: "",
    },
  });
  const other = await prisma.site.create({
    data: { name: `${MARK} other`, slug: `${MARK}-two`, publicUrl: `http://127.0.0.1:${sitePort}`, repoBranch: "main" },
  });
  const page = await prisma.sitePage.create({
    data: { siteId: site.id, title: "About", path: "/about", filePath: "about.html" },
  });
  const otherPage = await prisma.sitePage.create({
    data: { siteId: other.id, title: "About", path: "/about", filePath: "about.html" },
  });
  const ama = await prisma.user.create({ data: { email: `${MARK}-ama@example.com`, name: "Ama" } });

  // --- The exchange --------------------------------------------------------

  console.log("\nA draft save is an exchange, not a shout");

  const opened = await call("GET", `/pages/${page.id}`);
  const draft = opened.body?.draft as { revision: number } | undefined;
  check("opening a page hands out a revision", typeof draft?.revision === "number", JSON.stringify(opened.body?.draft));
  if (!draft) throw new Error("the page did not open; nothing below can be trusted");

  const fields = discoverFields(html).fields;
  const heading = fields.find((field) => field.kind === "text" && /^h[1-3]$/.test(field.tag) && field.preview.length > 3);
  const paragraph = fields.find((field) => field.kind !== "image" && field.id !== heading?.id && field.preview.length > 20);
  if (!heading || !paragraph) throw new Error("about.html did not yield the two fields this check needs");

  const first = await call("PUT", `/pages/${page.id}/draft`, {
    ifRevision: draft.revision,
    values: { [heading.id]: { value: "Ama was here" } },
  });
  check("a save quoting the current revision is accepted", first.status === 200, `${first.status}`);
  check("the accepted save moves the revision on", first.body?.revision === draft.revision + 1, JSON.stringify(first.body?.revision));

  // Somebody else, still holding the number from before Ama saved.
  const stale = await call("PUT", `/pages/${page.id}/draft`, {
    ifRevision: draft.revision,
    values: { [heading.id]: { value: "Kofi was here" } },
  });
  check("a save quoting a stale revision is refused", stale.status === 409, `${stale.status}`);
  check("the refusal carries the current revision", stale.body?.revision === draft.revision + 1, JSON.stringify(stale.body?.revision));
  const contested = (stale.body?.fields as Array<{ id: string; yours: unknown; theirs: unknown; contested: boolean }>) ?? [];
  const row = contested.find((entry) => entry.id === heading.id);
  check("the refusal shows both versions of the contested field", Boolean(row?.yours) && Boolean(row?.theirs), JSON.stringify(row));
  check("the contested field is marked as contested", row?.contested === true, JSON.stringify(row?.contested));
  // Named after whoever actually holds the draft, not after a fixture: under
  // DEV_NO_AUTH every request is the same implicit Owner, so asserting a
  // hard-coded name would be asserting the harness rather than the route.
  const holder = await prisma.sitePage.findUniqueOrThrow({
    where: { id: page.id },
    include: { draftSavedBy: { select: { name: true } } },
  });
  check(
    "the refusal names who saved over you",
    Boolean(holder.draftSavedBy?.name) && String(stale.body?.error ?? "").includes(holder.draftSavedBy!.name),
    JSON.stringify(stale.body?.error),
  );

  // The negative, and the reason the whole thing exists.
  const afterRefusal = await prisma.sitePage.findUniqueOrThrow({ where: { id: page.id } });
  const stored = afterRefusal.draft as Record<string, { value?: string }>;
  check("a refused save leaves the other person's words alone", stored[heading.id]?.value === "Ama was here", JSON.stringify(stored[heading.id]));
  check("a refused save does not move the revision", afterRefusal.draftRevision === draft.revision + 1, `${afterRefusal.draftRevision}`);

  // A save with no revision at all is the client that was never updated, and it
  // is precisely the one that would overwrite. It must not be let through.
  const blind = await call("PUT", `/pages/${page.id}/draft`, { values: { [heading.id]: { value: "nobody asked" } } });
  check("a save with no revision at all is refused", blind.status >= 400, `${blind.status}`);
  check("and the refusal is a sentence, not a 500", blind.status === 400 && blind.body?.notJson !== true, JSON.stringify(blind.body));
  check(
    "the sentence says what to do about it",
    /reload/i.test(String(blind.body?.error ?? "")),
    JSON.stringify(blind.body?.error),
  );
  const afterBlind = await prisma.sitePage.findUniqueOrThrow({ where: { id: page.id } });
  check(
    "the blind save changed nothing",
    (afterBlind.draft as Record<string, { value?: string }>)[heading.id]?.value === "Ama was here",
  );

  // Ordinary editing must go on working, or this cure is worse than the disease.
  const second = await call("PUT", `/pages/${page.id}/draft`, {
    ifRevision: afterBlind.draftRevision,
    values: { [heading.id]: { value: "Ama was here" }, [paragraph.id]: { value: "And wrote this too." } },
  });
  check("the same editor can go on saving", second.status === 200, `${second.status}`);

  // Discarding is a change to the draft like any other.
  const beforeDiscard = (second.body?.revision as number) ?? 0;
  const discarded = await fetch(`http://127.0.0.1:${apiPort}/api/website/pages/${page.id}/draft`, { method: "DELETE" });
  check("discarding a draft succeeds", discarded.status === 204, `${discarded.status}`);
  const afterDiscard = await prisma.sitePage.findUniqueOrThrow({ where: { id: page.id } });
  check("discarding moves the revision on", afterDiscard.draftRevision === beforeDiscard + 1, `${afterDiscard.draftRevision}`);
  const staleAfterDiscard = await call("PUT", `/pages/${page.id}/draft`, {
    ifRevision: beforeDiscard,
    values: { [heading.id]: { value: "written over a discard" } },
  });
  check("an editor holding the pre-discard number is refused", staleAfterDiscard.status === 409, `${staleAfterDiscard.status}`);

  // --- Route scoping -------------------------------------------------------

  console.log("\nA page id is not an authorisation");

  const missingSite = await call("GET", "/sites/does-not-exist/pages");
  check("an unknown site is a 404, not a 500", missingSite.status === 404, `${missingSite.status}`);
  const missingPage = await call("GET", "/pages/does-not-exist");
  check("an unknown page is a 404, not a 500", missingPage.status === 404, `${missingPage.status}`);
  const missingVersions = await call("GET", "/pages/does-not-exist/versions");
  check("versions of an unknown page is a 404, not an empty list", missingVersions.status === 404, `${missingVersions.status}`);

  // --- Versions, rollback and the readable summary -------------------------

  console.log("\nWhat a publish did, in words");

  const values: Record<string, FieldValue> = {
    [heading.id]: { value: "Built to last", original: "Build once" },
    "meta.1": { value: "A new description", original: "The old one" },
  };
  const summary = describeChanges(fields, values);
  check("every change produces a line", summary.length === 2, `${summary.length}`);
  const headingLine = summary.find((entry) => entry.id === heading.id);
  check("a line reads from → to", headingLine?.from === "Build once" && headingLine?.to === "Built to last", JSON.stringify(headingLine));
  check("a line carries the field's own label", (headingLine?.label.length ?? 0) > 2, JSON.stringify(headingLine?.label));
  const categories = categoriseChanges(summary);
  check("changing the description counts as an SEO change", categories.seo === true);
  check("nothing invented: no styles were touched", categories.styles === false);

  const markupStripped = describeChanges(fields, {
    [heading.id]: { value: "<b>Bold</b> words", original: "plain" },
  });
  check("a summary reads as words, not as markup", markupStripped[0]?.to === "Bold words", JSON.stringify(markupStripped[0]?.to));

  const emptied = describeChanges(fields, { [heading.id]: { value: "", original: "Build once" } });
  check("an emptied value still reads as something", emptied[0]?.to === "(nothing)", JSON.stringify(emptied[0]));

  const orphan = describeChanges([], values);
  check("a version naming a field the page has lost still renders", orphan.length === 2 && (orphan[0]?.label.length ?? 0) > 0);

  const version = await prisma.sitePageVersion.create({
    data: { pageId: page.id, number: 1, html, values: values as never, publishedById: ama.id },
  });
  const otherVersion = await prisma.sitePageVersion.create({
    data: { pageId: otherPage.id, number: 1, html, values: values as never },
  });

  const listed = await call("GET", `/pages/${page.id}/versions`);
  const rows = (listed.body as unknown as Array<{ number: number; summary: unknown[]; touched: { seo: boolean } }>) ?? [];
  check("the version list carries its summary", (rows[0]?.summary?.length ?? 0) === 2, JSON.stringify(rows[0]?.summary));
  check("the version list says what kind of change it was", rows[0]?.touched?.seo === true, JSON.stringify(rows[0]?.touched));

  const diff = await call("GET", `/pages/${page.id}/versions/${version.id}/diff`);
  check("the rollback diff can be asked for", diff.status === 200, `${diff.status}`);
  check("the diff says the page is already identical", diff.body?.identical === true, JSON.stringify(diff.body?.identical));
  check("the diff warns that it overwrites later work", String(diff.body?.warning ?? "").includes("undone"));

  // A difference nobody can see is not a difference to show somebody.
  //
  // The first version of the diff compared inner HTML and then printed plain
  // text, so a file differing only in whitespace produced a confirmation screen
  // listing three changes whose before and after were the same sentence. On the
  // one screen that has to be believed — the one asking permission to overwrite
  // a live page — that teaches somebody the tool is wrong.
  const spaced = await prisma.sitePageVersion.create({
    data: {
      pageId: page.id,
      number: 3,
      // Real whitespace, of the kind that appears between a repository file and
      // what a static host actually serves.
      html: html.replace(/<h1/i, "<h1 "),
      values: values as never,
    },
  });
  const invisibleDiff = await call("GET", `/pages/${page.id}/versions/${spaced.id}/diff`);
  check("a whitespace-only version is not identical", invisibleDiff.body?.identical === false, JSON.stringify(invisibleDiff.body?.identical));
  check(
    "and none of it is listed as a visible change",
    invisibleDiff.body?.differenceCount === 0,
    JSON.stringify((invisibleDiff.body?.differences as unknown[])?.slice(0, 3)),
  );

  const realDiff = await prisma.sitePageVersion.create({
    data: { pageId: page.id, number: 4, html: html.replace(heading.value, "A genuinely different heading"), values: values as never },
  });
  const seen = await call("GET", `/pages/${page.id}/versions/${realDiff.id}/diff`);
  // The positive half, without which the negative above would pass on a diff
  // that had simply stopped working.
  check("a change somebody can read is listed", (seen.body?.differenceCount as number) > 0, JSON.stringify(seen.body?.differenceCount));
  const diffRows = (seen.body?.differences as Array<{ now: string; after: string }>) ?? [];
  check(
    "and its two sides are not the same words",
    diffRows.length > 0 && diffRows.every((entry) => entry.now !== entry.after),
    JSON.stringify(diffRows.slice(0, 2)),
  );

  // The negative that matters: a version belonging to another page is not this
  // page's to restore, however valid the id is.
  const foreignDiff = await call("GET", `/pages/${page.id}/versions/${otherVersion.id}/diff`);
  check("another page's version is a 404 on the diff", foreignDiff.status === 404, `${foreignDiff.status}`);
  const foreignPublish = await call("POST", `/pages/${page.id}/versions/${otherVersion.id}/publish`);
  check("another page's version is a 404 on the rollback", foreignPublish.status === 404, `${foreignPublish.status}`);
  const foreignRestore = await call("POST", `/pages/${page.id}/versions/${otherVersion.id}/restore`);
  check("another page's version is a 404 on restore-to-draft", foreignRestore.status === 404, `${foreignRestore.status}`);

  // Rolling back to a version identical to the page is refused before anything
  // reaches GitHub: the page already says what is being asked for.
  const noop = await call("POST", `/pages/${page.id}/versions/${version.id}/publish`);
  check("rolling back to what is already live is refused", noop.status === 400, `${noop.status}`);
  check("and it says why in a sentence", String(noop.body?.error ?? "").includes("already exactly"), JSON.stringify(noop.body?.error));

  // A version that differs, with no token configured: the refusal must name the
  // setting rather than arriving as "Something went wrong".
  const changed = await prisma.sitePageVersion.create({
    data: { pageId: page.id, number: 2, html: html.replace("</body>", "<!-- older --></body>"), values: values as never },
  });
  const refused = await call("POST", `/pages/${page.id}/versions/${changed.id}/publish`);
  check("a rollback with no GitHub token refuses", refused.status >= 400 && refused.status < 500, `${refused.status}`);
  check(
    "and the refusal names what to do about it",
    /repository|GitHub|Settings/i.test(String(refused.body?.error ?? "")),
    JSON.stringify(refused.body?.error),
  );

  // --- The source cache ----------------------------------------------------

  console.log("\nThe cache remembers, and forgets when it must");

  clearSourceCache();
  const repoKey = sourceKey({ siteId: "s1", repo: "o/r", branch: "main", filePath: "index.html" });
  const liveKey = sourceKey({ siteId: "s2", repo: null, branch: "main", filePath: "index.html" });

  writeCache(repoKey, { html: "<h1>a</h1>", from: "repository" });
  check("a written entry reads back", readCache(repoKey)?.html === "<h1>a</h1>");
  check("a key that was never written reads as nothing", readCache("nope") === null);

  writeCache(liveKey, { html: "<h1>b</h1>", from: "live site" });
  check(
    "a live-site read is kept for much less time than a repository read",
    LIVE_TTL_MS < REPO_TTL_MS / 2,
    `${LIVE_TTL_MS} vs ${REPO_TTL_MS}`,
  );

  check("invalidating one site drops its entry", invalidateSource("s1") === 1);
  check("and the entry is gone", readCache(repoKey) === null);
  // The negative: two customers share this process.
  check("invalidating one site leaves another site's entry alone", readCache(liveKey)?.html === "<h1>b</h1>");

  writeCache(sourceKey({ siteId: "s3", repo: "o/r", branch: "main", filePath: "a.html" }), { html: "a", from: "repository" });
  writeCache(sourceKey({ siteId: "s3", repo: "o/r", branch: "main", filePath: "b.html" }), { html: "b", from: "repository" });
  check("invalidating one file drops only that file", invalidateSource("s3", "a.html") === 1);
  check("the sibling file survives", readCache(sourceKey({ siteId: "s3", repo: "o/r", branch: "main", filePath: "b.html" })) !== null);

  // Two sites pointed at one repository are two subscriptions.
  const shared = { repo: "o/r", branch: "main", filePath: "index.html" };
  writeCache(sourceKey({ siteId: "a", ...shared }), { html: "a", from: "repository" });
  writeCache(sourceKey({ siteId: "b", ...shared }), { html: "b", from: "repository" });
  invalidateSource("a");
  check(
    "one site's invalidation does not reach another's copy of the same file",
    readCache(sourceKey({ siteId: "b", ...shared })) !== null,
  );

  clearSourceCache();
  check("clearing empties it", sourceCacheSize() === 0);

  siteServer.close();
  apiServer.close();
  await reset();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error(`websiteBuilder: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("websiteBuilder: all checks passed");
}

main()
  .catch(async (err) => {
    console.error(err);
    await reset().catch(() => {});
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
