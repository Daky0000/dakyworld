import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { demosRouter, demoPagesRouter } from "../src/routes/demos.js";
import { createVisitToken } from "../src/lib/demoTokens.js";
import { reloadCityDatabase } from "../src/lib/geoCity.js";

process.env.GEOIP_CITY_ENABLED = "true";
await reloadCityDatabase(fileURLToPath(new URL("./fixtures/geo/GeoLite2-City-Test.mmdb", import.meta.url)));
const now = new Date();
const demo = { id: "geo-demo", slug: "geo-demo", title: "Fixture", businessName: "Fixture", status: "DRAFT",
  html: "<html><body>Fixture</body></html>", brief: { notifyOnView: false }, views: 2, createdAt: now, builtBy: "Imported HTML" };
const visits: any[] = [];
let beaconWrite: Record<string, unknown> = {};
// Replace every database delegate reached by this test. No database is contacted.
(prisma.demo as any).findUnique = async () => demo;
(prisma.demo as any).update = async () => demo;
(prisma.appSetting as any).findUnique = async () => null;
(prisma.demoVisit as any).create = async ({ data }: any) => {
  const visit = { ...data, createdAt: now, updatedAt: now }; visits.push(visit); return visit;
};
(prisma.demoVisit as any).findFirst = async ({ where }: any) => visits.find(v => v.id === where.id);
(prisma.demoVisit as any).update = async ({ data }: any) => { beaconWrite = data; return visits[0]; };
(prisma.demoVisit as any).findMany = async ({ where }: any) => visits.filter(v => !where.createdAt?.gte || v.createdAt >= where.createdAt.gte);

const app = express();
app.set("trust proxy", "loopback");
app.use(express.json());
app.use("/demos", demoPagesRouter);
app.use((req, _res, next) => {
  (req as any).dbUser = { id: "fixture" }; req.permissions = new Set(["demos.view"]); next();
});
app.use("/api/demos", demosRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
try {
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${origin}/demos/geo-demo`, { headers: { "x-forwarded-for": "81.2.69.160", "user-agent": "Mozilla/5.0", "cf-ray": "fake", "cf-ipcountry": "US" } });
    assert.equal(response.status, 200);
    // A demo is served from the same hosts as the signed-in app, so it must run
    // in an origin of its own: sandboxed, and never `allow-same-origin`.
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /(^|;\s*)sandbox\b/, `demo page is sandboxed: ${policy}`);
    assert.doesNotMatch(policy, /allow-same-origin/);
    assert.doesNotMatch(policy, /allow-forms/);
    await response.text();
  }
  assert.equal(visits.length, 2);
  assert.notEqual(visits[0].id, visits[1].id);
  assert.equal(visits[0].city, "London");
  assert.equal(visits[0].country, "GB");
  assert.equal(visits[0].citySource, "geolite_city");
  assert.ok(visits[0].geoDatabaseVersion);
  const token = createVisitToken({ demoId: demo.id, slug: demo.slug, visitId: visits[0].id });
  const beacon = await fetch(`${origin}/demos/geo-demo/analytics`, { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "8.8.8.8" },
    body: JSON.stringify({ token, visitId: visits[0].id, sessionId: "reload-session", timezone: "Africa/Accra", locale: "en-GH", durationSeconds: 10 }),
  });
  assert.equal(beacon.status, 200);
  for (const key of ["country", "city", "region", "locationStatus", "countrySource", "citySource"]) assert.equal(key in beaconWrite, false);
  // What the sandboxed tracker actually sends: a simple text/plain request from
  // an opaque origin, which must be counted and answered readably.
  const sandboxed = await fetch(`${origin}/demos/geo-demo/analytics`, { method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", origin: "null", "x-forwarded-for": "8.8.4.4" },
    body: JSON.stringify({ token, visitId: visits[0].id, sessionId: "reload-session", durationSeconds: 12 }),
  });
  assert.equal(sandboxed.status, 200, await sandboxed.clone().text());
  assert.equal(sandboxed.headers.get("access-control-allow-origin"), "*");
  visits.push({ ...visits[0], id: "legacy", country: "GH", countryName: "Ghana", city: "Accra", locationStatus: null, countrySource: null, citySource: null });
  const reportResponse = await fetch(`${origin}/api/demos/geo-demo/analytics?range=7d`);
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.equal(report.breakdowns.cities.length, 1);
  assert.equal(report.breakdowns.cities[0].city, "London");
  assert.equal(report.summary.locationCoverage.legacy, 1);
  assert.equal(report.summary.locationCoverage.city, 2);
  assert.equal(report.visits.find((v: any) => v.id === "legacy").citySource, "legacy");
  const csv = await (await fetch(`${origin}/api/demos/geo-demo/analytics?range=7d&format=csv`)).text();
  assert.ok(csv.includes("Legacy / unverified location"));
  assert.ok(csv.includes("geolite_city"));
  assert.equal(csv.trim().split("\n").length, 4);
  console.log("geoRoutes: page snapshots, reload, beacon immutability, rankings and CSV passed");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}
