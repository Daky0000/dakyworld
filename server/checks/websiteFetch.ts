import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { fetchWebsiteText, resolveWebsiteAddress, websiteAddressAllowed } from "../src/lib/websiteFetch.js";

for (const ip of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.31.1.1", "192.168.0.1", "100.64.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::"]) assert.equal(websiteAddressAllowed(ip), false, ip);
for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(websiteAddressAllowed(ip), true, ip);
assert.equal(websiteAddressAllowed("127.0.0.1", true), true);
assert.equal(websiteAddressAllowed("10.0.0.1", true), false);
await assert.rejects(resolveWebsiteAddress(new URL("https://mixed.test"), false, async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]), /public server/);
await assert.rejects(resolveWebsiteAddress(new URL("https://user:pass@example.com")), /public HTTP/);
const original = { node: process.env.NODE_ENV, auth: process.env.DEV_NO_AUTH };
process.env.NODE_ENV = "development"; process.env.DEV_NO_AUTH = "true";
const app = express();
app.get("/", (_req, res) => res.send("<h1>Local fixture</h1>"));
app.get("/redirect", (_req, res) => res.redirect("/"));
app.get("/private", (_req, res) => res.redirect("http://10.0.0.1/"));
app.get("/loop", (_req, res) => res.redirect("/loop"));
app.get("/large", (_req, res) => res.send("x".repeat(2 * 1024 * 1024 + 1)));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
try {
  assert.equal(await fetchWebsiteText(`${base}/redirect`), "<h1>Local fixture</h1>");
  await assert.rejects(fetchWebsiteText(`${base}/private`), /public server/);
  await assert.rejects(fetchWebsiteText(`${base}/loop`), /too many times/);
  await assert.rejects(fetchWebsiteText(`${base}/large`), /2 MB limit/);
  process.env.NODE_ENV = "production";
  await assert.rejects(fetchWebsiteText(base), /public server/);
  console.log("websiteFetch: address isolation, redirect validation, bounded reads and development-only loopback passed");
} finally {
  if (original.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original.node;
  if (original.auth === undefined) delete process.env.DEV_NO_AUTH; else process.env.DEV_NO_AUTH = original.auth;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
