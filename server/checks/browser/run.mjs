import { readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every browser check, with the harness started and stopped for you.
 *
 * These are the only checks that open the real editor in a real browser, and
 * until now nothing ran them — `checks/run.ts` picks up `checks/*.ts` and never
 * looks in here. They rotted exactly as you would expect: four of the five had
 * been broken by ordinary refactors and said nothing, because the way to run
 * them was three manual steps somebody had to remember.
 *
 *   npm run checks:browser
 *
 * It refuses rather than skips when Playwright is missing. A browser suite that
 * quietly exits zero on a machine with no browser is worse than one that is
 * never run, because it reports success for work it did not do.
 */
const here = dirname(fileURLToPath(import.meta.url));
const client = join(here, "..", "..", "client");
const windows = process.platform === "win32";
const PORT = 5199;
/** The address the checks themselves use; Vite's default bind does not answer on it. */
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;

/** An installed Playwright, as a file: URL — a bare specifier will not resolve from here on Windows. */
function findPlaywright() {
  if (process.env.PLAYWRIGHT_URL) return process.env.PLAYWRIGHT_URL;
  const resolved = spawnSync(process.execPath, ["-e", "process.stdout.write(require.resolve('playwright'))"], {
    cwd: client,
    encoding: "utf8",
  });
  if (resolved.status !== 0 || !resolved.stdout) return null;
  return new URL(`file:///${resolved.stdout.replace(/\\/g, "/")}`).href;
}

const playwright = findPlaywright();
if (!playwright) {
  console.error(
    "Browser checks need Playwright, and none was found.\n" +
      "  Install it where this can see it (`npm --prefix client i -D playwright`),\n" +
      "  or point PLAYWRIGHT_URL at an installed copy's index.mjs as a file:/// URL.",
  );
  process.exit(2);
}

const already = await fetch(`${BASE}/builder-harness.html`).then((response) => response.ok).catch(() => false);

let vite = null;
if (already) {
  console.log(`Using the harness already serving on ${BASE}.`);
} else {
  console.log(`Starting the harness on ${BASE}…`);
  vite = spawn("npm", ["--prefix", "client", "exec", "--", "vite", "--port", String(PORT), "--strictPort", "--host", HOST], {
    cwd: join(here, "..", ".."),
    stdio: "ignore",
    shell: windows,
  });
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    up = await fetch(`${BASE}/builder-harness.html`).then((response) => response.ok).catch(() => false);
    if (up) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!up) {
    vite.kill();
    console.error(`The harness did not come up on ${BASE} within a minute.`);
    process.exit(1);
  }
}

const files = readdirSync(here)
  .filter((name) => name.endsWith(".mjs") && name !== "run.mjs")
  .sort();

let failed = 0;
try {
  for (const file of files) {
    console.log(`\n── ${file} ${"─".repeat(Math.max(0, 56 - file.length))}`);
    const result = spawnSync(process.execPath, [join(here, file)], {
      cwd: join(here, "..", ".."),
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_URL: playwright },
    });
    if (result.status !== 0) failed += 1;
  }
} finally {
  // Leave a harness somebody else started running; only stop the one we made.
  if (vite) vite.kill();
}

console.log(`\n${files.length - failed} of ${files.length} browser check(s) passed`);
process.exit(failed > 0 ? 1 : 0);
