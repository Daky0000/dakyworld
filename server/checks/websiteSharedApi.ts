/**
 * Shared elements over real HTTP, a real database and the real GitHub adapter.
 *
 *   DATABASE_URL=<isolated local editor database> npx tsx checks/websiteSharedApi.ts
 *
 * The pure rules are `checks/websiteShared.ts`; this is the half that can only
 * be wrong in a route: where a shared edit gets stored, whether the other pages
 * can see it before it is published, and what the publish refuses to do. No
 * request can leave the machine — the GitHub adapter is answered by a fixed
 * responder, and the check fails if anything asks for another origin.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { WebsiteError } from "../src/services/website/site.js";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}
process.env.DEV_NO_AUTH = "false";
process.env.GITHUB_TOKEN = "shared-check-stub";
process.env.GITHUB_ALLOWED_REPOS = "fixture/site";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

/* ------------------------------------------------------------ the fixture */

const cta = (words: string, extra = "") =>
  `<section class="cta" data-dw-shared="main-cta"><h2>${words}</h2>${extra}<a class="btn btn-primary" href="/contact">Let us talk</a></section>`;
const pageHtml = (name: string, extra = "") =>
  `<!doctype html><html><head><title>${name}</title></head><body><main><h1>${name}</h1><p>Words about ${name}.</p></main>${cta("Ready to improve your systems?", extra)}</body></html>`;

/* --------------------------------------------------------- GitHub, stubbed */

const committed: Array<{ message: string; files: Array<{ path: string; content: string }> }> = [];
let commitCount = 0;
let failCommit = false;
const blobs = new Map<string, string>();
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = new URL(String(input));
  if (target.hostname === "127.0.0.1") return originalFetch(input as never, init);
  assert.equal(target.origin, "https://api.github.com", "no check may reach a real service");
  const path = target.pathname;
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  if (path.endsWith("/git/ref/heads/main")) return json({ object: { sha: "pinned-head" } });
  if (path.includes("/contents/")) return json({ message: "Not found" }, 404);
  if (path.endsWith("/git/commits/pinned-head")) return json({ tree: { sha: "old-tree" } });
  if (path.endsWith("/git/blobs")) {
    const sha = `blob-${blobs.size + 1}`;
    blobs.set(sha, Buffer.from(String(body?.content ?? ""), "base64").toString("utf8"));
    return json({ sha });
  }
  if (path.endsWith("/git/trees")) {
    const tree = (body?.tree as Array<{ path: string; sha: string }>) ?? [];
    committed.push({ message: "", files: tree.map((entry) => ({ path: entry.path, content: blobs.get(entry.sha) ?? "" })) });
    return json({ sha: "new-tree" });
  }
  if (path.endsWith("/git/commits")) {
    if (failCommit) return json({ message: "Not a fast forward" }, 422);
    commitCount += 1;
    if (committed.length) committed[committed.length - 1]!.message = String(body?.message ?? "");
    return json({ sha: `commit-${commitCount}`, html_url: `https://github.com/fixture/site/commit/commit-${commitCount}` });
  }
  if (path.endsWith("/git/refs/heads/main")) return json({ object: { sha: `commit-${commitCount}` } });
  throw new Error(`Unexpected GitHub request ${path}`);
}) as typeof fetch;

/* --------------------------------------------------------------- the run */

const { prisma } = await import("../src/lib/prisma.js");
const { attachUser, requireAuth, scopeExternal, DEV_NO_AUTH } = await import("../src/middleware/auth.js");
const { createSession } = await import("../src/lib/session.js");
const { websiteRouter } = await import("../src/routes/website.js");
assert.equal(DEV_NO_AUTH, false, "shared-element checks must authenticate a real session");

const mark = `sharedcheck-${randomUUID()}`;
const siteIds: string[] = [];
const userIds: string[] = [];
const roleIds: string[] = [];
let server: ReturnType<typeof express.application.listen> | undefined;

try {
  const role = await prisma.accessRole.create({
    data: { key: mark, name: mark, external: false, permissions: ["website.view", "website.edit", "website.publish", "website.manage"] },
  });
  roleIds.push(role.id);
  const user = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Editor", accessRoleId: role.id } });
  userIds.push(user.id);
  const token = await createSession(user.id);

  const site = await prisma.site.create({
    data: { slug: mark, name: "Fixture", publicUrl: "https://example.test", repoOwner: "fixture", repoName: "site", repoBranch: "main" },
  });
  siteIds.push(site.id);

  const pages = await Promise.all(
    [
      { title: "Home", path: "/", filePath: "index.html", html: pageHtml("Home") },
      { title: "Services", path: "/services", filePath: "services.html", html: pageHtml("Services") },
      { title: "Contact", path: "/contact", filePath: "contact.html", html: pageHtml("Contact") },
    ].map((entry) =>
      prisma.sitePage.create({ data: { siteId: site.id, title: entry.title, path: entry.path, filePath: entry.filePath, sourceHtml: entry.html } }),
    ),
  );
  const [home, services, contact] = pages;

  const app = express();
  app.use(express.json());
  app.use("/api", attachUser, requireAuth, scopeExternal);
  app.use("/api/website", websiteRouter);
  app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof WebsiteError ? error.status : 500;
    res.status(status).json({ error: (error as Error).message, ...(error as Record<string, unknown>) });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async <T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${base}/api/website${path}`, {
      method,
      headers: { Cookie: `dw_session=${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };

  /* ----------------------------------------------------------- detection */

  type Suggestions = { candidates: Array<{ key: string; name: string; confidence: string; instances: Array<{ pageId: string; fieldId: string }> }>; readPages: number };
  const suggestions = await call<Suggestions>(`/sites/${site.id}/shared/suggestions`);
  equal("suggestions read every page", suggestions.body.readPages, 3);
  const suggested = suggestions.body.candidates.find((candidate) => candidate.key === "main-cta");
  check("the annotated call to action is suggested", suggested !== undefined);
  equal("on all three pages", suggested!.instances.length, 3);
  equal("at high confidence", suggested!.confidence, "high");

  /* ------------------------------------------------------- making it shared */

  const ctaOn = (pageId: string) => suggested!.instances.find((instance) => instance.pageId === pageId)!.fieldId;
  const created = await call<{ id: string; instances: number; refused: unknown[] }>(`/sites/${site.id}/shared`, "POST", {
    name: "Main CTA",
    key: "main-cta",
    pageId: home.id,
    fieldId: ctaOn(home.id),
    instances: [
      { pageId: services.id, fieldId: ctaOn(services.id) },
      { pageId: contact.id, fieldId: ctaOn(contact.id) },
    ],
  });
  equal("the shared element is created", created.status, 201);
  equal("with one instance per page", created.body.instances, 3);
  equal("and nothing refused", created.body.refused, []);
  const sharedId = created.body.id;

  const again = await call(`/sites/${site.id}/shared/suggestions`);
  check("what is already shared stops being suggested", !(again.body as Suggestions).candidates.some((candidate) => candidate.key === "main-cta"));

  /* ------------------------------------------------------ what a page says */

  type PageDetail = {
    draft: { values: Record<string, { value?: string }>; revision: number };
    shared: {
      scope: Record<string, { name: string; slot: string; state: string; linkedPages: number }>;
      elements: Array<{ id: string; name: string; revision: number; linkedPages: number; state: string; pendingSlots: number }>;
    };
    sections: Array<{ fields: Array<{ id: string; tag: string; value: string }> }>;
  };
  let detail = await call<PageDetail>(`/pages/${home.id}`);
  const headingId = detail.body.sections.flatMap((section) => section.fields).find((field) => field.tag === "h2")!.id;
  equal("the heading is reported as part of a shared element", detail.body.shared.scope[headingId]?.name, "Main CTA");
  equal("and the editor is told how many pages a change would reach", detail.body.shared.scope[headingId]?.linkedPages, 3);
  equal("the element itself is listed once", detail.body.shared.elements.length, 1);
  equal("with nothing pending yet", detail.body.shared.elements[0]!.pendingSlots, 0);

  /* ------------------------------------------- one change, stored once */

  const sharedRevision = detail.body.shared.elements[0]!.revision;
  let save = await call<{ sharedRevisions: Record<string, number>; changed: number }>(`/pages/${home.id}/draft`, "PUT", {
    ifRevision: detail.body.draft.revision,
    documentHash: null,
    sharedRevisions: { [sharedId]: sharedRevision },
    values: { [headingId]: { value: "Ready to get started?" } },
  });
  equal("the save succeeds", save.status, 200);
  equal("and reports the shared element's new revision", save.body.sharedRevisions[sharedId], sharedRevision + 1);

  const homeRow = await prisma.sitePage.findUniqueOrThrow({ where: { id: home.id } });
  equal("a shared change is not copied into the page's own draft", homeRow.draft, null);
  const element = await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } });
  equal("it is stored against the shared element, keyed by slot", Object.keys(element.draft as object), ["0"]);

  /* ---------------------------------------- and every page already shows it */

  const servicesDetail = await call<PageDetail>(`/pages/${services.id}`);
  const servicesHeading = servicesDetail.body.sections.flatMap((section) => section.fields).find((field) => field.tag === "h2")!.id;
  equal("another page shows the shared change before anything is published", servicesDetail.body.draft.values[servicesHeading]?.value, "Ready to get started?");
  equal("and knows it is shared", servicesDetail.body.shared.scope[servicesHeading]?.state, "LINKED");

  const preview = await fetch(`${base}/api/website/pages/${contact.id}/preview`, { headers: { Cookie: `dw_session=${token}` } });
  const previewHtml = await preview.text();
  check("the preview of a third page carries it too", previewHtml.includes("Ready to get started?"));

  /* ------------------------------------------- a stale shared revision */

  // The page revision is the current one on purpose: the only thing wrong with
  // this save is the shared element's, and a check that passed because the page
  // revision was also stale would be a check of the wrong mechanism.
  detail = await call<PageDetail>(`/pages/${home.id}`);
  const stale = await call<{ error: string }>(`/pages/${home.id}/draft`, "PUT", {
    ifRevision: detail.body.draft.revision,
    documentHash: null,
    sharedRevisions: { [sharedId]: sharedRevision },
    values: { [headingId]: { value: "Something else" } },
  });
  equal("a save quoting a stale shared revision is refused", stale.status, 409);
  check("and says which shared element moved", /Main CTA/.test(stale.body.error));
  const unchanged = await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } });
  equal("and nothing was written", (unchanged.draft as Record<string, { value: string }>)["0"]!.value, "Ready to get started?");

  /* ------------------------------- a page publish will not publish it alone */

  const pagePublish = await call<{ error: string }>(`/pages/${home.id}/publish`, "POST");
  equal("publishing one page of a shared change is refused", pagePublish.status, 409);
  check("and the refusal says where to publish it instead", /shared/i.test(pagePublish.body.error));

  /* ------------------------------------------------------------- review */

  type Review = { publishable: boolean; reason?: string; pages: Array<{ pageId: string; title: string; sourceHash: string; changed: number; blocked?: string }>; detached: string[] };
  let review = await call<Review>(`/shared/${sharedId}/review`);
  equal("the review covers every linked page", review.body.pages.length, 3);
  check("and says it can be published", review.body.publishable);
  check("no page source travels with it", !JSON.stringify(review.body).includes("<!doctype"));

  /* ------------------------------------------------------ detach and re-link */

  const instances = await prisma.sharedElementInstance.findMany({ where: { sharedElementId: sharedId } });
  const servicesInstance = instances.find((instance) => instance.pageId === services.id)!;
  const detach = await call<{ changed: number }>(`/shared/${sharedId}/instances/${servicesInstance.id}/detach`, "POST");
  equal("detaching succeeds", detach.status, 200);
  equal("and takes the shared value with it", detach.body.changed, 1);
  const servicesRow = await prisma.sitePage.findUniqueOrThrow({ where: { id: services.id } });
  equal("so the page keeps exactly what it was showing", (servicesRow.draft as Record<string, { value: string }>)[servicesHeading]!.value, "Ready to get started?");

  const afterDetach = await call<PageDetail>(`/pages/${services.id}`);
  equal("the detached page still shows the same words", afterDetach.body.draft.values[servicesHeading]?.value, "Ready to get started?");
  equal("but is no longer listening", afterDetach.body.shared.scope[servicesHeading]?.state, "DETACHED");

  review = await call<Review>(`/shared/${sharedId}/review`);
  equal("a detached page is not in the shared publish", review.body.pages.length, 2);
  check("and is named as detached", review.body.detached.includes(services.id));

  // A change made now must not reach the detached page.
  const homeAgain = await call<PageDetail>(`/pages/${home.id}`);
  save = await call(`/pages/${home.id}/draft`, "PUT", {
    ifRevision: homeAgain.body.draft.revision,
    documentHash: null,
    sharedRevisions: { [sharedId]: homeAgain.body.shared.elements[0]!.revision },
    values: { [headingId]: { value: "Ready when you are?" } },
  });
  equal("a later shared change saves", save.status, 200);
  const detachedNow = await call<PageDetail>(`/pages/${services.id}`);
  equal("and does not reach the page that left", detachedNow.body.draft.values[servicesHeading]?.value, "Ready to get started?");
  const stillLinked = await call<PageDetail>(`/pages/${contact.id}`);
  const contactHeading = stillLinked.body.sections.flatMap((section) => section.fields).find((field) => field.tag === "h2")!.id;
  equal("but does reach the page that stayed", stillLinked.body.draft.values[contactHeading]?.value, "Ready when you are?");

  const relink = await call<{ state: string }>(`/shared/${sharedId}/instances/${servicesInstance.id}/relink`, "POST");
  equal("re-linking succeeds", relink.status, 200);
  const relinked = await call<PageDetail>(`/pages/${services.id}`);
  equal("and the shared version wins", relinked.body.draft.values[servicesHeading]?.value, "Ready when you are?");
  equal("with the local copy gone", (await prisma.sitePage.findUniqueOrThrow({ where: { id: services.id } })).draft, null);

  /* ------------------------------------------------- a page that has drifted */

  await prisma.sitePage.update({ where: { id: contact.id }, data: { sourceHtml: pageHtml("Contact", "<p>Only this page has this.</p>") } });
  review = await call<Review>(`/shared/${sharedId}/review`);
  const blockedPage = review.body.pages.find((page) => page.pageId === contact.id)!;
  check("a page whose copy changed shape is marked", Boolean(blockedPage.blocked));
  check("and blocks the whole shared publish", !review.body.publishable);
  const refused = await call<{ error: string }>(`/shared/${sharedId}/publish`, "POST", {
    ifRevision: (await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } })).draftRevision,
    pages: Object.fromEntries(review.body.pages.map((page) => [page.pageId, page.sourceHash])),
  });
  equal("so nothing is published", refused.status, 409);
  equal("and no commit was made", commitCount, 0);

  await prisma.sitePage.update({ where: { id: contact.id }, data: { sourceHtml: pageHtml("Contact") } });

  /* --------------------------------------------------- a page that has moved */

  review = await call<Review>(`/shared/${sharedId}/review`);
  check("the review is publishable again", review.body.publishable);
  const wrongHashes = Object.fromEntries(review.body.pages.map((page) => [page.pageId, "0".repeat(64)]));
  const stalePublish = await call<{ error: string }>(`/shared/${sharedId}/publish`, "POST", {
    ifRevision: (await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } })).draftRevision,
    pages: wrongHashes,
  });
  equal("a publish quoting a page that has moved is refused", stalePublish.status, 409);
  equal("and still nothing was committed", commitCount, 0);

  /* ------------------------------------------------------------- publish */

  const element2 = await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } });
  const published = await call<{ commit: { sha: string }; pages: Array<{ pageId: string }> }>(`/shared/${sharedId}/publish`, "POST", {
    ifRevision: element2.draftRevision,
    pages: Object.fromEntries(review.body.pages.map((page) => [page.pageId, page.sourceHash])),
  });
  equal("the shared change publishes", published.status, 200);
  equal("to every linked page", published.body.pages.length, 3);
  equal("in exactly one commit", commitCount, 1);
  const files = committed[committed.length - 1]!.files.filter((file) => file.path.endsWith(".html"));
  equal("carrying every affected file", files.map((file) => file.path).sort(), ["contact.html", "index.html", "services.html"]);
  check("each with the change in it", files.every((file) => file.content.includes("Ready when you are?")));

  const cleared = await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } });
  equal("the shared draft is cleared", cleared.draft, null);
  const versions = await prisma.sitePageVersion.findMany({ where: { pageId: { in: pages.map((page) => page.id) } } });
  equal("and every page has a version recorded", versions.length, 3);
  check("all pointing at the same commit", new Set(versions.map((version) => version.commitSha)).size === 1);

  /* ----------------------------------------- a failed commit changes nothing */

  const later = await call<PageDetail>(`/pages/${home.id}`);
  await call(`/pages/${home.id}/draft`, "PUT", {
    ifRevision: later.body.draft.revision,
    documentHash: null,
    sharedRevisions: { [sharedId]: later.body.shared.elements[0]!.revision },
    values: { [headingId]: { value: "One more time?" } },
  });
  failCommit = true;
  const failReview = await call<Review>(`/shared/${sharedId}/review`);
  const failed = await call(`/shared/${sharedId}/publish`, "POST", {
    ifRevision: (await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } })).draftRevision,
    pages: Object.fromEntries(failReview.body.pages.map((page) => [page.pageId, page.sourceHash])),
  });
  check("a refused commit is reported as a failure", failed.status >= 400);
  const survived = await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } });
  check("and the change is still there to try again", survived.draft !== null);
  equal("with no half-written versions left behind", await prisma.sitePageVersion.count({ where: { pageId: { in: pages.map((page) => page.id) } } }), 3);
  failCommit = false;

  /* ------------------------------------------------- giving up on sharing */

  const stop = await call(`/shared/${sharedId}`, "DELETE");
  equal("an element can stop being shared", stop.status, 200);
  const kept = await prisma.sitePage.findUniqueOrThrow({ where: { id: home.id } });
  check("and each page keeps what it was showing", (kept.draft as Record<string, { value: string }> | null)?.[headingId]?.value === "One more time?");
  equal("with no instances left", await prisma.sharedElementInstance.count({ where: { sharedElementId: sharedId } }), 0);

  console.log(`websiteSharedApi: ${checks} checks — detection, one stored change, cross-page drafts and previews, detach and re-link, drift and staleness refusals, one commit for the lot, and an atomic failure passed`);
} finally {
  globalThis.fetch = originalFetch;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.accessRole.deleteMany({ where: { id: { in: roleIds } } });
  await prisma.$disconnect();
}
