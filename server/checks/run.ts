import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs every check in this folder, in its own process.
 *
 * Separate processes rather than imports, because each check owns a Prisma
 * connection and calls `$disconnect` when it is done — one long-lived process
 * sharing a client would have the first check's teardown break the second's
 * first query, which is a failure that looks like the thing under test.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const files = readdirSync(here)
  .filter((name) => name.endsWith(".ts") && name !== "run.ts")
  .sort();

let failed = 0;
for (const file of files) {
  console.log(`\n\u2500\u2500 ${file} ${"\u2500".repeat(Math.max(0, 60 - file.length))}`);
  // A path relative to the server root, not an absolute one. `shell: true` is
  // needed on Windows to find `npx`, and it does not quote arguments — so an
  // absolute path here resolves as far as "…/Dakyworld" and stops, because the
  // repository lives in a folder with a space in its name.
  const result = spawnSync("npx", ["tsx", `checks/${file}`], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    // Set here rather than in each check, because `middleware/auth.ts` reads it
    // into a module constant at import time — a check assigning it after its
    // own imports have run would get 401 and report a defect in the route that
    // is really a defect in the harness. It is force-disabled in production
    // regardless, so this cannot leak past a developer's machine.
    env: { ...process.env, DEV_NO_AUTH: "true" },
  });
  if (result.status !== 0) failed += 1;
}

console.log(`\n${files.length - failed} of ${files.length} check file(s) passed`);
process.exit(failed > 0 ? 1 : 0);
