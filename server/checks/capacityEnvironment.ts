import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "dakyworld-capacity-check-"));
const envPath = join(directory, ".env");
const moduleUrl = new URL("../src/lib/capacity.ts", import.meta.url).href;
try {
  writeFileSync(envPath, "SERVICE_ROLE=worker\nAI_CONCURRENCY=3\n");
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: envPath,
    RESPONSE_CACHE_ENABLED: "false", CACHE_FALLBACK_CONCURRENCY: "20",
    AI_PENDING_LIMIT: "200", AI_DAILY_USER_LIMIT: "2", API_READ_CONCURRENCY: "50", API_WRITE_CONCURRENCY: "20" };
  delete env.SERVICE_ROLE;
  delete env.AI_CONCURRENCY;
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    `const { capacity } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(capacity));`],
  { env, encoding: "utf8", timeout: 15_000 });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).role, "worker", "role loads before capacity is initialized");
  assert.equal(JSON.parse(result.stdout).aiConcurrency, 3);
  writeFileSync(envPath, "SERVICE_ROLE=worker\nAI_CONCURRENCY=invalid\n");
  const invalid = run();
  assert.notEqual(invalid.status, 0, "invalid .env settings fail at boot");
  assert.match(invalid.stderr, /Invalid AI_CONCURRENCY/);
  console.log("Capacity .env ordering and startup validation checks passed.");
} finally {
  rmSync(envPath, { force: true });
  rmdirSync(directory);
}
