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

  // --- Two viewports of one page, in one run --------------------------------
  //
  // The shape the website audit asks for, and the reason a page may carry its
  // own viewport. Two runs would be two container boots and two browser starts
  // for two pictures of the same page, and the boot is nearly the whole cost.
  console.log("\nThe laptop and the phone picture of one page, in one run");
  {
    const rows = await runActor({
      urls: [
        { id: "audit_desktop", url: site("/tall") },
        { id: "audit_mobile", url: site("/tall"), viewport: { width: 390, height: 844 }, maxHeight: 3200 },
      ],
      viewport: { width: 1280, height: 800 },
      fullPage: true,
      delay: 0,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      navigationTimeoutMs: 8000,
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    const desktop = byId.get("audit_desktop");
    const mobile = byId.get("audit_mobile");

    check("both pictures come out of one run", rows.length === 2 && rows.every((row) => row.success), rows.map((row) => row.error?.code).join(", "));
    check("the run's viewport is used where a page named none", desktop?.viewportWidth === 1280 && desktop?.viewportHeight === 800);
    check("and a page's own viewport overrides it", mobile?.viewportWidth === 390 && mobile?.viewportHeight === 844);
    check("the laptop picture is the model width", desktop?.width === MAX_WIDTH, `${desktop?.width}`);
    check("the phone picture stays at the phone width", mobile?.width === 390, `${mobile?.width}`);
    // 2400 rows of a 1280 capture shrunk to 1024, against 3200 rows of a 390
    // capture that is never shrunk: the crop travels with the page too.
    check("each page is cropped by its own number", desktop?.height === 1920 && mobile?.height === 3200, `${desktop?.height} / ${mobile?.height}`);
  }

  // --- A page that never finishes loading -----------------------------------
  //
  // The commonest real failure, and the one that produced "the page could not
  // be opened" about a law firm's site that answers a plain request in 1.7
  // seconds. `load` waits for every image, font and script; one that never
  // returns holds it for ever, while the document itself rendered long ago.
  console.log("\nA page held up by one dead asset");
  {
    const rows = await runActor({
      urls: [{ id: "hung", url: site("/hangs-on-asset") }],
      viewport: { width: 1280, height: 800 },
      fullPage: true,
      delay: 0,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      navigationTimeoutMs: 5000,
    });

    const hung = rows[0];
    check("the picture is taken anyway", hung?.success === true, `${hung?.error?.code} ${hung?.error?.message ?? ""}`);
    // Taking it is right; saying so is the honest half. A screenshot of a site
    // that never finished loading carries a caveat, not silence.
    check("and the row says it never finished loading", hung?.partiallyLoaded === true);
    check("it is a real picture, at the model width", hung?.width === MAX_WIDTH, `${hung?.width}`);
  }

  // --- A certificate nothing trusts -----------------------------------------
  //
  // The gap this closed. `companyAudit` has clicked past a certificate warning
  // since Aug 2026; the picture could not follow, because no external actor
  // declared such an input — so a prospect whose certificate had expired got a
  // report that read their page and showed nothing of it.
  console.log("\nA site behind a certificate warning");
  if (!fixtures.secureOrigin) {
    console.log("  skip  no openssl on this machine, so no untrusted certificate to test against");
  } else {
    const rows = await runActor({
      urls: [
        { id: "expired", url: `${fixtures.secureOrigin}/ok` },
        { id: "after_expired", url: site("/ok") },
      ],
      viewport: { width: 1280, height: 800 },
      fullPage: true,
      delay: 0,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      navigationTimeoutMs: 8000,
    });

    const past = rows.find((row) => row.id === "expired");
    check("the picture is taken anyway, as a visitor would", past?.success === true, `${past?.error?.code} ${past?.error?.message ?? ""}`);
    // Not silent. A report showing this picture has to be able to say the
    // connection was not verified, exactly as every other section of it does.
    check("and the row says the connection was not verified", past?.insecure === true);
    check("it is the same page, at the same size", past?.width === MAX_WIDTH, `${past?.width}`);
    check("and the page after it is unaffected", rows.find((row) => row.id === "after_expired")?.success === true);

    // The negative that matters more than the positive: a good certificate is
    // verified normally, so nothing about this makes ordinary pages insecure.
    const plain = rows.find((row) => row.id === "after_expired");
    check("an ordinary page is not marked insecure", plain?.insecure === false);
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
