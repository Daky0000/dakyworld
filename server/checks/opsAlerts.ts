/**
 * npx tsx checks/opsAlerts.ts        (no database: a fake SMTP server and stand-ins)
 *
 * What reaches the Owner by email without anybody opening a screen: a website
 * enquiry, a run of server errors, and a crashing process. Added on the night of
 * the 9 Oct 2026 go-live audit, after a five-hour worker crash loop nobody heard
 * about and a contact form whose enquiries landed in the CRM and nowhere else.
 *
 * The mail goes through the real `sendMail` to a fake SMTP server on localhost,
 * so what is asserted is what would have left the building. The lease table is
 * an in-memory stand-in for `acquireLease`'s one query.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---------------------------------------------------------- fake SMTP -- */
let refuse = false;
const received: string[] = [];
const server = net.createServer((socket) => {
  socket.write("220 fake ESMTP\r\n");
  let data = false;
  let body = "";
  socket.on("data", (chunk) => {
    for (const line of chunk.toString().split("\r\n")) {
      if (data) {
        if (line === ".") { data = false; received.push(body); body = ""; socket.write("250 2.0.0 Ok: queued\r\n"); }
        else body += `${line}\n`;
        continue;
      }
      if (!line) continue;
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd === "AUTH") socket.write("235 2.7.0 ok\r\n");
      else if (cmd === "MAIL") socket.write(refuse ? "550 5.7.1 refused\r\n" : "250 ok\r\n");
      else if (cmd === "RCPT") socket.write("250 ok\r\n");
      else if (cmd === "DATA") { data = true; socket.write("354 go\r\n"); }
      else if (cmd === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
      else socket.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;
Object.assign(process.env, {
  SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_SECURE: "false", SMTP_USER: "u@test.local", SMTP_PASSWORD: "p",
  MAIL_FROM_EMAIL: "u@test.local", MAIL_TRANSPORT: "SMTP", OWNER_EMAIL: "owner@test.local",
});
delete process.env.APP_URL;
const productionBefore = process.env.NODE_ENV;
process.env.NODE_ENV = "test";

/* ------------------------------------------------------- stand-ins -- */
const { prisma } = await import("../src/lib/prisma.js");
const stub = (target: object, name: string, fn: unknown) => Object.defineProperty(target, name, { value: fn, configurable: true });
stub(prisma.appSetting, "findUnique", async () => null);
stub(prisma.appSetting, "findMany", async () => []);
stub(prisma.appSetting, "findFirst", async () => null);
stub(prisma.mailDelivery, "create", async ({ data }: { data: unknown }) => data);
stub(prisma.mailDelivery, "deleteMany", async () => ({ count: 0 }));
const leases = new Map<string, { owner: string; expiresAt: number }>();
stub(prisma, "$queryRaw", async (_strings: TemplateStringsArray, key: string, owner: string, seconds: number) => {
  const now = Date.now();
  const held = leases.get(key);
  if (held && held.expiresAt > now && held.owner !== owner) return [];
  leases.set(key, { owner, expiresAt: now + Number(seconds) * 1000 });
  return [{ key }];
});
stub(prisma.serviceLease, "deleteMany", async ({ where }: { where: { key: string } }) => {
  const had = leases.delete(where.key);
  return { count: had ? 1 : 0 };
});

const { alertOwnerOnce, noteServerError, resetServerErrors, reportServerError, ERROR_BURST_THRESHOLD, ERROR_BURST_WINDOW_MS } = await import("../src/services/opsAlert.js");
const { enquiryEmail, notifyEnquiry, takeEnquiryAllowance, resetEnquiryAllowance, ENQUIRY_ALERTS_PER_HOUR } = await import("../src/services/enquiryAlert.js");
const { redactedRoute } = await import("../src/middleware/errorHandler.js");
const { reconcilePaystackPayments, RECONCILE_CHECKOUTS_FOR_MS } = await import("../src/services/paystackEvents.js");

let passed = 0;
async function check(name: string, test: () => Promise<void> | void) {
  await test();
  passed++;
  console.log(`  ok  ${name}`);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
/** The decoded body of the last message, headers included. Quoted-printable soft breaks are joined. */
const lastMail = () => (received.at(-1) ?? "").replace(/=\n/g, "").replace(/=3D/g, "=");

const enquiry = {
  leadId: "lead-1", created: true, name: "Ama Mensah", company: "Mensah Foods", email: "ama@mensahfoods.example",
  phone: "+233 20 000 0000", website: "https://mensahfoods.example", service: "Growth", message: "We need our ordering moved off WhatsApp.", viaAgent: false,
};

try {
  await check("an enquiry email names the person, carries their message and replies to them", () => {
    const mail = enquiryEmail(enquiry, "https://os.dakyx.com/leads?lead=lead-1");
    assert.equal(mail.subject, "New enquiry: Ama Mensah, Mensah Foods");
    assert.equal(mail.replyTo, "ama@mensahfoods.example");
    assert.equal(mail.category, "ops:enquiry");
    assert.ok(mail.paragraphs.includes("We need our ordering moved off WhatsApp."));
    assert.ok(mail.paragraphs.includes("Interested in: Growth"));
    assert.equal(mail.action?.url, "https://os.dakyx.com/leads?lead=lead-1");
  });

  await check("an assistant's enquiry says so, and one with no address says how to answer", () => {
    const mail = enquiryEmail({ ...enquiry, email: null, viaAgent: true, created: false }, "https://x/leads?lead=lead-1");
    assert.ok(mail.paragraphs.some((p) => p.includes("AI assistant")));
    assert.ok(mail.paragraphs[0]!.includes("written again"));
    assert.equal(mail.replyTo, null);
    assert.ok(mail.footnotes?.[0]?.includes("no email address"));
  });

  await check("notifyEnquiry sends it through the real mailer to OWNER_EMAIL", async () => {
    resetEnquiryAllowance();
    received.length = 0;
    await notifyEnquiry(enquiry);
    assert.equal(received.length, 1);
    const mail = lastMail();
    assert.match(mail, /^To: owner@test\.local$/m);
    assert.match(mail, /^Reply-To: ama@mensahfoods\.example$/m);
    assert.match(mail, /^Subject: New enquiry: Ama Mensah, Mensah Foods$/m);
    assert.ok(mail.includes("https://os.dakyx.com/leads?lead=lead-1"), "the email links to the lead");
  });

  await check("a mail server that refuses it does not throw into the form", async () => {
    refuse = true;
    try { await notifyEnquiry({ ...enquiry, leadId: "lead-2" }); } finally { refuse = false; }
  });

  await check(`no more than ${ENQUIRY_ALERTS_PER_HOUR} enquiry emails an hour`, () => {
    resetEnquiryAllowance();
    const start = Date.UTC(2026, 9, 10, 8, 0, 0);
    for (let i = 0; i < ENQUIRY_ALERTS_PER_HOUR; i++) assert.equal(takeEnquiryAllowance(start + i), true);
    assert.equal(takeEnquiryAllowance(start + 1000), false);
    assert.equal(takeEnquiryAllowance(start + 3_600_001), true, "the allowance comes back after an hour");
    resetEnquiryAllowance();
  });

  await check(`${ERROR_BURST_THRESHOLD} unexplained 500s inside ten minutes is a burst, and older ones fall out`, () => {
    resetServerErrors();
    const t = Date.UTC(2026, 9, 10, 9, 0, 0);
    const note = (at: number) => ({ at, reference: `r${at}`, route: "GET /api/x", line: "Error: boom" });
    for (let i = 0; i < ERROR_BURST_THRESHOLD - 1; i++) assert.equal(noteServerError(note(t + i)), null);
    assert.equal(noteServerError(note(t + ERROR_BURST_THRESHOLD))?.length, ERROR_BURST_THRESHOLD);
    resetServerErrors();
    for (let i = 0; i < ERROR_BURST_THRESHOLD - 1; i++) noteServerError(note(t + i));
    assert.equal(noteServerError(note(t + ERROR_BURST_WINDOW_MS + 10)), null, "errors from before the window do not count");
    resetServerErrors();
  });

  await check("a burst emails the Owner once, and the next errors in the hour stay quiet", async () => {
    resetServerErrors();
    leases.clear();
    received.length = 0;
    process.env.NODE_ENV = "production";
    try {
      for (let i = 0; i < ERROR_BURST_THRESHOLD + 3; i++) reportServerError({ at: Date.now(), reference: `ref${i}`, route: "POST /api/leads", line: "PrismaClientKnownRequestError: boom" });
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      process.env.NODE_ENV = "test";
    }
    assert.equal(received.length, 1, `one email, got ${received.length}`);
    assert.match(lastMail(), /^Subject: The OS answered \d+ requests with an error in ten minutes$/m);
    assert.ok(lastMail().includes("ref ref0"), "the references are listed so the log lines can be found");
    resetServerErrors();
  });

  await check("outside production a burst emails nobody", async () => {
    resetServerErrors();
    leases.clear();
    received.length = 0;
    for (let i = 0; i < ERROR_BURST_THRESHOLD; i++) reportServerError({ at: Date.now(), reference: `dev${i}`, route: "GET /x", line: "x" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received.length, 0);
    resetServerErrors();
  });

  await check("a failed alert frees its key, so the next one is not silenced for an hour", async () => {
    leases.clear();
    const message = { subject: "s", paragraphs: ["p"], category: "ops:test" };
    refuse = true;
    await assert.rejects(alertOwnerOnce("test-alert", 3600, message));
    refuse = false;
    assert.equal(await alertOwnerOnce("test-alert", 3600, message), "sent");
    assert.equal(await alertOwnerOnce("test-alert", 3600, message), "quiet");
  });

  await check("the route in an error email keeps ids and drops tokens and query strings", () => {
    assert.equal(redactedRoute("GET", "/api/leads/clx9a8b7c6d5e4f3g2h1i0j9k8?secret=1"), "GET /api/leads/clx9a8b7c6d5e4f3g2h1i0j9k8");
    assert.equal(redactedRoute("POST", "/api/public/review/AbCdEfGhIjKlMnOpQrStUvWxYz012345/decision"), "POST /api/public/review/:token/decision");
    assert.equal(redactedRoute("GET", "/api/x/0b7e4c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b"), "GET /api/x/:token");
  });

  await check("abandoned checkouts are asked about for three days, not for ever", async () => {
    const seen: { where: Record<string, any> | null } = { where: null };
    stub(prisma.paymentAttempt, "findMany", async (args: { where: Record<string, any> }) => { seen.where = args.where; return []; });
    const now = Date.UTC(2026, 9, 10, 10, 0, 0);
    await reconcilePaystackPayments(now);
    const where = seen.where;
    assert.ok(where, "the reconciler queried");
    assert.equal((where.createdAt.gte as Date).getTime(), now - RECONCILE_CHECKOUTS_FOR_MS);
    assert.equal(RECONCILE_CHECKOUTS_FOR_MS, 72 * 3_600_000);
    assert.deepEqual(where.state, { in: ["INITIALIZING", "PENDING"] });
  });

  await check("a crashing process still exits with 1, and says why first", () => {
    const dir = mkdtempSync(join(tmpdir(), "crash-check-"));
    try {
      const opsAlert = pathToFileURL(fileURLToPath(new URL("../src/services/opsAlert.ts", import.meta.url))).href;
      const script = join(dir, "crash.mjs");
      writeFileSync(script, `const { installCrashReporting } = await import(${JSON.stringify(opsAlert)});\ninstallCrashReporting("check");\nPromise.reject(new Error("deliberate"));\nsetTimeout(() => process.exit(7), 5000);\n`);
      const serverRoot = fileURLToPath(new URL("..", import.meta.url));
      const run = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: serverRoot, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://nobody@127.0.0.1:1/none" }, timeout: 60_000 });
      assert.equal(run.status, 1, `exit status ${run.status}; stderr: ${run.stderr.slice(-400)}`);
      assert.match(run.stderr, /\[crash\] check: unhandledRejection/);
      assert.match(run.stderr, /deliberate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`opsAlerts: ${passed} passed`);
} finally {
  if (productionBefore === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = productionBefore;
  server.close();
  await prisma.$disconnect().catch(() => {});
}
process.exit(0);
