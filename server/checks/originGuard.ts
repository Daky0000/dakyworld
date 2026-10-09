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
 * Needs no database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { refuseForeignWrites } from "../src/middleware/security.js";

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

  // What must keep working.
  for (const origin of ["https://os.dakyx.com", "https://app.dakyx.com", "https://editor.dakyx.com", "https://dakyx.com"]) {
    assert.equal(await status("POST", origin), 200, `${origin} is ours`);
  }
  assert.equal(await status("POST"), 200, "no Origin is curl, MCP or a server, which carry nobody's cookie");
  assert.equal(await status("GET", "https://evil.example"), 200, "reads are CORS's job, not this guard's");

  process.env.NODE_ENV = "development";
  assert.equal(await status("POST", "http://localhost:5173"), 200, "the local client still writes in development");
} finally {
  process.env.NODE_ENV = savedEnv;
  if (savedClient !== undefined) process.env.CLIENT_ORIGIN = savedClient;
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

console.log("originGuard: foreign writes refused, our origins and non-browser callers allowed, mounted before the session");
