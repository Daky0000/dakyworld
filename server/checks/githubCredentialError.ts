import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { GitHubError } from "../src/lib/github.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Check the production HTTP response without real credentials or network calls.
const previousEnvironment = process.env.NODE_ENV;
const previousLog = console.error;
process.env.NODE_ENV = "production";
console.error = () => {};
const app = express();
app.get("/credential", (_req, _res, next) => next(new GitHubError(401, "private upstream details")));
app.get("/unexpected", (_req, _res, next) => next(new Error("private internal details")));
app.get("/upstream", (_req, _res, next) => next(new GitHubError(502, "private network details")));
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
try {
  const response = await fetch(`${origin}/credential`);
  assert.equal(response.status, 503, "GitHub credentials must not become a Dakyworld login failure");
  const body = await response.json();
  assert.match(body.error, /reconnect GitHub/);
  assert.match(body.error, /Settings > Developer/);
  assert.doesNotMatch(body.error, /private/);
  assert.equal(typeof body.reference, "string");
  assert.ok(body.reference.length > 0);
  for (const path of ["unexpected", "upstream"]) {
    const failure = await fetch(`${origin}/${path}`);
    assert.equal(failure.status, 500);
    assert.equal((await failure.json()).error, "Something went wrong.");
  }
  console.log("GitHub credential errors give recovery instructions; unexpected errors remain private.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  console.error = previousLog;
  if (previousEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnvironment;
}
