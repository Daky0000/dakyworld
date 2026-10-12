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
 * The flood limit is counted in the shared rate-limit table, as in production,
 * and a site's managers are emailed only so many messages a day — what is
 * asserted there is the mail a local SMTP server actually received.
 *
 * Needs an isolated local database (name containing test, check or editor).
 *   npx tsx checks/websiteForms.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteForms needs an isolated local test/editor database.");
}
process.env.DEV_NO_AUTH = "false";
process.env.WEBSITE_HOST_DOMAIN = "sites.formscheck.test";
// The production path: flood counts in Postgres, shared by every replica.
process.env.RATE_LIMIT_SHARED = "true";
const { prisma } = await import("../src/lib/prisma.js");
const { routeFormsToInbox, FORM_ENDPOINT, dailyFormEmailCap } = await import("../src/services/websiteForms.js");
const { rateBucketKey } = await import("../src/lib/rateLimitStore.js");
const { clearSettingsCache } = await import("../src/lib/settings.js");
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

console.log("\nHow many a day are emailed");
const savedCap = process.env.WEBSITE_FORM_EMAILS_PER_DAY;
delete process.env.WEBSITE_FORM_EMAILS_PER_DAY;
check("fifty a day unless told otherwise", () => assert.equal(dailyFormEmailCap(), 50));
for (const nonsense of ["", "0", "-4", "2.5", "lots"]) {
  process.env.WEBSITE_FORM_EMAILS_PER_DAY = nonsense;
  check(`a nonsense setting (${JSON.stringify(nonsense)}) keeps fifty`, () => assert.equal(dailyFormEmailCap(), 50));
}
process.env.WEBSITE_FORM_EMAILS_PER_DAY = "3";
check("WEBSITE_FORM_EMAILS_PER_DAY overrides it", () => assert.equal(dailyFormEmailCap(), 3));
delete process.env.WEBSITE_FORM_EMAILS_PER_DAY;

/**
 * A mail server that accepts everything and keeps it, so the email ceiling is
 * judged on what was delivered rather than on what the code meant to send.
 */
type Delivered = { to: string[]; data: string };
function smtpSink() {
  const delivered: Delivered[] = [];
  const sink = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let to: string[] = [];
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 sink.formscheck.test ESMTP");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          delivered.push({ to, data: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5);
          inData = false;
          to = [];
          reply("250 2.0.0 queued");
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at === -1) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.formscheck.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (verb === "AUTH") reply("235 2.7.0 accepted");
        else if (verb === "RCPT") { to.push(line.slice(line.indexOf(":") + 1).replace(/[<>\s]/g, "").toLowerCase()); reply("250 2.1.5 ok"); }
        else if (verb === "DATA") { inData = true; reply("354 go ahead"); }
        else if (verb === "QUIT") { reply("221 bye"); socket.end(); return; }
        else reply("250 ok");
      }
    });
  });
  return { sink, delivered };
}
/** Quoted-printable, undone well enough to find a link or a sentence in it. */
const readable = (raw: string) => raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

console.log("\nPosting to it");
const mark = `formscheck-${randomUUID().slice(0, 8)}`;
const siteIds: string[] = [];
const userIds: string[] = [];
const userEmails: string[] = [];
const formAddresses = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.9", "10.0.1.1", "10.0.1.2", "10.0.1.3", "10.0.1.4", "10.0.1.5"];
const MAIL_ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM_EMAIL", "MAIL_TRANSPORT"] as const;
const savedMail = Object.fromEntries(MAIL_ENV.map((key) => [key, process.env[key]]));
let server: http.Server | undefined;
let mailSink: net.Server | undefined;
try {
  const role = await prisma.accessRole.create({ data: { key: mark, name: mark, external: true, permissions: [] } });
  const [manager, editor] = await Promise.all(["manager", "editor"].map((name) => prisma.user.create({ data: { email: `${mark}-${name}@example.test`, name, accessRoleId: role.id } })));
  userIds.push(manager.id, editor.id);
  userEmails.push(manager.email, editor.email);
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
  check("a flood from one address is slowed down: eight in ten minutes, then refused", () => assert.equal(limited, 2));
  const floodBucket = await prisma.rateLimitBucket.findUnique({ where: { id: rateBucketKey("website-forms", `${site.id}:10.0.0.9`) } });
  check("and counted in the shared table, so a second replica refuses it too", () => assert.equal(floodBucket?.count, 9));
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

  console.log("\nThe day's email ceiling");
  // Mail goes to a local server from here on. Settings read the environment
  // first, so nothing in the database's mail configuration is touched.
  const { sink, delivered } = smtpSink();
  mailSink = sink;
  sink.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => sink.once("listening", resolve));
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String((sink.address() as AddressInfo).port), SMTP_USER: "forms@formscheck.test",
    SMTP_PASSWORD: "sink", MAIL_FROM_EMAIL: "forms@formscheck.test", MAIL_TRANSPORT: "SMTP",
  });
  clearSettingsCache();
  process.env.WEBSITE_FORM_EMAILS_PER_DAY = "3";

  const capManager = await prisma.user.create({ data: { email: `${mark}-cap@example.test`, name: "Cap Manager", accessRoleId: role.id } });
  userIds.push(capManager.id);
  userEmails.push(capManager.email);
  const capSite = await prisma.site.create({ data: { slug: `${mark}-cap`, name: "Forms Cap Bakery", publicUrl: "https://cap.example.test", hostedEnabled: true, hostedSlug: `${mark}-cap` } });
  siteIds.push(capSite.id);
  await prisma.siteMember.create({ data: { siteId: capSite.id, userId: capManager.id, role: "MANAGER" } });
  const capHost = `${mark}-cap.sites.formscheck.test`;

  // From the address that was just refused on the other site; and a robot's,
  // which is kept as spam and must not use up the day's emails.
  response = await call("POST", FORM_ENDPOINT, { host: capHost, type: urlencoded, ip: "10.0.0.9", body: form({ message: "buy now", _gotcha: "x" }) });
  check("an address limited on one site may still write to another", () => assert.equal(response.status, 200));
  for (let i = 1; i <= 5; i += 1) {
    response = await call("POST", FORM_ENDPOINT, { host: capHost, type: urlencoded, ip: `10.0.1.${i}`, body: form({ name: `Customer ${i}`, message: `Order ${i}` }) });
    assert.equal(response.status, 200, `message ${i} was refused`);
  }
  const toCap = () => delivered.filter((mail) => mail.to.includes(capManager.email.toLowerCase()));
  const deadline = Date.now() + 30_000;
  while (toCap().length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  // Long enough for a fifth to arrive if anything were going to send one.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const kept = await prisma.formSubmission.findMany({ where: { siteId: capSite.id, spam: false }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const mails = toCap().map((mail) => readable(mail.data));
  const mentions = (id: string) => mails.filter((mail) => mail.includes(`message=${id}`)).length;
  check("every message is kept, past the ceiling as well", () => assert.equal(kept.length, 5));
  check("the manager got four emails for five messages: three messages and one notice", () => assert.equal(mails.length, 4));
  check("the first three messages were each emailed once", () => assert.deepEqual(kept.slice(0, 3).map((row) => mentions(row.id)), [1, 1, 1]));
  check("the fourth and fifth were not emailed", () => assert.deepEqual(kept.slice(3).map((row) => mentions(row.id)), [0, 0]));
  const notices = mails.filter((mail) => mail.includes("any more that arrive today are waiting in your inbox"));
  check("one notice says the rest of the day's messages are in the inbox", () => {
    assert.equal(notices.length, 1);
    assert.ok(notices[0]!.includes(`/website/inbox?site=${capSite.id}`), "and links to it");
  });
  const ledger = await prisma.mailDelivery.findMany({ where: { toEmail: capManager.email }, select: { category: true, status: true } });
  check("the mail ledger agrees", () => assert.deepEqual(
    ledger.map((row) => `${row.category}:${row.status}`).sort(),
    ["website:form-message:SENT", "website:form-message:SENT", "website:form-message:SENT", "website:form-messages-held:SENT"],
  ));
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (mailSink) await new Promise<void>((resolve) => mailSink!.close(() => resolve()));
  for (const key of MAIL_ENV) {
    if (savedMail[key] === undefined) delete process.env[key];
    else process.env[key] = savedMail[key];
  }
  if (savedCap === undefined) delete process.env.WEBSITE_FORM_EMAILS_PER_DAY;
  else process.env.WEBSITE_FORM_EMAILS_PER_DAY = savedCap;
  await prisma.rateLimitBucket.deleteMany({ where: { id: { in: siteIds.flatMap((siteId) => formAddresses.map((ip) => rateBucketKey("website-forms", `${siteId}:${ip}`))) } } });
  await prisma.mailDelivery.deleteMany({ where: { toEmail: { in: userEmails } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.accessRole.deleteMany({ where: { key: mark } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
