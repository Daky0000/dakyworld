/**
 * Scheduled publishing, end to end on a hosted page: schedule over HTTP, let
 * the worker's tick publish it through the real publish command, then put it
 * back on time — and refuse a draft that moved after it was scheduled.
 * services/websitePublishScheduler.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteScheduledPublish needs an isolated local test/editor database.");
}
process.env.DEV_NO_AUTH = "false";

const { prisma } = await import("../src/lib/prisma.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { createSession } = await import("../src/lib/session.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { tickScheduledPublishes } = await import("../src/services/websitePublishScheduler.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };

await ensureSystemRoles();
const mark = `schedulecheck-${randomUUID()}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const owner = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Schedule check", role: "OWNER", accessRoleId: ownerRole.id } });
const cookie = `dw_session=${await createSession(owner.id)}`;

const app = express();
app.use(express.json());
app.use(attachUser);
app.use("/api", requireAuth);
app.use("/api/website", websiteRouter);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

const original = '<!doctype html><html><head><title>Sale</title></head><body><main><h1>Normal prices</h1><p>Welcome.</p></main></body></html>';
const siteIds: string[] = [];

async function hostedPage(name: string) {
  const created = await call("POST", "/api/website/sites", { name: `${mark}-${name}`, publicUrl: "https://example.test", html: original });
  assert.equal(created.status, 201, await created.clone().text());
  const site = await created.json() as { id: string; pageId: string };
  siteIds.push(site.id);
  // Publish once so there is a version to come back to.
  const first = await call("POST", `/api/website/pages/${site.pageId}/publish`, {});
  assert.equal(first.status, 200, await first.clone().text());
  const read = await (await call("GET", `/api/website/pages/${site.pageId}`)).json() as { draft: { revision: number }; sections: Array<{ fields: Array<{ id: string; value: string }> }> };
  const heading = read.sections.flatMap((section) => section.fields).find((field) => field.value === "Normal prices")!;
  const saved = await call("PUT", `/api/website/pages/${site.pageId}/draft`, { ifRevision: read.draft.revision, values: { [heading.id]: { value: "Half price this week" } } });
  assert.equal(saved.status, 200, await saved.clone().text());
  return { ...site, heading, revision: ((await saved.json()) as { revision: number }).revision };
}

try {
  const promo = await hostedPage("promo");
  const soon = new Date(Date.now() + 60_000);
  const later = new Date(Date.now() + 120_000);

  let response = await call("POST", `/api/website/pages/${promo.pageId}/schedule`, { scheduledAt: new Date(Date.now() - 3_600_000).toISOString() });
  check("a time in the past is refused in words", () => assert.equal(response.status, 400));
  await response.text();
  response = await call("POST", `/api/website/pages/${promo.pageId}/schedule`, { scheduledAt: soon.toISOString(), revertAt: later.toISOString(), notes: "Weekend sale" });
  check("a publish can be scheduled, with a time to put the page back", () => assert.equal(response.status, 201));
  const job = (await response.json() as { job: { id: string; status: string } }).job;
  response = await call("POST", `/api/website/pages/${promo.pageId}/schedule`, { scheduledAt: soon.toISOString() });
  check("a second schedule for the same page is refused", () => assert.equal(response.status, 409));
  await response.text();

  let tick = await tickScheduledPublishes(new Date(Date.now() + 30_000));
  check("nothing goes out early", () => assert.equal(tick.executed, 0));
  tick = await tickScheduledPublishes(new Date(soon.getTime() + 1000));
  check("the tick publishes what is due", () => assert.equal(tick.executed, 1));
  let page = await prisma.sitePage.findUniqueOrThrow({ where: { id: promo.pageId } });
  check("the scheduled words are what visitors now get", () => assert.ok(page.publishedHtml?.includes("Half price this week")));
  check("and the draft that went out is cleared", () => assert.equal(page.draft, null));
  let row = await prisma.scheduledPublish.findUniqueOrThrow({ where: { id: job.id } });
  check("the job waits to put the page back", () => { assert.equal(row.status, "ACTIVE_TEMPORARY"); assert.ok(row.revertToVersionId); });
  tick = await tickScheduledPublishes(new Date(soon.getTime() + 2000));
  check("a second tick does not publish it twice", () => assert.equal(tick.executed, 0));

  tick = await tickScheduledPublishes(new Date(later.getTime() + 1000));
  check("on time, the page is put back", () => assert.equal(tick.reverted, 1));
  page = await prisma.sitePage.findUniqueOrThrow({ where: { id: promo.pageId } });
  check("visitors get the original words again", () => assert.ok(page.publishedHtml?.includes("Normal prices") && !page.publishedHtml.includes("Half price")));
  row = await prisma.scheduledPublish.findUniqueOrThrow({ where: { id: job.id } });
  check("and the job says so", () => assert.equal(row.status, "REVERTED"));
  const versions = await prisma.sitePageVersion.count({ where: { pageId: promo.pageId } });
  check("each step left a version behind", () => assert.equal(versions, 3));

  // A draft that moves after it was scheduled is not published.
  const moved = await hostedPage("moved");
  response = await call("POST", `/api/website/pages/${moved.pageId}/schedule`, { scheduledAt: soon.toISOString() });
  const movedJob = (await response.json() as { job: { id: string } }).job;
  const again = await call("PUT", `/api/website/pages/${moved.pageId}/draft`, { ifRevision: moved.revision, values: { [moved.heading.id]: { value: "Something nobody scheduled" } } });
  assert.equal(again.status, 200, await again.clone().text());
  await tickScheduledPublishes(new Date(soon.getTime() + 1000));
  const failed = await prisma.scheduledPublish.findUniqueOrThrow({ where: { id: movedJob.id } });
  const movedPage = await prisma.sitePage.findUniqueOrThrow({ where: { id: moved.pageId } });
  check("a draft changed after scheduling is not published", () => { assert.equal(failed.status, "FAILED"); assert.match(failed.error ?? "", /changed after it was scheduled/); assert.ok(!movedPage.publishedHtml?.includes("nobody scheduled")); });

  // Cancelling.
  const cancel = await hostedPage("cancel");
  response = await call("POST", `/api/website/pages/${cancel.pageId}/schedule`, { scheduledAt: soon.toISOString() });
  const cancelJob = (await response.json() as { job: { id: string } }).job;
  response = await call("DELETE", `/api/website/pages/${cancel.pageId}/schedule/${cancelJob.id}`);
  check("a scheduled publish can be cancelled", () => assert.equal(response.status, 200));
  await response.text();
  tick = await tickScheduledPublishes(new Date(soon.getTime() + 1000));
  check("and a cancelled one never runs", () => assert.equal(tick.executed, 0));
  const list = await (await call("GET", `/api/website/pages/${cancel.pageId}/schedule`)).json() as { jobs: Array<{ status: string }> };
  check("the page lists what was scheduled and what became of it", () => assert.equal(list.jobs[0]?.status, "CANCELLED"));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });
  await prisma.$disconnect();
}

console.log(`\nwebsiteScheduledPublish: ${passed} checks passed`);
