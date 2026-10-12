/**
 * npx tsx checks/monitoring.ts        (no network, no Sentry account; the database only to raise one real Prisma error)
 *
 * Error tracking: what reaches Sentry, and what never does. Added with Sentry
 * itself, before launch, because a 500 used to reach nobody and the browser's
 * ErrorBoundary reported nowhere.
 *
 * Sentry's own client runs here, with a transport that keeps each envelope
 * instead of posting it, so what is asserted is the bytes that would have left
 * the building: cookies, auth headers, request bodies and the tokens and
 * addresses in links never do, and a refusal the handler answers with a
 * sentence is never reported while an accident is. The privacy half is run
 * twice — once as configured, and once with v11's collect-everything defaults,
 * with a control proving those defaults really do collect — so the scrubber is
 * proved to stand on its own. The browser's copy of the scrubbers is run over
 * the same table as the server's.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";

// instrument.ts starts Sentry when it is imported and reads .env first. A
// developer's .env must not turn that into real traffic from a check.
process.env.SENTRY_DSN = "off";
const Sentry = await import("@sentry/node");
const server = await import("../src/instrument.js");
const browser = await import("../client/src/lib/monitoring.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { WebsiteError } = await import("../src/services/website/site.js");
const { ApifyError } = await import("../src/lib/apify.js");
const { securityHeaders } = await import("../src/middleware/security.js");
const { prisma } = await import("../src/lib/prisma.js");

let passed = 0;
async function check(name: string, test: () => Promise<void> | void) {
  await test();
  passed++;
  console.log(`  ok  ${name}`);
}

/* ------------------------------------------------- the fake far end -- */

type Envelope = { raw: string; events: Array<Record<string, any>> };
const envelopes: Envelope[] = [];
let refuse = false;

function parseEnvelope(raw: string): Envelope {
  const lines = raw.split("\n").filter(Boolean);
  const events: Array<Record<string, any>> = [];
  for (let i = 1; i < lines.length; i += 2) {
    const header = JSON.parse(lines[i]!) as { type?: string };
    if (header.type === "event") events.push(JSON.parse(lines[i + 1]!));
  }
  return { raw, events };
}

const transport = (options: Parameters<typeof Sentry.createTransport>[0]) =>
  Sentry.createTransport(options, async (request) => {
    if (refuse) throw new Error("connect ECONNREFUSED o4511716208869376.ingest.de.sentry.io:443");
    envelopes.push(parseEnvelope(typeof request.body === "string" ? request.body : Buffer.from(request.body).toString("utf8")));
    return { statusCode: 200 };
  });
const events = () => envelopes.flatMap((envelope) => envelope.events);

/* ---------------------------------------------------- what is secret -- */

// Every one of these must be absent from anything sent.
const SECRETS = {
  session: "s3ss10n-c00kie-value",
  // A cookie whose name is on none of Sentry's own lists, so its defaults keep it.
  cookie: "c00kie-n0t-on-sentrys-list",
  bearer: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
  token: "t0ps3cret-set-password",
  email: "ama@mensahfoods.example",
  page: "<h1>Mensah Foods customer page</h1>",
  enquiry: "Please move our ordering off WhatsApp",
  paystack: "sk_live_d0n0tsend",
  signature: "paystack-hmac-sig",
};
function assertNothingSecret(raw: string, where: string) {
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!raw.includes(value), `${where}: the ${name} left the building`);
  assert.ok(!raw.includes("ama%40mensahfoods"), `${where}: the encoded email left the building`);
}

const REVIEW_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const ROW_ID = "clx9a8b7c6d5e4f3g2h1i0j9k8";

/** An event carrying everything an SDK default could ever attach. */
function everythingEvent(): Record<string, any> {
  return {
    message: `Boom at /reset-password?token=${SECRETS.token}`,
    transaction: `POST /api/public/review/${REVIEW_TOKEN}/decision`,
    level: "error",
    exception: {
      values: [{
        type: "TypeError",
        value: `Cannot read properties of undefined (reading 'html') for ${SECRETS.email}`,
        stacktrace: { frames: [{ filename: "/app/dist/routes/website.js", function: "publishPage", lineno: 412, vars: { body: SECRETS.enquiry } }] },
      }],
    },
    request: {
      method: "POST",
      url: `https://os.dakyx.com/api/website/pages/${ROW_ID}/publish?token=${SECRETS.token}&email=ama%40mensahfoods.example#step-2`,
      query_string: `token=${SECRETS.token}`,
      cookies: { "__Host-dw_session": SECRETS.session, dw_seen: SECRETS.cookie },
      headers: {
        authorization: SECRETS.bearer,
        cookie: `__Host-dw_session=${SECRETS.session}; dw_seen=${SECRETS.cookie}`,
        "set-cookie": `__Host-dw_session=${SECRETS.session}`,
        "x-paystack-signature": SECRETS.signature,
        "user-agent": "Mozilla/5.0 (Macintosh)",
        referer: `https://os.dakyx.com/set-password?token=${SECRETS.token}&email=${SECRETS.email}`,
      },
      data: { html: SECRETS.page, message: SECRETS.enquiry },
      env: { REMOTE_ADDR: "203.0.113.9" },
    },
    user: { id: "user-1", ip_address: "203.0.113.9", email: SECRETS.email, username: "ama" },
    tags: { route: `POST /api/website/pages/${ROW_ID}/publish`, reference: "k3x9q2mf" },
    breadcrumbs: [
      { category: "console", level: "log", message: `enquiry from ${SECRETS.email}: ${SECRETS.enquiry}` },
      {
        category: "http",
        type: "http",
        data: {
          url: `https://api.paystack.co/transaction/initialize?key=${SECRETS.paystack}`,
          "url.query": `key=${SECRETS.paystack}`,
          "url.fragment": "x",
          "http.request.method": "POST",
          status_code: 502,
        },
      },
      { category: "navigation", data: { from: `/set-password?token=${SECRETS.token}&email=${SECRETS.email}`, to: "/leads" } },
    ],
  };
}

try {
  /* ------------------------------------------------ on, off, and how -- */

  await check("off in development and in the checks harness, on in production, off when told", () => {
    assert.equal(server.monitoringOptions({}), null, "no NODE_ENV, no DSN: nothing is sent");
    assert.equal(server.monitoringOptions({ NODE_ENV: "development" }), null);
    assert.equal(server.monitoringOptions({ NODE_ENV: "test", SENTRY_DSN: "  " }), null, "a blank DSN is not a DSN");
    assert.equal(server.monitoringOptions({ NODE_ENV: "production" })?.dsn, server.SERVER_DSN);
    assert.equal(server.monitoringOptions({ NODE_ENV: "production", SENTRY_DSN: "off" }), null);
    assert.equal(server.monitoringOptions({ NODE_ENV: "production", SENTRY_DSN: "OFF" }), null);
    const elsewhere = "https://abc@o1.ingest.example.invalid/2";
    assert.equal(server.monitoringOptions({ NODE_ENV: "development", SENTRY_DSN: elsewhere })?.dsn, elsewhere, "an explicit DSN reports from anywhere");
  });

  await check("environment, release, service and sampling come from Railway's variables", () => {
    const options = server.monitoringOptions({ NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_GIT_COMMIT_SHA: "34c9540c", SERVICE_ROLE: "worker" })!;
    assert.equal(options.environment, "staging");
    assert.equal(options.release, "34c9540c");
    assert.equal(options.serverName, "worker");
    assert.deepEqual((options.initialScope as { tags: Record<string, string> }).tags, { service: "worker" });
    assert.equal(options.tracesSampleRate, 0, "errors only by default");
    const bare = server.monitoringOptions({ NODE_ENV: "production" })!;
    assert.equal(bare.environment, "production");
    assert.ok(!("release" in bare), "no commit, no invented release");
    assert.equal(bare.serverName, "combined");
    const rate = (value: string) => server.monitoringOptions({ NODE_ENV: "production", SENTRY_TRACES_SAMPLE_RATE: value })!.tracesSampleRate;
    assert.equal(rate("0.25"), 0.25);
    assert.equal(rate("5"), 1);
    assert.equal(rate("-1"), 0);
    assert.equal(rate("lots"), 0);
  });

  await check("the SDK is told to collect nothing personal, and v11's integrations that would over-report are left out", () => {
    const options = server.monitoringOptions({ NODE_ENV: "production" })!;
    const collected = options.dataCollection!;
    assert.equal(collected.userInfo, false);
    assert.equal(collected.cookies, false);
    assert.deepEqual(collected.httpBodies, []);
    assert.equal(collected.urlQueryParams, false);
    assert.equal(collected.stackFrameVariables, false);
    assert.equal(options.enableRuntimeChannelInjection, false);
    // Names that no longer exist would leave the filter removing nothing.
    const defaults = Sentry.getDefaultIntegrations({});
    const names = defaults.map((integration) => integration.name);
    for (const name of server.LEFT_OUT_INTEGRATIONS) assert.ok(names.includes(name), `the SDK no longer has an integration called ${name}`);
    const kept = (options.integrations as (all: typeof defaults) => typeof defaults)(defaults).map((integration) => integration.name);
    for (const name of server.LEFT_OUT_INTEGRATIONS) assert.ok(!kept.includes(name), `${name} is still installed`);
    assert.ok(kept.includes("Http") && kept.includes("RequestData") && kept.includes("LinkedErrors"), "the rest stay");
  });

  /* ---------------------------------------------------------- scrubbers -- */

  // One table, both copies: the server's and the browser's must agree.
  const copies = { server, browser } as const;
  const urls: Array<[string, string]> = [
    [`https://os.dakyx.com/set-password?token=${SECRETS.token}&email=ama%40mensahfoods.example#x`, "https://os.dakyx.com/set-password?token=[Filtered]&email=[Filtered]"],
    [`/api/public/review/${REVIEW_TOKEN}/decision`, "/api/public/review/:token/decision"],
    [`/api/leads/${ROW_ID}`, `/api/leads/${ROW_ID}`],
    [`/api/users/${SECRETS.email}/reset`, "/api/users/:email/reset"],
    ["postgresql://admin:hunter2@db.internal:5432/os", "postgresql://[Filtered]@db.internal:5432/os"],
    ["/verify-email?code=991204&reference=PSK_123&=bare", "/verify-email?code=[Filtered]&reference=[Filtered]&[Filtered]"],
    ["https://os.dakyx.com/leads", "https://os.dakyx.com/leads"],
  ];
  for (const [label, copy] of Object.entries(copies)) {
    await check(`${label}: a URL keeps its path and loses every query value, fragment, token and address`, () => {
      for (const [input, expected] of urls) assert.equal(copy.scrubUrl(input), expected, input);
    });

    await check(`${label}: free text has its links scrubbed and its addresses masked, and nothing else changes`, () => {
      const text = copy.scrubText(`fetch failed for https://api.paystack.co/transaction/verify/T123?key=${SECRETS.paystack} on behalf of ${SECRETS.email}`);
      assert.equal(text, "fetch failed for https://api.paystack.co/transaction/verify/T123?key=[Filtered] on behalf of [email]");
      assert.equal(copy.scrubText(`GET /set-password?token=${SECRETS.token} failed`), "GET /set-password?token=[Filtered] failed");
      const ordinary = "PrismaClientKnownRequestError: Unique constraint failed on the fields: (`slug`)";
      assert.equal(copy.scrubText(ordinary), ordinary);
    });

    await check(`${label}: Prisma's printout of the call's arguments goes, the call and the verdict stay`, () => {
      // Both shapes Prisma prints: bare, as in production, and with the
      // source lines around the call, as anywhere else.
      const bare = `\nInvalid \`prisma.lead.update()\` invocation:\n\n{\n  where: {\n    id: "nope"\n  },\n  data: {\n    notes: "${SECRETS.enquiry}",\n    ~~~~~\n?   contactName?: String\n  }\n}\n\nUnknown argument \`notes\`. Available options are marked with ?.`;
      assert.equal(copy.scrubText(bare), "\nInvalid `prisma.lead.update()` invocation:\n[arguments filtered]\nUnknown argument `notes`. Available options are marked with ?.");
      const framed = `PrismaClientValidationError: \nInvalid \`prisma.websitePage.create()\` invocation in\n/app/dist/routes/website.js:412:31\n\n  411 const saved = await prisma.websitePage.create({\n→ 412   data: {\n          html: "${SECRETS.page}",\n+         siteId: String\n        }\n      })\n\nArgument \`siteId\` is missing.`;
      assert.equal(copy.scrubText(framed), "PrismaClientValidationError: \nInvalid `prisma.websitePage.create()` invocation in\n/app/dist/routes/website.js:412:31\n[arguments filtered]\nArgument `siteId` is missing.");
      // A failure with nothing printed between the two loses nothing.
      const notFound = "\nInvalid `prisma.lead.update()` invocation:\n\n\nAn operation failed because it depends on one or more records that were required but not found. Record to update not found.";
      assert.equal(copy.scrubText(notFound), "\nInvalid `prisma.lead.update()` invocation:\nAn operation failed because it depends on one or more records that were required but not found. Record to update not found.");
    });

    await check(`${label}: an event loses cookies, auth headers, the body and every secret, and keeps what makes it useful`, () => {
      const event = copy.scrubEvent(everythingEvent() as any) as Record<string, any>;
      assertNothingSecret(JSON.stringify(event), label);
      assert.ok(!JSON.stringify(event).includes("203.0.113.9"), "the visitor's address");
      assert.equal(event.request.cookies, undefined);
      assert.equal(event.request.data, undefined);
      assert.equal(event.request.query_string, undefined);
      assert.equal(event.request.env, undefined);
      assert.deepEqual(Object.keys(event.request.headers).sort(), ["referer", "user-agent"]);
      // What is left is still worth reading.
      assert.equal(event.request.method, "POST");
      assert.equal(event.request.url, `https://os.dakyx.com/api/website/pages/${ROW_ID}/publish?token=[Filtered]&email=[Filtered]`);
      assert.equal(event.request.headers["user-agent"], "Mozilla/5.0 (Macintosh)");
      assert.equal(event.transaction, "POST /api/public/review/:token/decision");
      assert.equal(event.message, "Boom at /reset-password?token=[Filtered]");
      assert.equal(event.exception.values[0].type, "TypeError");
      assert.equal(event.exception.values[0].value, "Cannot read properties of undefined (reading 'html') for [email]");
      assert.equal(event.exception.values[0].stacktrace.frames[0].function, "publishPage");
      assert.equal(event.exception.values[0].stacktrace.frames[0].lineno, 412);
      assert.equal(event.exception.values[0].stacktrace.frames[0].vars, undefined, "a frame's local variables");
      assert.deepEqual(event.tags, { route: `POST /api/website/pages/${ROW_ID}/publish`, reference: "k3x9q2mf" });
      assert.deepEqual(event.user, { id: "user-1" });
      // The console line is gone; the request and the navigation stay, minus their secrets.
      assert.deepEqual(event.breadcrumbs.map((b: { category: string }) => b.category), ["http", "navigation"]);
      assert.deepEqual(event.breadcrumbs[0].data, { url: "https://api.paystack.co/transaction/initialize?key=[Filtered]", "http.request.method": "POST", status_code: 502 });
      assert.deepEqual(event.breadcrumbs[1].data, { from: "/set-password?token=[Filtered]&email=[Filtered]", to: "/leads" });
    });
  }

  await check("the two copies produce the same event, byte for byte", () => {
    assert.equal(JSON.stringify(browser.scrubEvent(everythingEvent() as any)), JSON.stringify(server.scrubEvent(everythingEvent() as any)));
  });

  /* ---------------------------------------------------------- the browser -- */

  await check("the browser reports from the production hosts only, unless the build names a DSN", () => {
    for (const host of ["os.dakyx.com", "editor.dakyx.com", "app.dakyx.com", "os.dakyworld.com"]) assert.equal(browser.monitoringDsn(host, undefined), browser.BROWSER_DSN, host);
    assert.equal(browser.monitoringDsn("localhost", undefined), null);
    assert.equal(browser.monitoringDsn("dakyx.com", ""), null, "the marketing site is not the app");
    assert.equal(browser.monitoringDsn("localhost", "https://abc@o1.ingest.example.invalid/2"), "https://abc@o1.ingest.example.invalid/2");
    assert.equal(browser.monitoringDsn("os.dakyx.com", "off"), null);
    const options = browser.browserOptions(browser.BROWSER_DSN, "os.dakyx.com");
    assert.equal(options.tracesSampleRate, 0);
    assert.equal(options.environment, "production");
    assert.equal(options.dataCollection?.cookies, false);
    assert.deepEqual(options.dataCollection?.httpBodies, []);
    const kept = (options.integrations as (all: Array<{ name: string }>) => Array<{ name: string }>)([{ name: "Console" }, { name: "Breadcrumbs" }, { name: "GlobalHandlers" }]);
    assert.deepEqual(kept.map((integration) => integration.name), ["Breadcrumbs", "GlobalHandlers"]);
    assert.ok(!Object.keys(options).some((key) => /replay/i.test(key)), "no session replay");
  });

  await check("an error thrown by an extension, the page being edited, or another site is not ours", () => {
    const deny = browser.foreignScriptUrls("os.dakyx.com");
    const denied = (url: string) => deny.some((pattern) => pattern.test(url));
    assert.ok(denied("chrome-extension://abcdefghijklmnop/content.js"));
    assert.ok(denied("moz-extension://1234/inject.js"));
    assert.ok(denied("webkit-masked-url://hidden/"));
    assert.ok(denied(`https://os.dakyx.com/api/website/pages/${ROW_ID}/preview?pick=1&v=3`), "the editing preview's own scripts");
    assert.ok(denied("https://mensahfoods.example/js/app.js"), "a customer's script loaded by the page being edited");
    assert.ok(denied("https://os.dakyx.com.evil.example/x.js"), "a lookalike host");
    // And never the app itself.
    assert.ok(!denied("https://os.dakyx.com/assets/index-BcwL6ZkU.js"));
    assert.ok(!denied("https://os.dakyx.com:443/assets/WebsiteEditor-Dv9lN7t6.js"));
    assert.ok(!browser.foreignScriptUrls("localhost").some((pattern) => pattern.test("http://localhost:5173/src/main.tsx")), "a local build with a DSN still reports its own errors");
  });

  await check("the CSP lets the browser reach Sentry's ingest for this DSN, and nothing else new", () => {
    const headers: Record<string, string> = {};
    securityHeaders({} as express.Request, { setHeader: (name: string, value: string) => { headers[name] = value; }, removeHeader: () => undefined } as unknown as express.Response, () => undefined);
    const connect = headers["Content-Security-Policy"]!.split("; ").find((directive) => directive.startsWith("connect-src "));
    assert.equal(connect, `connect-src 'self' https://${new URL(browser.BROWSER_DSN).host}`);
    assert.equal(new URL(server.SERVER_DSN).host, new URL(browser.BROWSER_DSN).host, "both projects ingest through the one host the CSP names");
  });

  await check("index.ts and worker.ts start error tracking before anything else", () => {
    for (const entry of ["index.ts", "worker.ts"]) {
      const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), "utf8");
      assert.match(source.split("\n")[0]!, /^import "\.\/instrument\.js";/, `${entry} must import instrument.js on its first line`);
    }
  });

  /* ------------------------------------------------- the error handler -- */

  // The routes a harness needs: an accident, the composed refusals, and the
  // handler that decides between them — the real one.
  let received: Record<string, unknown> = {};
  const app = express();
  app.use(express.json());
  app.post("/api/website/pages/:id/publish", (req) => {
    received = req.headers;
    throw new TypeError(`Cannot read properties of undefined (reading 'html') for ${SECRETS.email}`);
  });
  app.get("/api/website/refused", () => {
    throw new WebsiteError(409, "The page changed since you opened it. Reopen it and look at it as it is now.");
  });
  app.get("/api/website/missing", () => {
    throw new WebsiteError(404, "That page is not on this site.");
  });
  app.post("/api/leads", (req) => {
    z.object({ name: z.string() }).parse(req.body);
  });
  app.get("/api/scrapers/run", () => {
    throw new ApifyError(503, "Add an Apify token under Settings -> Lead capture.");
  });
  // A vendor's own error object: a 4xx status from GitHub is our call failing.
  app.get("/api/website/vendor", () => {
    throw Object.assign(new Error("GitHub answered 404 for contents/about.html"), { status: 404 });
  });
  // A real Prisma validation error: refused before any query runs, so nothing
  // is written, and its message holds the value it was handed.
  let prismaMessage = "";
  app.post("/api/leads/:id/notes", async (req, _res, next) => {
    try {
      await prisma.lead.update({ where: { id: req.params.id }, data: { notes: SECRETS.enquiry } as never });
    } catch (error) {
      prismaMessage = (error as Error).message;
      next(error);
    }
  });
  app.use(errorHandler);

  const listen = async () => {
    const http = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => http.once("listening", resolve));
    return { http, base: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
  };
  const accident = (base: string) =>
    fetch(`${base}/api/website/pages/${ROW_ID}/publish?token=${SECRETS.token}&email=ama%40mensahfoods.example`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `__Host-dw_session=${SECRETS.session}; dw_seen=${SECRETS.cookie}`,
        Authorization: SECRETS.bearer,
        "X-Paystack-Signature": SECRETS.signature,
        "User-Agent": "Mozilla/5.0 (Macintosh)",
      },
      body: JSON.stringify({ html: SECRETS.page, message: SECRETS.enquiry }),
    });
  const start = async (overrides: Record<string, unknown> = {}) => {
    await Sentry.close(2000);
    envelopes.length = 0;
    Sentry.init({ ...server.monitoringOptions({ NODE_ENV: "production", SERVICE_ROLE: "api" })!, transport, ...overrides });
  };

  await check("an accident is reported once, tagged with its route and the reference the person was shown", async () => {
    await start();
    const { http, base } = await listen();
    try {
      const response = await accident(base);
      const body = (await response.json()) as { error: string; reference: string };
      assert.equal(response.status, 500);
      await Sentry.flush(2000);
      assert.equal(events().length, 1, `one event, got ${events().length}`);
      const [event] = events();
      assert.equal(event!.exception.values[0].type, "TypeError");
      assert.equal(event!.tags.route, `POST /api/website/pages/${ROW_ID}/publish`);
      assert.equal(event!.tags.reference, body.reference);
      assert.equal(event!.tags.service, "api");
      assert.equal(event!.level, "error");
      assert.equal(event!.request.method, "POST");
      assert.ok(String(event!.request.url).includes(`/api/website/pages/${ROW_ID}/publish`), "the request is still identifiable");
      assert.equal(event!.user?.ip_address, undefined, "nor the visitor's address");
      assertNothingSecret(envelopes.map((envelope) => envelope.raw).join("\n"), "as configured");
      // This process's own fetch went out through the same instrumentation.
      assert.equal(received["sentry-trace"], undefined, "no trace header is added to outgoing requests");
      assert.equal(received.baggage, undefined, "no baggage header naming the organisation");
    } finally {
      http.close();
    }
  });

  await check("a Prisma error is reported with its verdict, never the values it was called with", async () => {
    await start();
    const { http, base } = await listen();
    try {
      assert.equal((await fetch(`${base}/api/leads/${ROW_ID}/notes`, { method: "POST" })).status, 500);
      await Sentry.flush(2000);
      // The fixture is only worth something if the raw message really carries it.
      assert.ok(prismaMessage.includes(SECRETS.enquiry), "Prisma no longer prints the arguments; this check proves nothing until it is rewritten");
      assert.equal(events().length, 1);
      const value = String(events()[0]!.exception.values[0].value);
      assert.match(value, /Invalid `prisma\.lead\.update\(\)` invocation/);
      assert.match(value, /Unknown argument `notes`/);
      assert.ok(value.includes("[arguments filtered]"), value);
      assertNothingSecret(envelopes.map((envelope) => envelope.raw).join("\n"), "a Prisma error");
    } finally {
      http.close();
    }
  });

  await check("a refusal written for the person reading it is never reported — 409, 404, validation, or a composed 503", async () => {
    await start();
    const { http, base } = await listen();
    try {
      const statuses = [
        (await fetch(`${base}/api/website/refused`)).status,
        (await fetch(`${base}/api/website/missing`)).status,
        (await fetch(`${base}/api/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status,
        (await fetch(`${base}/api/scrapers/run`)).status,
        // Answered exactly as it always was; only the report is withheld.
        (await fetch(`${base}/api/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status,
      ];
      assert.deepEqual(statuses, [409, 404, 400, 503, 500], "each refusal still reaches the person as it did");
      await Sentry.flush(2000);
      assert.equal(events().length, 0, `nothing reported, got ${events().map((event) => event.exception?.values?.[0]?.value).join(" | ")}`);
      // The negative is only worth something if the positive still fires on
      // the same client — including a vendor's error that carries a 4xx.
      await accident(base);
      assert.equal((await fetch(`${base}/api/website/vendor`)).status, 500);
      await Sentry.flush(2000);
      assert.deepEqual(events().map((event) => event.exception.values[0].type), ["TypeError", "Error"]);
      assert.equal(events()[1]!.exception.values[0].value, "GitHub answered 404 for contents/about.html");
    } finally {
      http.close();
    }
  });

  await check("control: with v11's own defaults and no scrubber, a cookie, the body and the address really would be sent", async () => {
    await start({ dataCollection: undefined, tracePropagationTargets: undefined, beforeSend: (event: unknown) => event, beforeBreadcrumb: (breadcrumb: unknown) => breadcrumb });
    const { http, base } = await listen();
    try {
      await accident(base);
      await Sentry.flush(2000);
      const raw = envelopes.map((envelope) => envelope.raw).join("\n");
      assert.ok(raw.includes(SECRETS.cookie), "the SDK's defaults collect cookies");
      assert.ok(raw.includes(SECRETS.enquiry), "the SDK's defaults collect the request body");
      assert.equal(events()[0]!.user?.ip_address, "127.0.0.1", "the SDK's defaults collect the visitor's address");
      assert.equal(typeof received["sentry-trace"], "string", "the SDK's defaults add a trace header to every outgoing request");
    } finally {
      http.close();
    }
  });

  await check("with those same defaults, the scrubber alone still lets none of it out", async () => {
    await start({ dataCollection: undefined });
    const { http, base } = await listen();
    try {
      await accident(base);
      await Sentry.flush(2000);
      assert.equal(events().length, 1);
      const raw = envelopes.map((envelope) => envelope.raw).join("\n");
      assertNothingSecret(raw, "with collect-everything defaults");
      assert.ok(!raw.includes(SECRETS.cookie), "with collect-everything defaults: a cookie left the building");
      assert.equal(events()[0]!.user?.ip_address, undefined, "with collect-everything defaults: the visitor's address left the building");
      assert.equal(events()[0]!.exception.values[0].value, "Cannot read properties of undefined (reading 'html') for [email]");
    } finally {
      http.close();
    }
  });

  await check("Sentry unreachable: the request is answered exactly as before and nothing throws", async () => {
    await start();
    refuse = true;
    const { http, base } = await listen();
    try {
      const response = await accident(base);
      const body = (await response.json()) as { error: string; reference: string };
      assert.equal(response.status, 500);
      assert.match(body.reference, /^[a-z0-9]{1,8}$/);
      await Sentry.flush(2000);
      const again = await fetch(`${base}/api/website/refused`);
      assert.equal(again.status, 409, "the server is still answering");
    } finally {
      refuse = false;
      http.close();
    }
  });

  await check("a DSN Sentry cannot parse does not stop the boot", async () => {
    await Sentry.close(2000);
    assert.equal(server.startMonitoring({ NODE_ENV: "production", SENTRY_DSN: "off" }), false);
    assert.doesNotThrow(() => server.startMonitoring({ NODE_ENV: "production", SENTRY_DSN: "not a dsn at all" }));
    assert.doesNotThrow(() => Sentry.captureException(new Error("into the void")));
    await Sentry.close(500);
  });

  /* --------------------------------------------------------- a crash -- */

  /**
   * Crashes a real process with the real handlers installed and Sentry
   * started from the real options, and returns what it sent and how long the
   * exit took after the throw. Sentry either answers at once or never does.
   */
  const crashProcess = (nodeEnv: "test" | "production", sentry: "answers" | "hangs") => {
    const dir = mkdtempSync(join(tmpdir(), "monitoring-crash-"));
    try {
      const out = join(dir, "envelopes.txt");
      writeFileSync(out, "");
      const url = (path: string) => new URL(path, import.meta.url).href;
      const script = join(dir, "crash.mjs");
      const send = sentry === "answers"
        ? `async (request) => { appendFileSync(${JSON.stringify(out)}, Buffer.from(request.body).toString("utf8") + "\\n\\u0000\\n"); return { statusCode: 200 }; }`
        : `() => new Promise(() => {})`;
      writeFileSync(script, [
        `import { appendFileSync } from "node:fs";`,
        `const Sentry = await import(${JSON.stringify(import.meta.resolve("@sentry/node"))});`,
        `const { monitoringOptions } = await import(${JSON.stringify(url("../src/instrument.ts"))});`,
        `const { installCrashReporting } = await import(${JSON.stringify(url("../src/services/opsAlert.ts"))});`,
        `Sentry.init({ ...monitoringOptions({ NODE_ENV: "production", SENTRY_DSN: "https://public@o1.ingest.example.invalid/1", SERVICE_ROLE: "worker" }),`,
        `  transport: (options) => Sentry.createTransport(options, ${send}) });`,
        `installCrashReporting("worker");`,
        `setTimeout(() => { console.error("crash-at:" + Date.now()); throw new Error("deliberate crash for ${SECRETS.email}"); }, 10);`,
        `setTimeout(() => process.exit(7), 15000);`,
      ].join("\n"));
      const run = spawnSync(process.execPath, ["--import", "tsx", script], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        // An address nothing answers on: the crash email's lease query fails
        // rather than writing a row into somebody's database.
        env: { ...process.env, NODE_ENV: nodeEnv, SENTRY_DSN: "off", DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
        timeout: 60_000,
      });
      const ended = Date.now();
      const crashedAt = Number(/crash-at:(\d+)/.exec(run.stderr)?.[1]);
      const sent = readFileSync(out, "utf8").split("\n\u0000\n").filter(Boolean).map(parseEnvelope);
      return { run, afterCrashMs: ended - crashedAt, crashes: sent.flatMap((envelope) => envelope.events) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  await check("a crash is sent to Sentry once, as fatal and scrubbed, before the process exits with 1", () => {
    const { run, afterCrashMs, crashes } = crashProcess("test", "answers");
    assert.equal(run.status, 1, `exit status ${run.status}; stderr: ${run.stderr.slice(-600)}`);
    assert.match(run.stderr, /\[crash\] worker: uncaughtException/);
    assert.equal(crashes.length, 1, `one event, not one per handler: got ${crashes.length}`);
    assert.equal(crashes[0]!.level, "fatal");
    assert.equal(crashes[0]!.tags.crash, "uncaughtException");
    assert.equal(crashes[0]!.tags.process, "worker");
    assert.equal(crashes[0]!.exception.values[0].value, "deliberate crash for [email]");
    assert.ok(afterCrashMs < 1500, `an answered flush should not hold the exit: ${afterCrashMs}ms`);
  });

  await check("a Sentry that never answers holds a crash's exit for two seconds, no more", () => {
    const { run, afterCrashMs } = crashProcess("test", "hangs");
    assert.equal(run.status, 1, `exit status ${run.status}; stderr: ${run.stderr.slice(-600)}`);
    assert.ok(afterCrashMs >= 1900 && afterCrashMs < 3000, `exit ${afterCrashMs}ms after the crash`);
  });

  await check("in production the crash reaches Sentry beside the Owner's email, inside the three-second cap", () => {
    const { run, afterCrashMs, crashes } = crashProcess("production", "answers");
    assert.equal(run.status, 1, `exit status ${run.status}; stderr: ${run.stderr.slice(-600)}`);
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0]!.level, "fatal");
    assert.ok(afterCrashMs < 3500, `exit ${afterCrashMs}ms after the crash`);
    const hung = crashProcess("production", "hangs");
    assert.equal(hung.run.status, 1);
    assert.ok(hung.afterCrashMs < 3500, `a hanging Sentry in production: exit ${hung.afterCrashMs}ms after the crash`);
  });

  console.log(`monitoring: ${passed} passed — scrubbed on both sides, accidents reported and refusals not, and a crash sent before the exit`);
} finally {
  await Sentry.close(500).catch(() => undefined);
  await prisma.$disconnect();
}
process.exit(0);
