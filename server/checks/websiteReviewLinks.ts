/**
 * Client sign-off, end to end over real HTTP: the editor makes a link, a
 * reviewer with no account opens it, comments, decides once, and the editor
 * sees the answer. services/websiteReviewLinks.ts.
 *
 * The version this replaced failed at every one of those steps and every check
 * it had passed, because none of them crossed HTTP. These do.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteReviewLinks needs an isolated local test/editor database.");
}
process.env.DEV_NO_AUTH = "false";

const { prisma } = await import("../src/lib/prisma.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { createSession } = await import("../src/lib/session.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { registerPublicReviewRoutes } = await import("../src/services/websiteReviewLinks.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };

await ensureSystemRoles();
const mark = `reviewcheck-${randomUUID()}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const owner = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Review check", role: "OWNER", accessRoleId: ownerRole.id } });
const externalRole = await prisma.accessRole.create({ data: { key: mark, name: mark, external: true, permissions: [] } });
const outsider = await prisma.user.create({ data: { email: `${mark}-outsider@example.test`, name: "Outsider", accessRoleId: externalRole.id } });
const cookie = `dw_session=${await createSession(owner.id)}`;
const outsiderCookie = `dw_session=${await createSession(outsider.id)}`;

const html = '<!doctype html><html><head><title>Home</title></head><body><main><h1>Original heading</h1><p>Some words.</p></main></body></html>';
const site = await prisma.site.create({ data: { slug: mark, name: "Review check site", publicUrl: "https://example.test" } });
const page = await prisma.sitePage.create({ data: { siteId: site.id, title: "Home", path: "/", filePath: "index.html", sourceHtml: html } });
const empty = await prisma.sitePage.create({ data: { siteId: site.id, title: "About", path: "/about", filePath: "about.html", sourceHtml: html } });

const app = express();
app.use(express.json());
const publicRouter = express.Router();
publicRouter.use(express.json());
registerPublicReviewRoutes(publicRouter);
app.use("/api/public", publicRouter);
app.use(attachUser);
app.use("/api", requireAuth);
app.use("/api/website", websiteRouter);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = (method: string, path: string, body?: unknown, session: string | null = cookie) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(session ? { Cookie: session } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

try {
  // A draft to review: the heading changed.
  const read = await (await call("GET", `/api/website/pages/${page.id}`)).json() as { sections: Array<{ fields: Array<{ id: string; value: string }> }> };
  const heading = read.sections.flatMap((section) => section.fields).find((field) => field.value === "Original heading")!;
  const saved = await call("PUT", `/api/website/pages/${page.id}/draft`, { ifRevision: 0, values: { [heading.id]: { value: "Proposed heading" } } });
  assert.equal(saved.status, 200, await saved.clone().text());

  let response = await call("POST", `/api/website/pages/${empty.id}/review-links`, {});
  check("a page with nothing unpublished cannot be sent for review", () => assert.equal(response.status, 409));
  await response.text();

  response = await call("POST", `/api/website/pages/${page.id}/review-links`, {}, outsiderCookie);
  check("somebody with no access to the site cannot make a link", () => assert.ok([403, 404].includes(response.status), `answered ${response.status}`));
  await response.text();

  response = await call("POST", `/api/website/pages/${page.id}/review-links`, { reviewerName: "Ama", expiresInDays: 7 });
  check("the editor can make a review link", () => assert.equal(response.status, 201));
  const created = await response.json() as { url: string; link: { id: string; status: string; stale: boolean } };
  const token = new URL(created.url).pathname.split("/")[2]!;
  check("the link points at the customer's door, not the OS", () => assert.match(created.url, /^https:\/\/editor\.dakyx\.com\/review\/[A-Za-z0-9_-]{30,}$/));
  const row = await prisma.reviewLink.findUniqueOrThrow({ where: { id: created.link.id } });
  check("the token is not stored, only its hash", () => { assert.notEqual(row.tokenHash, token); assert.equal(JSON.stringify(row).includes(token), false); });

  response = await call("GET", `/api/public/review/${token}`, undefined, null);
  check("a reviewer with no account can open it", () => assert.equal(response.status, 200));
  const review = await response.json() as { page: { title: string }; link: { status: string }; frames: { draft: string; live: string } };
  check("it says which page and that it is waiting", () => { assert.equal(review.page.title, "Home"); assert.equal(review.link.status, "PENDING"); });

  response = await call("GET", review.frames.draft, undefined, null);
  const frameHtml = await response.text();
  const policy = response.headers.get("content-security-policy") ?? "";
  check("the draft frame shows the proposed words", () => assert.ok(frameHtml.includes("Proposed heading")));
  check("the frame runs in an origin of its own", () => { assert.match(policy, /sandbox/); assert.doesNotMatch(policy, /allow-same-origin/); });
  const live = await (await call("GET", review.frames.live, undefined, null)).text();
  check("the current-page frame shows what is live", () => assert.ok(live.includes("Original heading") && !live.includes("Proposed heading")));

  response = await call("POST", `/api/public/review/${token}/comments`, { name: "Ama", body: "Can the heading be shorter?", xPercent: 40, yPercent: 10, anchorLabel: "Proposed heading" }, null);
  check("the reviewer can comment, pinned to the page", () => assert.equal(response.status, 201));
  await response.text();
  response = await call("POST", `/api/public/review/${token}/comments`, { name: "", body: "nameless" }, null);
  check("a comment needs a name", () => assert.equal(response.status, 400));
  await response.text();

  const comments = await (await call("GET", `/api/website/pages/${page.id}/review-links/${created.link.id}/comments`)).json() as { comments: Array<{ id: string; body: string }> };
  check("the editor sees the comment", () => assert.equal(comments.comments[0]?.body, "Can the heading be shorter?"));
  response = await call("POST", `/api/website/pages/${page.id}/review-links/${created.link.id}/comments/${comments.comments[0]!.id}/resolve`, { resolved: true });
  check("and can mark it dealt with", () => assert.equal(response.status, 200));
  await response.text();

  response = await call("POST", `/api/public/review/${token}/decision`, { decision: "REQUEST_CHANGES", name: "Ama" }, null);
  check("asking for changes needs no more than a decision and a name", () => assert.equal(response.status, 200));
  await response.text();
  response = await call("POST", `/api/public/review/${token}/decision`, { decision: "APPROVE", name: "Kofi" }, null);
  check("an answer cannot be overturned by a second click or a forwarded link", () => assert.equal(response.status, 409));
  await response.text();

  const links = await (await call("GET", `/api/website/pages/${page.id}/review-links`)).json() as { links: Array<{ status: string; reviewerName: string | null; commentCount: number }> };
  check("the editor sees who answered and what", () => { assert.equal(links.links[0]?.status, "CHANGES_REQUESTED"); assert.equal(links.links[0]?.reviewerName, "Ama"); assert.equal(links.links[0]?.commentCount, 1); });
  const events = await prisma.siteAuditEvent.findMany({ where: { siteId: site.id, kind: { in: ["REVIEW_LINK_CREATED", "REVIEW_CHANGES_REQUESTED"] } } });
  check("both the link and the answer are in the activity log", () => assert.equal(events.length, 2));

  // A second link, then withdrawn and then expired.
  const second = await (await call("POST", `/api/website/pages/${page.id}/review-links`, {})).json() as { url: string; link: { id: string } };
  const secondToken = new URL(second.url).pathname.split("/")[2]!;
  response = await call("POST", `/api/website/pages/${page.id}/review-links/${second.link.id}/withdraw`);
  check("a link can be withdrawn", () => assert.equal(response.status, 200));
  await response.text();
  response = await call("GET", `/api/public/review/${secondToken}`, undefined, null);
  check("a withdrawn link stops working", () => assert.equal(response.status, 404));
  await response.text();

  const third = await (await call("POST", `/api/website/pages/${page.id}/review-links`, {})).json() as { url: string; link: { id: string } };
  await prisma.reviewLink.update({ where: { id: third.link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  response = await call("GET", `/api/public/review/${new URL(third.url).pathname.split("/")[2]}`, undefined, null);
  check("an expired link stops working", () => assert.equal(response.status, 404));
  await response.text();
  response = await call("GET", `/api/public/review/not-a-real-token-at-all-really`, undefined, null);
  check("a made-up token says nothing about why", () => assert.equal(response.status, 404));
  await response.text();

  // The draft moves on: the earlier answer is about earlier words.
  const moved = await call("PUT", `/api/website/pages/${page.id}/draft`, { ifRevision: 1, values: { [heading.id]: { value: "Shorter heading" } } });
  assert.equal(moved.status, 200, await moved.clone().text());
  const after = await (await call("GET", `/api/website/pages/${page.id}/review-links`)).json() as { links: Array<{ id: string; stale: boolean }> };
  check("a link made before the draft changed says so", () => assert.equal(after.links.find((link) => link.id === created.link.id)?.stale, true));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.site.deleteMany({ where: { id: site.id } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
  await prisma.accessRole.deleteMany({ where: { id: externalRole.id } });
  await prisma.$disconnect();
}

console.log(`\nwebsiteReviewLinks: ${passed} checks passed`);
