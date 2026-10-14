/**
 * Decoding text that was stored, not sent: a failure there is ours, never the
 * request's.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteStoredDecode.ts
 *
 * The error handler answers any `URIError` as "That address is not valid.", a
 * 400 that is never reported — right for an address somebody typed, wrong for
 * one we stored. `findLinkedDemo` decoded the `/demos/<slug>` in a site's saved
 * `publicUrl` with nothing around it, and it runs every time a page is opened
 * in the editor, so one stray `%` in an imported address kept every page of
 * that site shut behind a 400 that blamed the person and reached nobody. A
 * slug that does not decode is now no
 * slug, and the demo is found by its brief as any imported page's is. A pasted
 * Maps link whose place name holds a bare `%` ("100% Dental") is the same
 * decode in quick capture, and keeps the words as written.
 *
 * Needs Postgres and nothing else. Every row it makes is removed at the end.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) || !/(test|check|editor)/i.test(databaseUrl.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}

const { prisma } = await import("../src/lib/prisma.js");
const { findLinkedDemo } = await import("../src/services/websitePageContext.js");
const { planCapture } = await import("../src/services/quickCapture.js");

let passed = 0;
const failures: string[] = [];
async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}

const mark = `storeddecode-${randomUUID().slice(0, 8)}`;
const siteId = `${mark}-site`;
const pageId = `${mark}-page`;
const demoIds: string[] = [];
const demo = async (slug: string, brief: Record<string, string> | null) => {
  const made = await prisma.demo.create({ data: { slug, title: slug, businessName: "Stored Decode", html: "<p>demo</p>", ...(brief ? { brief } : {}) }, select: { id: true, slug: true } });
  demoIds.push(made.id);
  return made;
};

try {
  console.log("\nThe demo a site's stored address names");
  const byBrief = await demo(`${mark}-by-brief`, { siteId });
  const accented = await demo(`${mark}-café`, null);
  await check("a slug that does not decode is no slug: the demo is found by its brief instead", async () => {
    const found = await findLinkedDemo({ id: siteId, publicUrl: `https://hosted.example.test/demos/${mark}-%zz` }, pageId);
    assert.deepEqual(found, byBrief);
  });
  await check("and with no brief to fall back on, it is simply not linked", async () => {
    assert.equal(await findLinkedDemo({ id: `${mark}-nobody`, publicUrl: "https://hosted.example.test/demos/100%" }, pageId), null);
  });
  await check("a slug that decodes is still matched by its decoded spelling", async () => {
    const found = await findLinkedDemo({ id: `${mark}-nobody`, publicUrl: `https://hosted.example.test/demos/${encodeURIComponent(accented.slug)}?ref=x` }, pageId);
    assert.deepEqual(found, accented);
  });

  console.log("\nA pasted Maps link");
  await check("a place name with a bare % keeps its words as written", () => {
    const plan = planCapture("https://www.google.com/maps/place/100%+Dental+Kumasi/@6.6,-1.6,15z");
    assert.deepEqual(plan.items.map((item) => [item.kind, item.value]), [["MAPS_SEARCH", "100% Dental Kumasi"]]);
  });
  await check("an encoded place name is still decoded", () => {
    const plan = planCapture("https://www.google.com/maps/place/Caf%C3%A9+Accra/@5.6,-0.2,15z");
    assert.deepEqual(plan.items.map((item) => [item.kind, item.value]), [["MAPS_SEARCH", "Café Accra"]]);
  });
} finally {
  await prisma.demo.deleteMany({ where: { id: { in: demoIds } } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
