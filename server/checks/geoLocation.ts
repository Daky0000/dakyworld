import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractClientIp, resolveIpLocation } from "../src/lib/demoGeo.js";
import { serializeVisitLocation, locationCoverage } from "../src/lib/visitLocation.js";
import { reloadCityDatabase, validateCityDatabase, geoMetrics, lookupAnalyticsCity } from "../src/lib/geoCity.js";
import { updateGeoCity } from "../src/lib/updateGeoCity.js";
import { c } from "tar";

const providers = { country: () => "GH", city: () => ({ country: "GH", city: "Kumasi", region: "Ashanti", databaseVersion: "fixture", accuracyRadiusKm: 25 }) };
const visit = resolveIpLocation("102.176.0.1", null, providers);
assert.equal(serializeVisitLocation(visit).citySource, "geolite_city");
assert.match(serializeVisitLocation(visit).locationLabel, /Approximate location: Kumasi, Ashanti, Ghana/);
const legacy = { country: "GH", city: "Accra" };
assert.equal(serializeVisitLocation(legacy).locationStatus, "legacy");
assert.match(serializeVisitLocation(legacy).locationLabel, /unverified/);
const unknown = resolveIpLocation(null);
const local = resolveIpLocation("127.0.0.1");
const partial = resolveIpLocation("102.176.0.1", null, { ...providers, city: () => null });
assert.deepEqual(locationCoverage([visit, legacy, unknown, local, partial]), {
  total: 5, eligible: 4, local: 1, legacy: 1, unknown: 1, country: 2, city: 1, countryPercent: 50, cityPercent: 25,
});

// Actual HTTP requests exercise Express's trust boundary rather than mock req.ip.
for (const trusted of [false, "loopback", 2] as const) {
  const app = express();
  app.set("trust proxy", trusted);
  app.get("/", (req, res) => res.json({ ip: extractClientIp(req) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address() as { port: number };
    for (const chain of ["102.176.0.1", "8.8.8.8, 102.176.0.1"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}`, { headers: {
        "x-forwarded-for": trusted === 2 ? `${chain}, 84.17.44.225` : chain, "cf-ray": "forged", "cf-connecting-ip": "8.8.8.8", "cf-ipcountry": "US",
      } });
      assert.equal((await response.json()).ip, trusted ? "102.176.0.1" : "127.0.0.1");
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const temp = await mkdtemp(join(tmpdir(), "geo-check-"));
try {
  assert.throws(() => validateCityDatabase(Buffer.from("invalid")));
  const failures = geoMetrics.reloadFailures;
  assert.equal(await reloadCityDatabase(join(temp, "missing.mmdb")), false);
  await writeFile(join(temp, "bad.mmdb"), "invalid");
  assert.equal(await reloadCityDatabase(join(temp, "bad.mmdb")), false);
  assert.equal(geoMetrics.reloadFailures, failures + 2);
  assert.equal(resolveIpLocation("102.176.0.1", null, { city: () => null, country: () => "GH" }).countrySource, "geoip_country");
  const originalFetch = globalThis.fetch;
  const env = { ...process.env };
  try {
    process.env.GEOIP_CITY_ENABLED = "true";
    const fixture = await readFile(new URL("./fixtures/geo/GeoLite2-City-Test.mmdb", import.meta.url));
    const directory = join(temp, "GeoLite2-City_fixture");
    await mkdir(directory);
    await writeFile(join(directory, "GeoLite2-City.mmdb"), fixture);
    const archive = join(temp, "fixture.tar.gz");
    await c({ gzip: true, cwd: temp, file: archive }, ["GeoLite2-City_fixture/GeoLite2-City.mmdb"]);
    const bytes = await readFile(archive);
    process.env.GEOIP_CITY_DB_PATH = join(temp, "active.mmdb");
    process.env.MAXMIND_ACCOUNT_ID = "fixture";
    process.env.MAXMIND_LICENSE_KEY = "fixture";
    globalThis.fetch = async () => new Response(bytes);
    assert.equal(await updateGeoCity(), true);
    assert.deepEqual(await readFile(process.env.GEOIP_CITY_DB_PATH), fixture);
    assert.equal(await updateGeoCity(), true); // Replace an existing file atomically.
    assert.equal(await reloadCityDatabase(), true);
    assert.equal(lookupAnalyticsCity("81.2.69.160")?.city, "London");
    assert.equal(lookupAnalyticsCity("81.2.69.160")?.accuracyRadiusKm, 100);
    const misses = geoMetrics.misses;
    assert.equal(lookupAnalyticsCity("8.8.8.8"), null);
    assert.equal(geoMetrics.misses, misses + 1);
    globalThis.fetch = async () => new Response("failed", { status: 503 });
    assert.equal(await updateGeoCity(), false);
    assert.equal(await updateGeoCity(), false);
    const state = JSON.parse(await readFile(`${process.env.GEOIP_CITY_DB_PATH}.update-state.json`, "utf8"));
    assert.equal(state.consecutiveFailures, 2);
    assert.deepEqual(await readFile(process.env.GEOIP_CITY_DB_PATH), fixture);
    await writeFile(process.env.GEOIP_CITY_DB_PATH, "corrupt");
    assert.equal(await reloadCityDatabase(), false);
    assert.equal(lookupAnalyticsCity("81.2.69.160")?.city, "London");
    process.env.GEOIP_CITY_ENABLED = "false";
    assert.equal(lookupAnalyticsCity("81.2.69.160"), null);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["GEOIP_CITY_ENABLED", "GEOIP_CITY_DB_PATH", "MAXMIND_ACCOUNT_ID", "MAXMIND_LICENSE_KEY"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  }
} finally { await rm(temp, { recursive: true, force: true }); }
console.log("geoLocation: provider, serialization, coverage, HTTP proxy and failure checks passed");
