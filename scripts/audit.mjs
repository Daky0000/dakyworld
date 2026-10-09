#!/usr/bin/env node
/**
 * npm audit for what ships, with written-down exceptions.
 *
 *   node scripts/audit.mjs                       server and server/client, shipped dependencies only
 *   node scripts/audit.mjs --allowlist <file>    the same against another list (proving it can fail)
 *
 * Fails on any high or critical advisory that is not in scripts/audit-allowlist.json,
 * and on any allowlist entry whose review date has passed. Moderate and low
 * advisories are printed and never fail, the same line `--audit-level=high` drew.
 *
 * Why not plain `npm audit --audit-level=high`: runtime Tailwind 3 (the
 * customer-page CSS build in services/website/cdnStyles.ts) pulls in braces,
 * which has a high advisory with no fixed release at all. It is unreachable
 * here, because Tailwind is given raw content and never a glob, but the plain
 * command fails on it for ever. A gate that always fails gets ignored, and then
 * it misses the advisory that matters. Each exception records why it is safe and
 * when to look again. Remove the entry when Tailwind 4 lands.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// `--allowlist <file>` exists to prove the gate still fails: point it at an
// empty list and the run must go red.
const allowlistFlag = process.argv.indexOf("--allowlist");
const allowlistPath = allowlistFlag > -1 ? process.argv[allowlistFlag + 1] : join(root, "scripts", "audit-allowlist.json");
const PACKAGES = [
  { name: "server", dir: join(root, "server") },
  { name: "client", dir: join(root, "server", "client") },
];
const FAILING = new Set(["high", "critical"]);
const today = new Date().toISOString().slice(0, 10);

const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")).accepted ?? [];
const used = new Set();
let failed = false;

function advisoryId(url) {
  return String(url ?? "").split("/").pop() || "unknown";
}

for (const target of PACKAGES) {
  // npm is npm.cmd on Windows and needs a shell there; a fixed command string
  // (nothing interpolated) avoids Node's warning about shell arguments.
  const options = { cwd: target.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const run = process.platform === "win32"
    ? spawnSync("npm audit --omit=dev --json", { ...options, shell: true })
    : spawnSync("npm", ["audit", "--omit=dev", "--json"], options);
  let report;
  try {
    report = JSON.parse(run.stdout || "{}");
  } catch {
    console.error(`${target.name}: npm audit did not return JSON (exit ${run.status}).\n${(run.stderr || "").slice(0, 800)}`);
    failed = true;
    continue;
  }
  if (report.error) {
    console.error(`${target.name}: npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
    failed = true;
    continue;
  }

  // The advisories themselves. A package whose `via` is only other package
  // names inherits its severity from these, so judging the roots judges all.
  const advisories = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = advisoryId(via.url);
      advisories.set(`${id}|${via.name}`, { id, pkg: via.name, severity: via.severity, title: via.title });
    }
  }

  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(`${target.name}: ${counts.total ?? 0} finding(s) — ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`);

  for (const advisory of advisories.values()) {
    const entry = allowlist.find((a) => a.advisory === advisory.id && a.package === advisory.pkg && (a.where ?? target.name) === target.name);
    if (!FAILING.has(advisory.severity)) {
      console.log(`  ${advisory.severity.padEnd(8)} ${advisory.pkg} ${advisory.id} — reported, not failing`);
      continue;
    }
    if (!entry) {
      console.error(`  FAIL     ${advisory.pkg} ${advisory.id} (${advisory.severity}): ${advisory.title}`);
      failed = true;
      continue;
    }
    used.add(entry);
    if (!entry.reviewBy || entry.reviewBy < today) {
      console.error(`  FAIL     ${advisory.pkg} ${advisory.id}: its acceptance expired on ${entry.reviewBy ?? "(no date)"}. Re-read the advisory and the reason in audit-allowlist.json, then move the date or remove the entry.`);
      failed = true;
      continue;
    }
    console.log(`  accepted ${advisory.pkg} ${advisory.id} (${advisory.severity}) until ${entry.reviewBy}: ${entry.reason}`);
  }
}

for (const entry of allowlist) {
  if (!used.has(entry)) console.log(`note: ${entry.package} ${entry.advisory} is in the allowlist but no longer reported. Remove it.`);
}

if (failed) {
  console.error("Dependency audit failed.");
  process.exit(1);
}
console.log("Dependency audit passed.");
