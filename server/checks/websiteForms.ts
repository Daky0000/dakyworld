/**
 * Forms on hosted websites, and the inbox they post to (services/websiteForms.ts).
 *
 * Two halves. Which forms are pointed at the inbox — only one that posts
 * nowhere and looks like it carries a message; never a site search, never a
 * form that already posts somewhere real. And what happens to a post: kept,
 * a robot's marked as spam and not emailed, an empty one refused, files
 * refused politely, a flood slowed, a redirect only ever to the same site.
 * Then the inbox itself: managers read it, editors cannot.
 *
 * Needs an isolated local database (name containing test, check or editor).
 *   npx tsx checks/websiteForms.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteForms needs an isolated local test/editor database.");
}
process.env.DEV_NO_AUTH = "false";
process.env.WEBSITE_HOST_DOMAIN = "sites.formscheck.test";
const { prisma } = await import("../src/lib/prisma.js");
const { routeFormsToInbox, FORM_ENDPOINT } = await import("../src/services/websiteForms.js");
const { publicSiteHosting } = await import("../src/services/websiteHosting.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth, scopeExternal } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}

console.log("\nWhich forms go to the inbox");
const contact = `<p>Hi</p><form action="#" class="c"><input name="name"><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form><p>Bye</p>`;
const routed = routeFormsToInbox(contact, "/contact");
check("a contact form that posts nowhere is pointed at the inbox", () => {
  assert.match(routed, new RegExp(`<form action="${FORM_ENDPOINT.replace(/\//g, "\\/")}" method="post"\\s+class="c">`));
  assert.match(routed, /name="_page" value="\/contact"/);
  assert.match(routed, /name="_gotcha"/);
});
check("and nothing else on the page changes", () => assert.equal(routed.replace(/<form[^>]*>/, "").replace(/<input type="hidden"[^>]*>|<div aria-hidden="true"[^>]*><input type="text" name="_gotcha"[^>]*><\/div>/g, ""), contact.replace(/<form[^>]*>/, "")));
const external = `<form action="https://formspree.io/f/abc" method="post"><textarea name="message"></textarea></form>`;
check("a form that already posts somewhere real is left alone", () => assert.equal(routeFormsToInbox(external, "/"), external));
const search = `<form action="" role="search"><input name="q"><button>Search</button></form>`;
check("a site search is left alone", () => assert.equal(routeFormsToInbox(search, "/"), search));
const searchType = `<form><input type="search" name="s"></form>`;
check("so is a form with a search box", () => assert.equal(routeFormsToInbox(searchType, "/"), searchType));
const filter = `<form method="get"><select name="sort"><option>new</option></select></form>`;
check("and a GET form that is not a message", () => assert.equal(routeFormsToInbox(filter, "/"), filter));
const mailto = `<form action="mailto:hello@example.test" method="post" enctype="text/plain"><input name="email"></form>`;
const mailtoRouted = routeFormsToInbox(mailto, "/");
check("a mailto: form — which opens somebody's mail program, or nothing — goes to the inbox", () => {
  assert.match(mailtoRouted, /action="\/__dakyx\/forms" method="post"/);
  assert.doesNotMatch(mailtoRouted, /mailto:|enctype/);
});

console.log("\nPosting to it");
const mark = `formscheck-${randomUUID().slice(0, 8)}`;
const siteIds: string[] = [];
const userIds: string[] = [];
let server: http.Server | undefined;
try {
  const role = await prisma.accessRole.create({ data: { key: mark, name: mark, external: true, permissions: [] } });
  const [manager, editor] = await Promise.all(["manager", "editor"].map((name) => prisma.user.create({ data: { email: `${mark}-${name}@example.test`, name, accessRoleId: role.id } })));
  userIds.push(manager.id, editor.id);
  const site = await prisma.site.create({
    data: {
      slug: mark, name: "Forms Check Bakery", publicUrl: "https://example.test", hostedEnabled: true, hostedSlug: mark,
      pages: { create: { title: "Contact", path: "/contact", filePath: "contact.html", status: "LIVE", publishedHtml: `<html><body>${contact}</body></html>` } },
    },
  });
  siteIds.push(site.id);
  await prisma.siteMember.createMany({ data: [{ siteId: site.id, userId: manager.id, role: "MANAGER" }, { siteId: site.id, userId: editor.id, role: "EDITOR" }] });

  const app = express();
  app.set("trust proxy", true);
  app.use(publicSiteHosting());
  app.use(express.json());
  app.use("/api", attachUser, requireAuth, scopeExternal);
  app.use("/api/website", websiteRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { status?: number }).status ?? 500).json({ error: (error as Error).message });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const host = `${mark}.sites.formscheck.test`;

  function call(method: string, path: string, options: { host?: string; body?: string; type?: string; ip?: string; cookie?: string } = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, method, path, headers: {
        Host: options.host ?? "127.0.0.1",
        ...(options.type ? { "Content-Type": options.type } : {}),
        ...(options.ip ? { "X-Forwarded-For": options.ip } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
      } }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
      });
      request.on("error", reject);
      if (options.body) request.write(options.body);
      request.end();
    });
  }
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const urlencoded = "application/x-www-form-urlencoded";

  const served = await call("GET", "/contact", { host });
  check("the published contact page is served with its form pointed at the inbox", () => { assert.equal(served.status, 200); assert.match(served.text, /action="\/__dakyx\/forms"/); });

  let response = await call("POST", FORM_ENDPOINT, { host, type: urlencoded, ip: "10.0.0.1", body: form({ name: "Esi", email: "esi@example.test", message: "Do you bake on Sundays?", _page: "/contact", _gotcha: "" }) });
  check("a message is received and thanked", () => { assert.equal(response.status, 200); assert.match(response.text, /Thank you/); });
  const stored = await prisma.formSubmission.findFirst({ where: { siteId: site.id, spam: false } });
  check("and kept with what was typed, the page, and the reply address", () => {
    assert.ok(stored);
    assert.deepEqual(stored!.fields, { name: "Esi", email: "esi@example.test", message: "Do you bake on Sundays?" });
    assert.equal(stored!.pagePath, "/contact");
    assert.equal(stored!.email, "esi@example.test");
  });

  response = await call("POST", FORM_ENDPOINT, { host, type: urlencoded, ip: "10.0.0.2", body: form({ message: "cheap pills", _gotcha: "http://spam.example" }) });
  const spam = await prisma.formSubmission.findFirst({ where: { siteId: site.id, spam: true } });
  check("a robot that fills the hidden field is told the same as a person", () => assert.equal(response.status, 200));
  check("but its message is filed as spam", () => assert.ok(spam));

  response = await call("POST", FORM_ENDPOINT, { host, type: urlencoded, ip: "10.0.0.3", body: form({ name: "", message: " " }) });
  check("an empty form is refused, not stored", () => assert.equal(response.status, 400));
  response = await call("POST", FORM_ENDPOINT, { host, type: "multipart/form-data; boundary=x", ip: "10.0.0.3", body: "--x--" });
  check("a form with files is refused with a reason", () => { assert.equal(response.status, 415); assert.match(response.text, /cannot send files/); });

  response = await call("POST", FORM_ENDPOINT, { host, type: urlencoded, ip: "10.0.0.4", body: form({ message: "hello", _next: "/thanks" }) });
  check("a form can send people to its own thank-you page", () => { assert.equal(response.status, 303); assert.equal(response.headers.location, "/thanks"); });
  response = await call("POST", FORM_ENDPOINT, { host, type: urlencoded, ip: "10.0.0.4", body: form({ message: "hello", _next: "https://evil.example/" }) });
  check("but never to somewhere else", () => assert.equal(response.status, 200));

  let limited = 0;
  for (let i = 0; i < 10; i += 1) {
    const each = await call("POST", FORM_ENDPOINT, { host, type: urlencoded, ip: "10.0.0.9", body: form({ message: `flood ${i}` }) });
    if (each.status === 429) limited += 1;
  }
  check("a flood from one address is slowed down", () => assert.ok(limited >= 1, `limited ${limited}`));
  response = await call("POST", FORM_ENDPOINT, { host: "127.0.0.1", type: urlencoded, body: form({ message: "x" }) });
  check("the app's own host has no form endpoint", () => assert.notEqual(response.status, 200));

  console.log("\nThe inbox");
  const [managerToken, editorToken] = await Promise.all([createSession(manager.id), createSession(editor.id)]);
  response = await call("GET", `/api/website/sites/${site.id}/forms`, { cookie: `dw_session=${managerToken}` });
  const inbox = JSON.parse(response.text) as { messages: Array<{ id: string; readAt: string | null }>; unread: number; spam: number };
  check("a manager reads the inbox", () => { assert.equal(response.status, 200); assert.ok(inbox.messages.length >= 2); assert.ok(inbox.unread >= 2); assert.equal(inbox.spam, 1); });
  response = await call("GET", `/api/website/sites/${site.id}/forms`, { cookie: `dw_session=${editorToken}` });
  check("an editor cannot — messages carry people's contact details", () => assert.equal(response.status, 403));

  const first = inbox.messages[0]!;
  const read = await new Promise<number>((resolve, reject) => {
    const body = JSON.stringify({ read: true });
    const request = http.request({ host: "127.0.0.1", port, method: "PATCH", path: `/api/website/sites/${site.id}/forms/${first.id}`, headers: { Host: "127.0.0.1", Cookie: `dw_session=${managerToken}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    request.on("error", reject); request.write(body); request.end();
  });
  const afterRead = await prisma.formSubmission.findUniqueOrThrow({ where: { id: first.id } });
  check("opening one marks it read", () => { assert.equal(read, 200); assert.ok(afterRead.readAt); });
  response = await call("DELETE", `/api/website/sites/${site.id}/forms/${first.id}`, { cookie: `dw_session=${managerToken}` });
  const gone = await prisma.formSubmission.count({ where: { id: first.id } });
  check("a manager can delete one, for good", () => { assert.equal(response.status, 204); assert.equal(gone, 0); });
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.accessRole.deleteMany({ where: { key: mark } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
