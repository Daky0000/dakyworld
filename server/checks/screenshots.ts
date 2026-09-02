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
import type { AddressInfo } from "node:net";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

// --- The fake Apify, and a fake picture host --------------------------------

/**
 * Port 0, so the operating system picks a free one.
 *
 * Several checks in this folder bind the same hard-coded port — 4599 is claimed
 * by four of them — which is harmless while `npm run checks` runs them one at a
 * time and is a confusing EADDRINUSE the moment anything runs two at once, as
 * happens whenever somebody works on one file while the suite is going. New
 * files should not add to that.
 */
let PORT = 0;
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
app.use(express.json({ limit: "25mb" }));

app.get("/v2/acts/:actor", (req, res) => {
  if (req.params.actor === "daky_world~missing") return res.status(404).json({ error: { message: "Actor was not found." } });
  res.json({
    data: {
      id: "stub-actor",
      name: "website-screenshot",
      username: "daky_world",
      title: "Dakyworld Website Screenshot",
      defaultRunOptions: { memoryMbytes: 1024, timeoutSecs: 300 },
      pricingInfos: [],
      // A tagged build, because an actor that exists and has never built is not
      // a runnable actor — which is what `screenshotActorReady` now asks.
      taggedBuilds: { latest: { buildId: "build-1" } },
    },
  });
});

app.post("/v2/acts/:actor/runs", (req, res) => {
  if (req.params.actor === "daky_world~missing") {
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
      actId: "daky_world~website-screenshot",
      status: behaviour.status,
      defaultDatasetId: "ds-1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      usageTotalUsd: 0.06,
    },
  });
});

app.get("/v2/datasets/:id/items", (_req, res) => res.json(behaviour.rows));

/** Every body the model layer sent, so an assertion can read the wire. */
const modelRequests: any[] = [];

/**
 * A fake Anthropic, on the same express as the fake Apify.
 *
 * Here rather than in a file of its own because the thing being proved spans
 * both: that the bytes one vendor produced are the bytes the other is handed.
 * Splitting them would mean two harnesses agreeing about a picture, which is
 * the arrangement this whole refactor exists to stop needing.
 */
app.post("/anthropic/v1/messages", (req, res) => {
  modelRequests.push(req.body);
  res.json({
    id: "msg_check_shot",
    type: "message",
    role: "assistant",
    model: req.body?.model ?? "claude-opus-5",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          firstImpression: "A plain page with the practice name and a phone number.",
          observations: [
            { what: "Nothing above the fold says what the practice does.", severity: "HIGH", plainly: "A visitor cannot tell what you offer without scrolling.", region: null },
          ],
          fitsTheBusiness: "It looks like a template, not like an established local practice.",
          worthFixing: { problem: "The first screen says nothing.", costsThem: "Visitors leave before they learn anything.", whyWorthPaying: "One screen of copy fixes it." },
          theOneThing: "Say what you do, on the first screen.",
          states: { trade: "Dental clinic", town: "Kumasi", services: [], phone: null },
        }),
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 220, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
});

app.get("/images/:key", (req, res) => {
  const authorised = req.header("authorization") === `Bearer ${TOKEN}`;
  imageRequests.push({ key: req.params.key, authorised });
  if (imagesNeedToken && !authorised) return res.status(401).end();
  const image = images.get(req.params.key);
  if (!image) return res.status(404).end();
  res.type("image/png").send(image);
});

const server: Server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
PORT = (server.address() as AddressInfo).port;

process.env.APIFY_BASE_URL = `http://127.0.0.1:${PORT}/v2`;
process.env.APIFY_TOKEN = TOKEN;

const settings = await import("../src/lib/settings.js");
settings.clearSettingsCache();

const { prisma } = await import("../src/lib/prisma.js");
const { captureHomepage, captureHomepages, captureHomepageViews, normaliseSiteUrl, PHONE_VIEWPORT_WIDTH } = await import("../src/services/siteShot.js");
const { DEFAULT_SCREENSHOT_ACTOR, screenshotActorId, screenshotActorReady } = await import("../src/services/apifyScreenshot.js");
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
  insecure: false,
  viewportWidth: 1280,
  viewportHeight: 800,
  format: "png",
  durationMs: 4200,
  error: null,
  ...overrides,
});

/**
 * When this run started, so the ledger rows it causes can be taken back out.
 *
 * The vision section below drives a real `callModel`, and a real `callModel`
 * writes an `LlmCall` row. Those are money rows: `checks/costs.ts` sums them
 * over an hour band and asserts on the cache rate, and a handful of uncached
 * rows this file left behind moved that rate enough to fail it — a check
 * failing because of a *different* check is the worst kind of red, because the
 * file that fails is not the file that is wrong.
 *
 * checks/README.md rule 3, which this had broken: a check that creates rows
 * deletes them.
 */
const startedAt = new Date();

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
  check("it runs the Dakyworld actor", startedRuns[0]?.actor === "daky_world~website-screenshot", startedRuns[0]?.actor);
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
  check("it is the same actor as the desktop run", startedRuns[0]?.actor === "daky_world~website-screenshot");
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

  // A picture taken by clicking past a certificate warning is still a picture,
  // and it has to arrive saying so — a report that showed it silently would be
  // presenting something that came over an unverified connection as if it had
  // not. See SECURITY.md.
  await reset();
  behaviour = { status: "SUCCEEDED", rows: [shot("desktop", { insecure: true })] };
  const past = await captureHomepage("example.com");
  check("a picture taken past a certificate warning still arrives", Boolean(past.base64), past.note ?? "");
  check("and is marked as such", past.shot?.insecure === true);
  check("with a sentence a person will read", Boolean(past.note?.includes("unverified connection")), past.note ?? "");

  await reset();
  behaviour = { status: "SUCCEEDED", rows: [shot("desktop")] };
  const ordinary = await captureHomepage("example.com");
  check("an ordinary picture is not marked insecure", ordinary.shot?.insecure === false && ordinary.note === null, ordinary.note ?? "");

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
  await settings.setSetting(SETTING.SCREENSHOT_ACTOR, "daky_world/missing");
  settings.clearSettingsCache();
  check("the setting decides which actor runs", (await screenshotActorId()) === "daky_world/missing");

  const result = await captureHomepage("example.com");
  const note = result.note ?? "";
  // A fixable setting must never reach the Owner as "something went wrong" —
  // the rule in lib/errors.ts, applied to the one failure that is a deploy
  // somebody has not done yet.
  check("it names the actor that is missing", note.includes("daky_world/missing"), note);
  check("and says where to get it", note.includes("apify/dakyworld-screenshot"), note);
  check("rather than reading as an outage", !/something went wrong/i.test(note));

  // And said at boot, rather than waiting for the first audit of the day to
  // come back with no picture and a sentence nobody was looking at.
  const { clearApifyCaches } = await import("../src/lib/apify.js");
  clearApifyCaches();
  await settings.setSetting(SETTING.SCREENSHOT_ACTOR, "daky_world/missing");
  settings.clearSettingsCache();
  check("the boot check notices a missing actor", (await screenshotActorReady())?.ready === false);

  await reset();
  clearApifyCaches();
  check("clearing the setting goes back to the shipped actor", (await screenshotActorId()) === DEFAULT_SCREENSHOT_ACTOR);
  check("and is quiet when the actor is there", (await screenshotActorReady())?.ready === true);
}

// --- 9b. An actor from the store, pointed at by mistake -----------------------
//
// `capture.screenshotActor` still looks like the setting it used to be, which
// was a choice between four store actors. Somebody may well still put one in
// it — and Apify runs it perfectly happily, because it ignores every input key
// an actor does not declare. So the contract is dropped in silence and the
// dataset comes back in that actor's own shape, with no id on any row.
console.log("\nAn actor that does not speak this contract");
{
  await reset();
  await settings.setSetting(SETTING.SCREENSHOT_ACTOR, "i-scraper/website-screenshot");
  settings.clearSettingsCache();

  // What a store screenshot actor actually returns: a picture and an address,
  // and nothing that says which request it belongs to.
  behaviour = {
    status: "SUCCEEDED",
    rows: [
      { url: "https://example.com/", screenshotUrl: `http://127.0.0.1:${PORT}/images/desktop`, startUrl: "https://example.com/" },
      { url: "https://other.com/", screenshotUrl: `http://127.0.0.1:${PORT}/images/desktop`, startUrl: "https://other.com/" },
    ],
  };

  const result = await captureHomepage("example.com");
  const note = result.note ?? "";
  check("no picture is taken from it", result.shot === null && result.base64 === null);
  // The failure worth having. Without it every page in the batch reads "the run
  // finished without producing a result for it" — true, useless, and pointing
  // at the website rather than at the setting that caused it.
  check("it says the actor is the wrong one", note.includes("is not the Dakyworld"), note);
  check("and names the actor that was asked for", note.includes("i-scraper/website-screenshot"), note);
  check("and says a store actor cannot stand in", note.includes("cannot be substituted"), note);
  // No adapter behind the message, on purpose: one actor and one contract is
  // the point, and the answer to a foreign actor is to stop using it.
  check("nothing tries to read its rows anyway", !note.includes("without producing a result"), note);

  await reset();
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
  // "No token" and "the actor is missing" are different states, and a boot
  // warning about a missing actor shown to somebody who has not connected
  // Apify at all is a warning about the wrong thing.
  check("the boot check stays quiet with no token at all", (await screenshotActorReady()) === null);

  process.env.APIFY_TOKEN = TOKEN;
  settings.clearSettingsCache();
}

// --- 11. Both viewports in one run -------------------------------------------
//
// The commonest shape this actor runs, and it used to be two runs. An Apify run
// boots a container and a browser before it does anything useful, so two
// pictures of one homepage cost twice what one did for a second page load
// against a browser that was already open.
console.log("\nThe laptop and the phone picture of one homepage");
{
  await reset();
  behaviour = {
    status: "SUCCEEDED",
    rows: [
      shot("desktop", { id: "desktop", url: "https://example.com/" }),
      shot("phone", { id: "mobile", url: "https://example.com/", width: 390, height: 1400, viewportWidth: 390, viewportHeight: 844 }),
    ],
  };

  const views = await captureHomepageViews("example.com");
  const body = startedRuns[0]?.body;

  check("it is one run, not two", startedRuns.length === 1, `${startedRuns.length} run(s)`);
  check("carrying both pages", body?.urls?.length === 2, `${body?.urls?.length}`);

  const [first, second] = body?.urls ?? [];
  check("the first is a laptop", first?.viewport?.width === 1280 && first?.viewport?.height === 800, JSON.stringify(first?.viewport));
  check("the second is a phone", second?.viewport?.width === 390 && second?.viewport?.height === 844, JSON.stringify(second?.viewport));
  // A phone page is roughly three times as tall for the same content, so the
  // crop has to travel with the page rather than with the run.
  check("each page carries its own crop", first?.maxHeight === 2400 && second?.maxHeight === 3200, `${first?.maxHeight} / ${second?.maxHeight}`);

  check("both pictures come back", Boolean(views.desktop.base64 && views.mobile.base64), `${views.desktop.note ?? ""} ${views.mobile.note ?? ""}`);
  check("the laptop one is the laptop one", views.desktop.shot?.viewportWidth === 1280 && views.desktop.shot?.width === 1024);
  check("and the phone one is the phone one", views.mobile.shot?.viewportWidth === 390 && views.mobile.shot?.width === 390);

  // The reversal that came with putting them in one run: the phone picture used
  // to be asked for only when the laptop one worked, because it meant a second
  // bill. Inside one run it is one more page load, and a site that serves one
  // viewport and breaks on the other is the thing the phone shot is *for*.
  await reset();
  behaviour = {
    status: "SUCCEEDED",
    rows: [
      shot("desktop", { id: "desktop", url: "https://example.com/" }),
      {
        ...shot("phone", { id: "mobile", url: "https://example.com/" }),
        success: false,
        screenshotUrl: null,
        error: { code: "PAGE_TIMEOUT", message: "The page did not finish loading within 45 seconds." },
      },
    ],
  };
  const half = await captureHomepageViews("example.com");
  check("one viewport failing does not cost the other its picture", Boolean(half.desktop.base64) && half.mobile.shot === null);
  check("and the failure is still a sentence", Boolean(half.mobile.note?.includes("did not finish loading")), half.mobile.note ?? "");

  await reset();
  const bad = await captureHomepageViews("not a web address");
  check("a bad address still starts no run", startedRuns.length === 0 && bad.desktop.shot === null && bad.mobile.shot === null);
}

// --- 12. The picture reaches the vision model --------------------------------
//
// The end of the line, and the one assertion that spans the whole refactor: the
// bytes the actor produced are the bytes a model is handed. Everything above
// this proves a picture came back; this proves it arrives where it is going,
// in the shape the vision half has always been given.
console.log("\nWhat the vision model is actually sent");
{
  await reset();
  behaviour = { status: "SUCCEEDED", rows: [shot("desktop", { cropped: true, fullScreenshotUrl: `http://127.0.0.1:${PORT}/images/full` })] };

  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}/anthropic`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  // The other vendors must stay unconnected, or the routing chain reaches one
  // of them and this asserts on the wrong wire.
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "NVIDIA_API_KEY"]) {
    process.env[key] = "";
  }
  settings.clearSettingsCache();

  const { lookAtHomepage } = await import("../src/services/homepageLook.js");
  const result = await lookAtHomepage({ website: "example.com", companyName: "Adom Dental" });

  const body = modelRequests[0];
  const image = (body?.messages?.[0]?.content ?? []).find((part: any) => part?.type === "image");
  check("the model is sent a picture", Boolean(image), `${result.notes.join(" ")}`);
  check("as PNG", image?.source?.media_type === "image/png", image?.source?.media_type);
  check("base64, not a link that expires", image?.source?.type === "base64" && !String(image?.source?.data ?? "").startsWith("http"));
  // The whole point. Not "a picture of the right size" — the actual bytes the
  // actor produced and this server downloaded.
  check("and the bytes are the ones the actor produced", image?.source?.data === images.get("desktop")!.toString("base64"));

  const words = (body?.messages?.[0]?.content ?? []).find((part: any) => part?.type === "text")?.text ?? "";
  check("the picture comes before the words", (body?.messages?.[0]?.content ?? [])[0]?.type === "image");
  check("the model is told what it is looking at", words.includes("example.com"), words.slice(0, 80));
  check("and at what size", words.includes("1024 by 1920"), words.slice(0, 200));
  check("including that it was cut down", words.includes("cropped to the top of the page"));
  check("the look comes back", result.look !== null, result.notes.join(" "));
  check("with the picture beside it", result.shot?.width === 1024 && result.shot?.height === 1920);

  process.env.ANTHROPIC_BASE_URL = "";
  process.env.ANTHROPIC_API_KEY = "";
  settings.clearSettingsCache();
}

await reset();
// The ledger rows the vision section caused. Scoped to this run's own purpose
// and to the moment it started, so a real call recorded by anything else is
// never touched.
await prisma.llmCall.deleteMany({ where: { purpose: "lead.homepageLook", createdAt: { gte: startedAt } } });
await prisma.$disconnect();
server.close();

console.log(bad === 0 ? "\nAll screenshot checks passed" : `\n${bad} screenshot check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
