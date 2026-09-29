import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { x } from "tar";
import { validateCityDatabase } from "./geoCity.js";

/** Download, validate and atomically replace the local database. */
export async function updateGeoCity(): Promise<boolean> {
  // Run in the API process or as a single scheduled job on its host.
  const target = process.env.GEOIP_CITY_DB_PATH;
  if (!target) return false;
  const destination = resolve(target);
  await mkdir(dirname(destination), { recursive: true });
  const lock = `${destination}.update-lock`;
  try { await mkdir(lock); } catch { console.warn("[geo] update_locked"); return false; }
  const statePath = `${destination}.update-state.json`;
  let temp: string | undefined;
  try {
    const account = process.env.MAXMIND_ACCOUNT_ID;
    const key = process.env.MAXMIND_LICENSE_KEY;
    if (!account || !key) throw new Error("MaxMind credentials are required");
    temp = await mkdtemp(join(dirname(destination), ".geo-update-"));
    const response = await fetch("https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz", {
      headers: { Authorization: `Basic ${Buffer.from(`${account}:${key}`).toString("base64")}` },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error("Database download failed");
    const archive = join(temp, "download.tar.gz");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await x({ file: archive, cwd: temp, strict: true,
      filter: (path, entry) => "type" in entry && entry.type === "File" && /^[^/]+\/GeoLite2-City\.mmdb$/.test(path) });
    const entries = await readdir(temp, { withFileTypes: true });
    const folder = entries.find(entry => entry.isDirectory());
    if (!folder) throw new Error("Database missing from archive");
    const candidate = join(temp, folder.name, "GeoLite2-City.mmdb");
    const next = validateCityDatabase(await readFile(candidate));
    try {
      const previous = validateCityDatabase(await readFile(destination));
      if (next.version < previous.version) throw new Error("Database downgrade rejected");
    } catch (error) {
      if ((error as Error).message === "Database downgrade rejected") throw error;
      // Missing or invalid old database can be replaced by a validated database.
    }
    await rename(candidate, destination);
    await writeFile(statePath, JSON.stringify({ consecutiveFailures: 0, lastSuccess: new Date().toISOString(), version: next.version }));
    console.info("[geo] update_success", { version: next.version });
  } catch {
    let failures = 0;
    try { failures = JSON.parse(await readFile(statePath, "utf8")).consecutiveFailures || 0; } catch { /* First update. */ }
    failures++;
    await writeFile(statePath, JSON.stringify({ consecutiveFailures: failures, lastFailure: new Date().toISOString() }));
    console.error("[geo] update_failed", { consecutiveFailures: failures, alert: failures >= 2 });
    return false;
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }

  return true;
}
