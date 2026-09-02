import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScreenshotResult } from "../src/contract.js";
import { startFixtures } from "./fixtures.js";

/**
 * The actor, run for real, against websites that are local and misbehave on
 * purpose.
 *
 * `npm test` from this folder. It needs a Chromium (`npx playwright install
 * chromium`) and nothing else — no Apify account, no token, no network. That
 * is deliberate: a test that needs a credential is a test that stops being
 * run, which is the rule `server/checks/README.md` learned the hard way.
 *
 * It runs `src/main.ts` as its own process with Apify's local storage, exactly
 * as the platform does, and then reads the dataset off disk. Driving the
 * functions directly would have tested the capture and skipped the promise
 * that actually matters — that a batch produces one row per request, carrying
 * the id it arrived with, however many of the pages failed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

/** The width the server asks for, so a picture costs 8 vision tiles rather than 15. */
const MAX_WIDTH = 1024;
/** The fold plus what the first scroll reveals, measured in captured pixels. */
const MAX_HEIGHT = 2400;

async function runActor(input: unknown): Promise<ScreenshotResult[]> {
  const storage = mkdtempSync(join(tmpdir(), "dakyshot-"));
  mkdirSync(join(storage, "key_value_stores", "default"), { recursive: true });
  writeFileSync(join(storage, "key_value_stores", "default", "INPUT.json"), JSON.stringify(input), "utf-8");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "src/main.ts"], {
      cwd: root,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        APIFY_LOCAL_STORAGE_DIR: storage,
        CRAWLEE_STORAGE_DIR: storage,
        // No token, so `createProxyConfiguration` finds no proxy and the actor
        // goes direct — which is the path the fixtures need and, incidentally,
        // proves that an account without proxy access still produces pictures.
        APIFY_TOKEN: "",
        APIFY_IS_AT_HOME: "",
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the actor exited with ${code}`))));
  });

  const dir = join(storage, "datasets", "default");
  const rows = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    // Apify numbers dataset files in push order; sorting numerically rather
    // than lexically keeps row 10 after row 9, which matters for the one
    // assertion here that is about order.
    .sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as ScreenshotResult);

  rmSync(storage, { recursive: true, force: true });
  return rows;
}

const fixtures = await startFixtures();
const site = (path: string) => `${fixtures.origin}${path}`;

try {
  // --- A batch with two broken pages in the middle of it --------------------
  //
  // The shape that produced the defect this refactor exists to end: the run
  // finishes, some pages have no picture, and every remaining picture has to
  // stay attached to the business that asked for it.
  console.log("\nA desktop batch where two of six pages fail");
  {
    const rows = await runActor({
      urls: [
        { id: "lead_short", url: site("/ok") },
        { id: "lead_tall", url: site("/tall") },
        { id: "lead_dead", url: "http://127.0.0.1:1/" },
        { id: "lead_redirect", url: site("/redirect") },
        { id: "lead_nonsense", url: "not a web address" },
        { id: "lead_last", url: site("/ok") },
      ],
      viewport: { width: 1280, height: 800 },
      fullPage: true,
      delay: 200,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      navigationTimeoutMs: 8000,
    });

    check("every requested page produces a row", rows.length === 6, `${rows.length} row(s)`);

    const byId = new Map(rows.map((row) => [row.id, row]));
    check("every id comes back unchanged", ["lead_short", "lead_tall", "lead_dead", "lead_redirect", "lead_nonsense", "lead_last"].every((id) => byId.has(id)));

    // The whole point. Before this, `lead_dead` failing meant `lead_redirect`
    // was handed the picture of the page after it.
    check("a failure does not shift the rows after it", byId.get("lead_last")?.success === true && byId.get("lead_last")?.url === site("/ok"));

    const short = byId.get("lead_short");
    check("a working page succeeds with a picture", short?.success === true && Boolean(short?.screenshotUrl), short?.error?.message);
    check("it is resized down to the model width", short?.width === MAX_WIDTH, `${short?.width}`);
    check("a short page is not cropped", short?.cropped === false, `${short?.height}px`);
    check("the picture is PNG", short?.format === "png");
    check("the viewport it was taken at is on the row", short?.viewportWidth === 1280 && short?.viewportHeight === 800);

    const tall = byId.get("lead_tall");
    check("a page longer than the ceiling is cropped", tall?.cropped === true);
    // 2400 rows of a 1280-wide capture, then shrunk to 1024: 2400 * 0.8.
    check("cropped before it is resized, so the crop is in captured pixels", tall?.height === 1920, `${tall?.height}`);
    check("the uncut capture is kept as well", Boolean(tall?.fullScreenshotUrl));
    check("and the row says how tall the page really was", (tall?.fullHeight ?? 0) > MAX_HEIGHT, `${tall?.fullHeight}`);

    const redirect = byId.get("lead_redirect");
    check("a redirect keeps the address that was asked for", redirect?.url === site("/redirect"));
    check("and reports where it ended up", redirect?.finalUrl === site("/ok"), `${redirect?.finalUrl}`);

    const dead = byId.get("lead_dead");
    check("a site that cannot be reached fails with a code", dead?.success === false && dead?.error?.code === "NAVIGATION_ERROR", dead?.error?.code);
    check("and the run does not throw over it", dead?.screenshotUrl === null);

    const nonsense = byId.get("lead_nonsense");
    check("something that is not a URL never opens a page", nonsense?.error?.code === "INVALID_URL", nonsense?.error?.code);
    check("and costs no time", (nonsense?.durationMs ?? 999) < 100, `${nonsense?.durationMs}ms`);
  }

  // --- A page that never finishes loading -----------------------------------
  console.log("\nA site that never finishes loading");
  {
    const rows = await runActor({
      urls: [
        { id: "slow", url: site("/slow") },
        { id: "after_slow", url: site("/ok") },
      ],
      viewport: { width: 1280, height: 800 },
      fullPage: true,
      delay: 0,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      navigationTimeoutMs: 5000,
    });

    const slow = rows.find((row) => row.id === "slow");
    check("it times out rather than hanging the run", slow?.error?.code === "PAGE_TIMEOUT", slow?.error?.code);
    check("the timeout is a sentence a person could read", Boolean(slow?.error?.message && !/Error:|at Object/.test(slow.error.message)), slow?.error?.message);
    check("and the page after it still gets its picture", rows.find((row) => row.id === "after_slow")?.success === true);
  }

  // --- The phone view -------------------------------------------------------
  console.log("\nThe same actor at a phone viewport");
  {
    const rows = await runActor({
      urls: [{ id: "phone", url: site("/ok") }],
      viewport: { width: 390, height: 844 },
      fullPage: true,
      delay: 200,
      maxWidth: MAX_WIDTH,
      maxHeight: 3200,
      navigationTimeoutMs: 8000,
    });

    const phone = rows[0];
    check("it takes the picture", phone?.success === true, phone?.error?.message);
    check("at the phone width", phone?.width === 390, `${phone?.width}`);
    // A 390px shot blown up to 1024 is the same picture with softer edges and
    // three times the vision tiles to pay for.
    check("and never upscales it to the model width", (phone?.width ?? 0) <= 390);
    check("the row reports the phone viewport", phone?.viewportWidth === 390 && phone?.viewportHeight === 844);
    check("nothing was stored twice for an untouched picture", phone?.fullScreenshotUrl === null);
  }

  // --- Twenty pages ---------------------------------------------------------
  console.log("\nA full batch");
  {
    const urls = Array.from({ length: 20 }, (_, i) => ({ id: `lead_${String(i).padStart(3, "0")}`, url: site(i === 7 ? "/tall" : "/ok") }));
    const rows = await runActor({
      urls,
      viewport: { width: 1280, height: 800 },
      fullPage: true,
      delay: 0,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      navigationTimeoutMs: 8000,
    });

    check("twenty in, twenty out", rows.length === 20, `${rows.length}`);
    check("every id is its own", new Set(rows.map((row) => row.id)).size === 20);
    check("every one of them has a picture", rows.every((row) => row.success), rows.filter((row) => !row.success).map((row) => row.error?.code).join(", "));
    check("the ids come back in the order they went in", rows.map((row) => row.id).join(",") === urls.map((entry) => entry.id).join(","));
  }
} finally {
  await fixtures.close();
}

console.log(bad === 0 ? "\nAll actor checks passed" : `\n${bad} actor check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
