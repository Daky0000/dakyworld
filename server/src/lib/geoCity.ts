import { readFile } from "node:fs/promises";
import { countryMetrics } from "./analyticsCountry.js";
import { Reader, AddressNotFoundError } from "@maxmind/geoip2-node";
import { Reader as MetadataReader } from "maxmind";
import type { GeoResult } from "./demoGeo.js";

let active: ReturnType<typeof Reader.openBuffer> | null = null;
let version: string | null = null;
export const geoMetrics = { hits: 0, misses: 0, failures: 0, fallbacks: 0, reloadFailures: 0 };

export function validateCityDatabase(buffer: Buffer) {
  const metadata = new MetadataReader(buffer).metadata;
  if (metadata.databaseType !== "GeoLite2-City") throw new Error("Expected GeoLite2-City database");
  const date = metadata.buildEpoch;
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 86400000) throw new Error("Invalid database build date");
  return { reader: Reader.openBuffer(buffer), version: date.toISOString() };
}

export async function reloadCityDatabase(path = process.env.GEOIP_CITY_DB_PATH): Promise<boolean> {
  if (!path) return false;
  try {
    const next = validateCityDatabase(await readFile(path));
    active = next.reader;
    version = next.version;
    return true;
  } catch {
    geoMetrics.reloadFailures++;
    console.warn("[geo] database_reload_failed; retaining last valid reader");
    return false;
  }
}

export function lookupAnalyticsCity(ip: string): GeoResult | null {
  if (process.env.GEOIP_CITY_ENABLED !== "true" || !active) { geoMetrics.fallbacks++; return null; }
  try {
    const result = active.city(ip);
    const country = result.country?.isoCode;
    if (!country) { geoMetrics.misses++; return null; }
    geoMetrics.hits++;
    return { country, city: result.city?.names?.en || null,
      region: result.subdivisions?.[0]?.names?.en || null,
      accuracyRadiusKm: result.location?.accuracyRadius ?? null, databaseVersion: version };
  } catch (error) {
    if (error instanceof AddressNotFoundError) geoMetrics.misses++;
    else geoMetrics.failures++;
    return null;
  }
}

export function startGeoDatabaseMonitor() {
  let running = false;
  let lastUpdate = 0;
  const refresh = async () => {
    if (running) return;
    running = true;
    try {
      const enabled = process.env.GEOIP_CITY_ENABLED === "true";
      if (!lastUpdate && process.env.GEOIP_CITY_DB_PATH) {
        try {
          const state = JSON.parse(await readFile(`${process.env.GEOIP_CITY_DB_PATH}.update-state.json`, "utf8"));
          lastUpdate = Math.max(Date.parse(state.lastSuccess) || 0, Date.parse(state.lastFailure) || 0);
        } catch { /* No completed update yet. */ }
      }
      if (enabled && process.env.GEOIP_AUTO_UPDATE === "true" && Date.now() - lastUpdate >= 86400000) {
        lastUpdate = Date.now();
        const { updateGeoCity } = await import("./updateGeoCity.js");
        await updateGeoCity();
      }
      if (enabled) await reloadCityDatabase();
      const stale = !version || Date.now() - Date.parse(version) > 7 * 86400000;
      console.info("[geo] health", { ...geoMetrics, country: countryMetrics, available: Boolean(active), stale, databaseVersion: version });
      if (enabled && stale) console.warn("[geo] alert: database_missing_or_older_than_seven_days");
    } catch { console.warn("[geo] refresh_failed"); } finally { running = false; }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 3600000);
  timer.unref();
  return () => clearInterval(timer);
}
