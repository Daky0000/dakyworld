/**
 * A write from a page that is not ours is refused before it reaches a route.
 *
 * `SameSite=Lax` treats every *.dakyx.com host as the same site as
 * os.dakyx.com, so a customer website hosted under dakyx.com gets the Owner's
 * cookie attached to anything it posts. CORS only stops the reply being read.
 * `refuseForeignWrites` is the guard, and this pins both what it allows and
 * where it is mounted: it must sit below the public routes and webhooks (other
 * sites post to those on purpose) and above `attachUser`.
 *
 * The marketing site, dakyx.com, is one of those pages that is not ours in
 * this sense: it is edited with the builder, so a script on it must not get the
 * Owner's session. It is refused here and given no credentialed CORS, while the
 * public checkout routes it does call still answer it.
 *
 * Needs no database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import cors from "cors";
import express from "express";
import { isTrustedOrigin, refuseForeignWrites } from "../src/middleware/security.js";
import { publicProductsRouter } from "../src/routes/products.js";

const app = express();
app.use("/api", refuseForeignWrites);
app.all("/api/approvals/:id/approve", (_req, res) => res.json({ acted: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/approvals/1/approve`;

async function status(method: string, origin?: string): Promise<number> {
  const response = await fetch(url, { method, headers: origin === undefined ? {} : { Origin: origin } });
  await response.arrayBuffer();
  return response.status;
}

// A local .env may name the Vite client as CLIENT_ORIGIN; this check sets its own.
const savedEnv = process.env.NODE_ENV;
const savedClient = process.env.CLIENT_ORIGIN;
delete process.env.CLIENT_ORIGIN;
try {
  process.env.NODE_ENV = "production";
  // The case the guard exists for: a hosted customer page, same site, not ours.
  assert.equal(await status("POST", "https://evil.sites.dakyx.com"), 403, "a sibling subdomain must not write");
  assert.equal(await status("POST", "https://dakyx.com.evil.example"), 403, "a lookalike host must not write");
  assert.equal(await status("DELETE", "https://evil.example"), 403);
  assert.equal(await status("PATCH", "https://evil.example"), 403);
  assert.equal(await status("POST", "null"), 403, "sandboxed frames and data: pages send Origin: null");
  assert.equal(await status("POST", "http://localhost:5173"), 403, "localhost is a development origin only");
  // The marketing site is edited with the builder, so whatever lands on it runs
  // in the Owner's browser. It never needs the session, and must not have it.
  assert.equal(await status("POST", "https://dakyx.com"), 403, "the marketing site must not write with the Owner's session");
  assert.equal(await status("POST", "https://www.dakyx.com"), 403, "nor its www host");

  // What must keep working.
  for (const origin of ["https://os.dakyx.com", "https://app.dakyx.com", "https://editor.dakyx.com", "https://os.dakyworld.com"]) {
    assert.equal(await status("POST", origin), 200, `${origin} is ours`);
  }
  assert.equal(await status("POST"), 200, "no Origin is curl, MCP or a server, which carry nobody's cookie");
  assert.equal(await status("GET", "https://evil.example"), 200, "reads are CORS's job, not this guard's");

  // CLIENT_ORIGIN is a comma-separated list in production (.railway/railway.ts).
  // Compared as one string it matched nothing at all.
  process.env.CLIENT_ORIGIN = "https://os.dakyx.com, https://staging.dakyx.test/ ,https://app.dakyx.com";
  assert.equal(await status("POST", "https://staging.dakyx.test"), 200, "every origin in the CLIENT_ORIGIN list is trusted");
  assert.equal(isTrustedOrigin("https://staging.dakyx.test"), true);
  assert.equal(await status("POST", "https://dakyx.com"), 403, "a list does not trust what it does not name");
  assert.equal(await status("POST", "https://evil.example"), 403);
  assert.equal(isTrustedOrigin(""), false, "an empty entry in the list trusts nothing");
  process.env.CLIENT_ORIGIN = "https://only.dakyx.test";
  assert.equal(await status("POST", "https://only.dakyx.test"), 200, "a single CLIENT_ORIGIN still works");
  delete process.env.CLIENT_ORIGIN;

  process.env.NODE_ENV = "development";
  assert.equal(await status("POST", "http://localhost:5173"), 200, "the local client still writes in development");
  assert.equal(await status("POST", "https://dakyx.com"), 403, "the marketing site is not trusted in development either");
} finally {
  process.env.NODE_ENV = savedEnv;
  if (savedClient !== undefined) process.env.CLIENT_ORIGIN = savedClient;
  else delete process.env.CLIENT_ORIGIN;
  server.close();
}

// Mounted where it does its job: after the routes other sites may post to,
// before the session is read.
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const at = (needle: string) => {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `index.ts no longer contains ${needle}`);
  return index;
};
const guard = at('app.use("/api", refuseForeignWrites)');
assert.ok(guard > at('app.use("/api/webhooks"'), "the guard must sit below the webhooks");
assert.ok(guard > at('app.use("/api/public", publicProductsRouter)'), "the guard must sit below the public checkout routes");
assert.ok(guard < at("app.use(attachUser)"), "the guard must run before the session is read");
// The CORS grant below is built the way index.ts builds it; this keeps the two
// in step, so the assertions are about the grant production actually makes.
at("callback(null, !origin || isTrustedOrigin(origin));");
assert.ok(at("credentials: true") > at("app.use(cors({"), "the API's CORS grant carries credentials");
assert.ok(at("app.use(cors({") < at('app.use("/api/public", publicProductsRouter)'), "CORS runs before the public routes");

// The whole crossing, in index.ts's order: the credentialed CORS grant, the
// public checkout routes, the guard, then a route that would act on the
// session. What a script on dakyx.com can do with each is what a browser does
// with these headers.
const stack = express();
stack.use(cors({ origin(origin, callback) { callback(null, !origin || isTrustedOrigin(origin)); }, credentials: true, exposedHeaders: ["X-Next-Cursor"] }));
stack.use(express.json());
stack.use("/api/public", publicProductsRouter);
stack.use("/api", refuseForeignWrites);
stack.all("/api/approvals/:id/approve", (_req, res) => res.json({ acted: true }));
stack.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error && typeof error === "object" && "issues" in error ? 400 : 500).json({ error: "refused" });
});
const stackServer = stack.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => stackServer.once("listening", resolve));
const base = `http://127.0.0.1:${(stackServer.address() as AddressInfo).port}`;

async function send(path: string, method: string, headers: Record<string, string>, body?: string) {
  const response = await fetch(`${base}${path}`, { method, headers, body });
  await response.arrayBuffer();
  return { status: response.status, allowOrigin: response.headers.get("access-control-allow-origin"), allowCredentials: response.headers.get("access-control-allow-credentials") };
}
const preflight = (path: string, origin: string) => send(path, "OPTIONS", { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" });

// Development, so the public route's rate limiter counts in memory and this
// file stays without a database. Nothing about dakyx.com depends on it: the
// production half above refuses it too.
process.env.NODE_ENV = "development";
delete process.env.CLIENT_ORIGIN;
try {
  const marketing = "https://dakyx.com";
  let answer = await preflight("/api/approvals/1/approve", marketing);
  assert.equal(answer.allowOrigin, null, "a JSON write from dakyx.com to the session API is refused at the preflight");
  assert.notEqual(answer.allowCredentials, "true");
  answer = await send("/api/approvals/1/approve", "GET", { Origin: marketing });
  assert.equal(answer.allowOrigin, null, "dakyx.com cannot read an answer from the session API");
  answer = await send("/api/approvals/1/approve", "POST", { Origin: marketing });
  assert.equal(answer.status, 403, "a simple POST from dakyx.com never reaches the route");
  answer = await send("/api/approvals/1/approve", "GET", { Origin: "https://www.dakyx.com" });
  assert.equal(answer.allowOrigin, null, "nor can www.dakyx.com");

  // The control: the app's own host is still granted all of it.
  answer = await send("/api/approvals/1/approve", "GET", { Origin: "https://os.dakyx.com" });
  assert.equal(answer.allowOrigin, "https://os.dakyx.com");
  assert.equal(answer.allowCredentials, "true");

  // And the public routes the marketing site actually calls still answer it.
  answer = await preflight("/api/public/website-payment-status", marketing);
  assert.equal(answer.status, 204, "the checkout's preflight is answered by the public route itself");
  assert.equal(answer.allowOrigin, marketing);
  assert.notEqual(answer.allowCredentials, "true", "and without credentials");
  answer = await send("/api/public/website-payment-status", "POST", { Origin: marketing, "Content-Type": "application/json" }, "{}");
  assert.equal(answer.status, 400, "the payment check reaches its route (and refuses an empty body there), not the guard");
  assert.equal(answer.allowOrigin, marketing, "and dakyx.com may read what it says");
  answer = await preflight("/api/public/website-purchases", "https://www.dakyx.com");
  assert.equal(answer.allowOrigin, "https://www.dakyx.com", "starting a purchase is still allowed from www");
} finally {
  process.env.NODE_ENV = savedEnv;
  if (savedClient !== undefined) process.env.CLIENT_ORIGIN = savedClient;
  stackServer.close();
}

console.log("originGuard: foreign writes refused (the marketing site among them), CLIENT_ORIGIN read as a list, public checkout routes still answer dakyx.com, mounted before the session");
