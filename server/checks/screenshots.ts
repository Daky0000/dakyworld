/**
 * Homepage screenshots, against a fake Apify.
 *
 * The thing being proved is that a picture reaches the business that asked for
 * it, and that every ordinary way a stranger's website can misbehave arrives
 * as a sentence rather than an exception.
 *
 * The defect this file exists for is the second kind. Until 2 Sep 2026 the
 * server spoke four different screenshot actors' input schemas and matched
 * dataset rows back to requests by looking for the address inside the row,
 * falling back to position when no row carried one. A batch where one page
 * failed part-way through therefore shifted every picture after it onto the
 * *next* business — and a picture attached to the wrong business is a report,
 * an email and sometimes a public demo page carrying somebody's name that is
 * not theirs. Every request now carries an id and every row carries it back;
 * the assertions below are what stops that being quietly undone.
 *
 * What each section is here to catch:
 *
 *  - **Rows are matched by id, never by position.** The stub deliberately
 *    returns them shuffled, with one missing, to make position wrong.
 *  - **A bad address never starts a run.** Apify is money.
 *  - **The body is the contract**: a viewport, `fullPage`, a delay and the two
 *    numbers that decide what the vision model is sent. No actor-shaped keys,
 *    and the phone run differs from the desktop run only in the viewport.
 *  - **Every failure is a different sentence.** A run that failed, an actor
 *    that is not on the account, a page that timed out and a picture that came
 *    back the wrong shape send a person to four different places.
 *  - **A private actor's picture is still downloadable.** The key-value store
 *    of a private run can refuse an anonymous read, and a 401 there would look
 *    exactly like a website blocking us.
 *
 * A database and a local express. No key: `APIFY_BASE_URL` points the real
 * client at the stub and `APIFY_TOKEN=stub` lets the real readiness gate pass
 * for the real reason — see checks/README.md.
 */
import express from "express";
import type { Server } from "node:http";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

// --- The fake Apify, and a fake picture host --------------------------------

const PORT = 4601;
const TOKEN = "stub-token-never-print-me";

/** What the next run will do. Set per scenario. */
let behaviour: { status: string; rows: Record<string, unknown>[] } = { status: "SUCCEEDED", rows: [] };
let startedRuns: { actor: string; body: any; query: Record<string, unknown> }[] = [];
/** Set to refuse an anonymous image read, the way a private store does. */
let imagesNeedToken = false;
let imageRequests: { key: string; authorised: boolean }[] = [];

const { encodePng } = await import("../src/services/png.js");

/** A real PNG of the given size, so `pngSize` reads it rather than guessing. */
function picture(width: number, height: number): Buffer {
  const pixels = new Uint8Array(width * height * 4).fill(0x88);
  return encodePng(width, height, pixels);
}

const images = new Map<string, Buffer>([
  ["desktop", picture(1024, 1920)],
  ["full", picture(1280, 9000)],
  ["phone", picture(390, 1400)],
  // Past MAX_IMAGE_EDGE. Every vendor rejects it, so this app has to first.
  ["enormous", picture(9000, 20)],
]);

const app = express();
app.use(express.json());

app.get("/v2/acts/:actor", (req, res) => {
  if (req.params.actor === "dakyworld~missing") return res.status(404).json({ error: { message: "Actor was not found." } });
  res.json({
    data: {
      id: "stub-actor",
      name: "website-screenshot",
      username: "dakyworld",
      title: "Dakyworld Website Screenshot",
      defaultRunOptions: { memoryMbytes: 1024, timeoutSecs: 300 },
      pricingInfos: [],
      taggedBuilds: {},
    },
  });
});

app.post("/v2/acts/:actor/runs", (req, res) => {
  if (req.params.actor === "dakyworld~missing") {
    return res.status(404).json({ error: { type: "record-not-found", message: "Actor was not found." } });
  }
  startedRuns.push({ actor: req.params.actor, body: req.body, query: req.query as Record<string, unknown> });
  res.json({
    data: { id: `run-${startedRuns.length}`, actId: req.params.actor, status: "RUNNING", defaultDatasetId: "ds-1", startedAt: new Date().toISOString() },
  });
});

app.get("/v2/actor-runs/:id", (req, res) => {
  res.json({
    data: {
      id: req.params.id,
      actId: "dakyworld~website-screenshot",
      status: behaviour.status,
      defaultDatasetId: "ds-1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      usageTotalUsd: 0.06,
    },
  });
});

app.get("/v2/datasets/:id/items", (_req, res) => res.json(behaviour.rows));

app.get("/images/:key", (req, res) => {
  const authorised = req.header("authorization") === `Bearer ${TOKEN}`;
  imageRequests.push({ key: req.params.key, authorised });
  if (imagesNeedToken && !authorised) return res.status(401).end();
  const image = images.get(req.params.key);
  if (!image) return res.status(404).end();
  res.type("image/png").send(image);
});

const server: Server = app.listen(PORT, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));

process.env.APIFY_BASE_URL = `http://127.0.0.1:${PORT}/v2`;
process.env.APIFY_TOKEN = TOKEN;

const settings = await import("../src/lib/settings.js");
settings.clearSettingsCache();

const { prisma } = await import("../src/lib/prisma.js");
const { captureHomepage, captureHomepages, normaliseSiteUrl, PHONE_VIEWPORT_WIDTH } = await import("../src/services/siteShot.js");
const { DEFAULT_SCREENSHOT_ACTOR, screenshotActorId } = await import("../src/services/apifyScreenshot.js");
const { SETTING } = settings;

const shot = (key: string, overrides: Record<string, unknown> = {}) => ({
  id: "s0",
  url: "https://example.com/",
  finalUrl: "https://example.com/",
  success: true,
  screenshotUrl: `http://127.0.0.1:${PORT}/images/${key}`,
  fullScreenshotUrl: null,
  width: 1024,
  height: 1920,
  fullWidth: 1280,
  fullHeight: 2400,
  cropped: false,
  viewportWidth: 1280,
  viewportHeight: 800,
  format: "png",
  durationMs: 4200,
  error: null,
  ...overrides,
});

async function reset() {
  await prisma.appSetting.deleteMany({ where: { key: SETTING.SCREENSHOT_ACTOR } });
  settings.clearSettingsCache();
  startedRuns = [];
  imageRequests = [];
  imagesNeedToken = false;
}

await reset();

// --- 1. Addresses ------------------------------------------------------------
console.log("\nWhat counts as a web address");
{
  check("a bare host gains https", normaliseSiteUrl("dakyworld.com") === "https://dakyworld.com/");
  check("http is left alone", normaliseSiteUrl("http://x.com/a") === "http://x.com/a");
  check("a scheme that is not the web is refused", normaliseSiteUrl("javascript:alert(1)") === null);
  check("something with no dot in it is refused", normaliseSiteUrl("localhost") === null);
  check("and so is nothing at all", normaliseSiteUrl("   ") === null);

  behaviour = { status: "SUCCEEDED", rows: [] };
  const result = await captureHomepage("not a web address");
  check("a bad address never starts a run", startedRuns.length === 0, `${startedRuns.length} run(s)`);
  check("and says so in words a person could act on", Boolean(result.note?.includes("not a web address")), result.note ?? "");
  check("with no picture attached", result.shot === null && result.base64 === null);
}

// --- 2. The body that goes to Apify ------------------------------------------
console.log("\nThe run body");
{
  await reset();
  behaviour = { status: "SUCCEEDED", rows: [shot("desktop")] };
  await captureHomepage("example.com");

  const body = startedRuns[0]?.body;
  check("it runs the Dakyworld actor", startedRuns[0]?.actor === "dakyworld~website-screenshot", startedRuns[0]?.actor);
  check("the address is normalised before it is sent", body?.urls?.[0]?.url === "https://example.com/", body?.urls?.[0]?.url);
  check("every request carries an id", typeof body?.urls?.[0]?.id === "string" && body.urls[0].id.length > 0);
  check("the viewport is a laptop", body?.viewport?.width === 1280 && body?.viewport?.height === 800, JSON.stringify(body?.viewport));
  check("the whole page is asked for", body?.fullPage === true);
  check("with the delay that lets fonts arrive", body?.delay === 3000, `${body?.delay}`);
  check("the picture is cut down for the model", body?.maxWidth === 1024 && body?.maxHeight === 2400, JSON.stringify([body?.maxWidth, body?.maxHeight]));

  // The whole of the contract. An extra key here is a key somebody added for
  // one actor's benefit, which is the thing this refactor removed.
  const keys = Object.keys(body ?? {}).sort();
  check("and nothing else is sent", keys.join(",") === "delay,fullPage,maxHeight,maxWidth,urls,viewport", keys.join(","));

  // Memory and the clock are query parameters rather than body keys, and both
  // scale with the batch: one page wants a browser, twenty want room to work.
  const one = startedRuns[0]?.query ?? {};
  check("a single page is given a browser's worth of memory", one.memory === "1024", `${one.memory}`);
  check("and a clock that covers a boot plus a page", one.timeout === "110", `${one.timeout}`);
}

// --- 3. The phone run --------------------------------------------------------
console.log("\nThe phone view differs only in the viewport");
{
  await reset();
  behaviour = { status: "SUCCEEDED", rows: [shot("phone", { width: 390, height: 1400, viewportWidth: 390, viewportHeight: 844 })] };
  const result = await captureHomepage("example.com", { viewportWidth: PHONE_VIEWPORT_WIDTH, keepRows: 3200 });

  const body = startedRuns[0]?.body;
  check("the viewport is a real phone", body?.viewport?.width === 390 && body?.viewport?.height === 844, JSON.stringify(body?.viewport));
  // Three quarters of 390 is a 293px window, which is not a shape any site was
  // designed against — the height must be a device height, not a fraction.
  check("its height is a device height, not a fraction of the width", body?.viewport?.height === 844);
  check("more of the page is kept, because a phone page is taller", body?.maxHeight === 3200, `${body?.maxHeight}`);
  check("it is the same actor as the desktop run", startedRuns[0]?.actor === "dakyworld~website-screenshot");
  check("and the picture is not blown up to the model width", result.shot?.width === 390, `${result.shot?.width}`);
}

// --- 4. Matching by id -------------------------------------------------------
//
// The section this file was written for.
console.log("\nA batch where one page fails");
{
  await reset();
  const sites = ["one.com", "two.com", "three.com", "four.com", "five.com"];
  const body = () => startedRuns[0]?.body;

  behaviour = {
    status: "SUCCEEDED",
    rows: [
      // Deliberately shuffled, and `s2` is missing entirely. Position would
      // put four.com's picture on three.com and run off the end.
      shot("desktop", { id: "s4", url: "https://five.com/", finalUrl: "https://five.com/" }),
      shot("desktop", { id: "s0", url: "https://one.com/", finalUrl: "https://www.one.com/" }),
      shot("desktop", { id: "s3", url: "https://four.com/", finalUrl: "https://four.com/" }),
      {
        ...shot("desktop", { id: "s1", url: "https://two.com/" }),
        success: false,
        screenshotUrl: null,
        error: { code: "PAGE_TIMEOUT", message: "The page did not finish loading within 45 seconds." },
      },
    ],
  };

  const results = await captureHomepages(sites);
  check("one run covers the whole batch", startedRuns.length === 1, `${startedRuns.length}`);
  check("a bigger batch is given more memory", startedRuns[0]?.query?.memory === "2048", `${startedRuns[0]?.query?.memory}`);
  // Capped, so one stuck site cannot hold a run open for an hour.
  check("and a longer clock, capped", startedRuns[0]?.query?.timeout === "190", `${startedRuns[0]?.query?.timeout}`);
  check("five pages went out in it", body()?.urls?.length === 5, `${body()?.urls?.length}`);
  check("with five distinct ids", new Set((body()?.urls ?? []).map((entry: any) => entry.id)).size === 5);

  check("every requested site gets an answer", sites.every((site) => results.has(site)));
  check("the first site keeps its own picture", results.get("one.com")?.shot?.finalUrl === "https://www.one.com/", results.get("one.com")?.shot?.finalUrl ?? "");
  // The regression itself: `three.com` has no row at all, so a position-based
  // match would hand it `four.com`'s picture.
  check("a site with no row gets no picture", results.get("three.com")?.shot === null);
  check("and is told the run produced nothing for it", Boolean(results.get("three.com")?.note?.includes("three.com")), results.get("three.com")?.note ?? "");
  check("the sites after the gap keep their own pictures", results.get("four.com")?.shot?.finalUrl === "https://four.com/" && results.get("five.com")?.shot?.finalUrl === "https://five.com/");
  check("a timed-out page says it timed out", Boolean(results.get("two.com")?.note?.includes("did not finish loading")), results.get("two.com")?.note ?? "");
  check("and the successful pictures survive it", ["one.com", "four.com", "five.com"].every((site) => results.get(site)?.base64));

  // Apify bills the run; the number worth knowing is what one picture cost.
  const each = results.get("one.com")?.shot?.costUsd;
  check("the run's cost is shared across the pictures that came back", each != null && Math.abs(each - 0.06 / 3) < 0.0001, `${each}`);
}

// --- 5. The same site twice --------------------------------------------------
console.log("\nThe same site asked for twice");
{
  await reset();
  behaviour = { status: "SUCCEEDED", rows: [shot("desktop", { id: "s0", url: "https://same.com/" })] };
  const results = await captureHomepages(["same.com", "same.com"]);
  check("it is photographed once", startedRuns[0]?.body?.urls?.length === 1, `${startedRuns[0]?.body?.urls?.length}`);
  check("and both callers get the picture", Boolean(results.get("same.com")?.base64));
}

// --- 6. The picture itself ---------------------------------------------------
console.log("\nReading the picture back");
{
  await reset();
  behaviour = {
    status: "SUCCEEDED",
    rows: [shot("desktop", { cropped: true, fullScreenshotUrl: `http://127.0.0.1:${PORT}/images/full` })],
  };
  const result = await captureHomepage("example.com");

  check("the model is handed the cut-down picture", result.shot?.width === 1024 && result.shot?.height === 1920, `${result.shot?.width}x${result.shot?.height}`);
  check("read off the bytes rather than taken on trust", imageRequests.some((request) => request.key === "desktop"));
  // Two different pictures for two different readers: a person opening the
  // link should see the whole page, not the crop the model was shown.
  check("a person is linked to the uncut capture", Boolean(result.shot?.imageUrl.endsWith("/full")), result.shot?.imageUrl ?? "");
  check("the uncut one is not downloaded", !imageRequests.some((request) => request.key === "full"));
  check("a cropped picture says so", Boolean(result.note?.includes("longer than this")), result.note ?? "");
  check("the bytes are what was fetched", result.shot?.bytes === images.get("desktop")!.byteLength);

  await reset();
  behaviour = { status: "SUCCEEDED", rows: [shot("enormous", { width: 9000, height: 20 })] };
  const huge = await captureHomepage("example.com");
  check("a picture no model will read is refused", huge.shot === null && Boolean(huge.note?.includes("no model will read")), huge.note ?? "");
}

// --- 7. A private actor's key-value store ------------------------------------
console.log("\nA store that refuses an anonymous read");
{
  await reset();
  imagesNeedToken = true;
  behaviour = { status: "SUCCEEDED", rows: [shot("desktop")] };
  const result = await captureHomepage("example.com");

  check("the anonymous read is tried first", imageRequests[0]?.authorised === false);
  check("a 401 is retried with the token", imageRequests.some((request) => request.authorised));
  check("and the picture arrives", Boolean(result.base64), result.note ?? "");
}

// --- 8. Runs that go wrong ---------------------------------------------------
console.log("\nWhen the run itself fails");
{
  for (const [status, expect] of [
    ["FAILED", "did not finish"],
    ["ABORTED", "did not finish"],
    ["TIMED-OUT", "did not finish"],
  ] as const) {
    await reset();
    behaviour = { status, rows: [] };
    const result = await captureHomepage("example.com");
    check(`a run that ${status.toLowerCase()} is a note, not an exception`, result.shot === null && Boolean(result.note?.includes(expect)), result.note ?? "");
  }

  // A run that succeeded and produced nothing is a different thing again, and
  // must not read as a broken run.
  await reset();
  behaviour = { status: "SUCCEEDED", rows: [] };
  const empty = await captureHomepage("example.com");
  check("an empty dataset is not reported as a failure", Boolean(empty.note?.includes("without producing a result")), empty.note ?? "");
}

// --- 9. An actor that is not on the account ----------------------------------
console.log("\nWhen the actor has not been deployed");
{
  await reset();
  await settings.setSetting(SETTING.SCREENSHOT_ACTOR, "dakyworld/missing");
  settings.clearSettingsCache();
  check("the setting decides which actor runs", (await screenshotActorId()) === "dakyworld/missing");

  const result = await captureHomepage("example.com");
  const note = result.note ?? "";
  // A fixable setting must never reach the Owner as "something went wrong" —
  // the rule in lib/errors.ts, applied to the one failure that is a deploy
  // somebody has not done yet.
  check("it names the actor that is missing", note.includes("dakyworld/missing"), note);
  check("and says where to get it", note.includes("apify/dakyworld-screenshot"), note);
  check("rather than reading as an outage", !/something went wrong/i.test(note));

  await reset();
  check("clearing the setting goes back to the shipped actor", (await screenshotActorId()) === DEFAULT_SCREENSHOT_ACTOR);
}

// --- 10. No Apify at all -----------------------------------------------------
console.log("\nWith no Apify token");
{
  await reset();
  delete process.env.APIFY_TOKEN;
  settings.clearSettingsCache();

  const result = await captureHomepage("example.com");
  check("no run is started", startedRuns.length === 0, `${startedRuns.length}`);
  check("and the Owner is told what to connect", Boolean(result.note?.includes("Apify is not connected")), result.note ?? "");

  process.env.APIFY_TOKEN = TOKEN;
  settings.clearSettingsCache();
}

await reset();
await prisma.$disconnect();
server.close();

console.log(bad === 0 ? "\nAll screenshot checks passed" : `\n${bad} screenshot check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
