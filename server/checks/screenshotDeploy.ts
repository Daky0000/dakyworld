/**
 * Putting the screenshot actor onto Apify from inside the app, and the monthly
 * ceiling it starts with.
 *
 * Both exist because of the same thing: the app holds the Apify token, and for
 * a while it could do nothing with it that mattered. The actor's source is in
 * this repository and `apify push` deploys it — but that needs the Apify CLI,
 * Docker and a login on somebody's machine, so a perfectly good deployment
 * could sit in front of an account that had never had the actor, with every
 * screenshot failing and no way to fix it from inside the product. Apify's
 * `GIT_REPO` source type is the way round: it clones and builds the public
 * repository itself.
 *
 * What this file is here to catch:
 *
 *  - **It creates the actor only when it is missing, and rebuilds when it is
 *    not.** Running it twice must update rather than fail, because this is how
 *    the actor is *updated* as well as how it first arrives.
 *  - **It never throws.** The callers are a boot log and a settings screen, and
 *    both have to print something a person can act on.
 *  - **It refuses to deploy onto the wrong account.** A token belonging to
 *    somebody else creates an actor under a name nothing will ever call, and
 *    saying so is the difference between a five-second fix and an afternoon.
 *  - **The boot pass tries at most once a day**, so a repository that cannot
 *    build does not cost a build on every deploy.
 *  - **The monthly ceiling is seeded once as a real value**, and clearing it
 *    back to "no ceiling" survives the next boot. That last one is the whole
 *    reason it is seeded rather than defaulted.
 *
 * A database and a local express playing Apify. No token, no network.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

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

/** What the fake Apify does next. Set per scenario. */
let actorExists = false;
let createdUsername = "daky_world";
let buildStatus = "SUCCEEDED";
let buildMessage: string | null = null;
/** Set when a build has succeeded, so the actor becomes runnable. */
let builtOk = false;
let calls: { method: string; path: string; body: any; query: any }[] = [];

const app = express();
app.use(express.json());

app.get("/v2/acts/:actor", (req, res) => {
  calls.push({ method: "GET", path: `/acts/${req.params.actor}`, body: null, query: req.query });
  if (!actorExists) return res.status(404).json({ error: { type: "record-not-found", message: "Actor was not found." } });
  // A tagged build only once one has actually succeeded — which is the whole
  // point: an actor that exists and has never built is not a runnable actor.
  res.json({
    data: { id: "act-1", name: "website-screenshot", username: "daky_world", taggedBuilds: builtOk ? { latest: { buildId: "build-1" } } : {} },
  });
});

app.post("/v2/acts", (req, res) => {
  calls.push({ method: "POST", path: "/acts", body: req.body, query: req.query });
  actorExists = true;
  res.json({ data: { id: "act-1", name: req.body?.name, username: createdUsername } });
});

app.put("/v2/acts/:actor/versions/:version", (req, res) => {
  calls.push({ method: "PUT", path: `/acts/${req.params.actor}/versions/${req.params.version}`, body: req.body, query: req.query });
  res.json({ data: { versionNumber: req.params.version } });
});

app.post("/v2/acts/:actor/builds", (req, res) => {
  calls.push({ method: "POST", path: `/acts/${req.params.actor}/builds`, body: req.body, query: req.query });
  res.json({ data: { id: "build-1", status: "RUNNING" } });
});

app.get("/v2/actor-builds/:id", (_req, res) => {
  if (buildStatus === "SUCCEEDED") builtOk = true;
  res.json({ data: { id: "build-1", status: buildStatus, statusMessage: buildMessage } });
});

const server: Server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
PORT = (server.address() as AddressInfo).port;

process.env.APIFY_BASE_URL = `http://127.0.0.1:${PORT}/v2`;
process.env.APIFY_TOKEN = TOKEN;
process.env.SCREENSHOT_ACTOR_REPO = "https://github.com/Daky0000/dakyworld#main:apify/dakyworld-screenshot";

const settings = await import("../src/lib/settings.js");
settings.clearSettingsCache();

const { prisma } = await import("../src/lib/prisma.js");
const { clearApifyCaches } = await import("../src/lib/apify.js");
const { deployScreenshotActor, deployScreenshotActorIfMissing, sourceRepoUrl } = await import("../src/services/screenshotActorDeploy.js");
const { seedCaptureBudget, SEEDED_MONTHLY_BUDGET_USD } = await import("../src/services/captureConfig.js");
const { SETTING } = settings;

async function reset() {
  await prisma.appSetting.deleteMany({
    where: { key: { in: [SETTING.SCREENSHOT_ACTOR, SETTING.SCREENSHOT_ACTOR_BUILD, SETTING.CAPTURE_BUDGET_SEEDED, SETTING.CAPTURE_MONTHLY_BUDGET] } },
  });
  settings.clearSettingsCache();
  clearApifyCaches();
  calls = [];
  actorExists = false;
  createdUsername = "daky_world";
  buildStatus = "SUCCEEDED";
  buildMessage = null;
  builtOk = false;
}

await reset();

// --- 1. The actor is not there yet -------------------------------------------
console.log("\nDeploying an actor the account has never had");
{
  const result = await deployScreenshotActor();

  check("it reports success", result.ok, result.message);
  check("it created the actor", calls.some((c) => c.method === "POST" && c.path === "/acts"), calls.map((c) => c.path).join(", "));
  check("under the name the app calls", calls.find((c) => c.path === "/acts")?.body?.name === "website-screenshot");
  // Private, always. This actor is Dakyworld's own tooling, not something to
  // publish on the store.
  check("and private", calls.find((c) => c.path === "/acts")?.body?.isPublic === false);

  const version = calls.find((c) => c.method === "PUT");
  check("it points a version at the repository", version?.body?.sourceType === "GIT_REPO", JSON.stringify(version?.body));
  check("naming the branch and the folder", version?.body?.gitRepoUrl === sourceRepoUrl(), String(version?.body?.gitRepoUrl));
  check("tagged so runs pick it up", version?.body?.buildTag === "latest");

  const build = calls.find((c) => c.method === "POST" && c.path.endsWith("/builds"));
  check("it starts a build", Boolean(build), calls.map((c) => `${c.method} ${c.path}`).join(", "));
  check("of that version, under that tag", build?.query?.version === "1.0" && build?.query?.tag === "latest", JSON.stringify(build?.query));
  // The only question worth answering is whether screenshots work now, and a
  // build that has only *started* does not answer it.
  check("and waits for it to finish", result.status === "SUCCEEDED", String(result.status));
  check("saying so in words", result.message.includes("Screenshots will work"), result.message);
}

// --- 2. Running it again ------------------------------------------------------
console.log("\nRunning it a second time");
{
  calls = [];
  const again = await deployScreenshotActor();
  check("it does not try to create the actor twice", !calls.some((c) => c.path === "/acts"), calls.map((c) => c.path).join(", "));
  // The version is written with PUT precisely so this works: it is how a source
  // change reaches Apify, not only how the actor first arrives.
  check("it rebuilds instead", calls.some((c) => c.method === "POST" && c.path.endsWith("/builds")));
  check("and says it rebuilt rather than created", again.ok && again.message.includes("Rebuilt"), again.message);
}

// --- 3. A build that fails ----------------------------------------------------
console.log("\nA build that fails");
{
  await reset();
  buildStatus = "FAILED";
  buildMessage = "Dockerfile not found in the given directory.";
  const failed = await deployScreenshotActor();

  check("it does not throw", failed.ok === false);
  check("it says the build failed", failed.message.includes("failed"), failed.message);
  check("carrying Apify's own reason", failed.message.includes("Dockerfile not found"), failed.message);
  check("and names the build so it can be opened", Boolean(failed.buildId), String(failed.buildId));
}

// --- 4. Somebody else's account ----------------------------------------------
console.log("\nA token that belongs to another account");
{
  await reset();
  createdUsername = "someone-else";
  const wrong = await deployScreenshotActor();

  check("it stops rather than leaving an actor nothing calls", wrong.ok === false);
  check("it names the account the token is really for", wrong.message.includes("someone-else"), wrong.message);
  check("and says what to set", wrong.message.includes("Screenshot actor"), wrong.message);
  check("without building anything", !calls.some((c) => c.path.endsWith("/builds")), calls.map((c) => c.path).join(", "));
}

// --- 5. The boot pass ---------------------------------------------------------
console.log("\nThe boot pass");
{
  await reset();
  const first = await deployScreenshotActorIfMissing();
  check("it deploys when the actor is missing", first?.ok === true, first?.message ?? "nothing happened");

  calls = [];
  const second = await deployScreenshotActorIfMissing();
  check("and does nothing at all once it is there", second === null && calls.every((c) => c.method === "GET"));

  // A build that failed must be retried, but not on every deploy: a repository
  // that cannot build would otherwise cost a build every time anybody pushed.
  await reset();
  buildStatus = "FAILED";
  await deployScreenshotActorIfMissing();
  calls = [];
  const sameDay = await deployScreenshotActorIfMissing();
  check("a failed build is not retried the same day", sameDay === null, sameDay?.message ?? "");
  check("and nothing was built on that second boot", !calls.some((c) => c.path.endsWith("/builds")));

  await prisma.appSetting.deleteMany({ where: { key: SETTING.SCREENSHOT_ACTOR_BUILD } });
  settings.clearSettingsCache();
  const nextDay = await deployScreenshotActorIfMissing();
  check("but it is retried the next day", nextDay !== null, "nothing happened");
}

// --- 5b. A different actor is not "already tried today" -----------------------
//
// The first automatic deploy of this went out naming the wrong Apify account.
// A marker keyed on the date alone would have refused to try the corrected
// actor until tomorrow, turning a one-line fix into a day's wait for nothing.
console.log("\nSwitching the actor after a failed attempt");
{
  await reset();
  buildStatus = "FAILED";
  await deployScreenshotActorIfMissing();

  // Deliberately not the shipped default: the point is that switching to a
  // *different* actor is not "already tried today".
  await settings.setSetting(SETTING.SCREENSHOT_ACTOR, "daky_world/website-screenshot-staging");
  settings.clearSettingsCache();
  clearApifyCaches();
  actorExists = false;
  buildStatus = "SUCCEEDED";
  calls = [];

  const other = await deployScreenshotActorIfMissing();
  check("a different actor is tried straight away", other?.ok === true, other?.message ?? "nothing happened");
  check("and it really did build it", calls.some((c) => c.method === "POST" && c.path.endsWith("/builds")));
}

// --- 6. No token at all -------------------------------------------------------
console.log("\nWith no Apify token");
{
  await reset();
  delete process.env.APIFY_TOKEN;
  settings.clearSettingsCache();

  const noToken = await deployScreenshotActor();
  check("it refuses rather than throwing", noToken.ok === false);
  check("and says what to connect", noToken.message.includes("Apify is not connected"), noToken.message);
  check("the boot pass stays silent", (await deployScreenshotActorIfMissing()) === null);

  process.env.APIFY_TOKEN = TOKEN;
  settings.clearSettingsCache();
}

// --- 7. The monthly ceiling ---------------------------------------------------
console.log("\nThe monthly Apify ceiling");
{
  await reset();
  const seeded = await seedCaptureBudget();
  check("a fresh deployment gets one", seeded === SEEDED_MONTHLY_BUDGET_USD, String(seeded));
  check("and it is ten dollars", SEEDED_MONTHLY_BUDGET_USD === 10, String(SEEDED_MONTHLY_BUDGET_USD));
  check("written as a real value the Owner can edit", (await settings.getSetting(SETTING.CAPTURE_MONTHLY_BUDGET)) === "10");

  check("it does not write a second time", (await seedCaptureBudget()) === null);

  // The whole reason this is seeded rather than defaulted. Blank means no
  // ceiling; a default of ten would make that unsayable, because clearing the
  // box would put ten straight back.
  await settings.deleteSetting(SETTING.CAPTURE_MONTHLY_BUDGET);
  settings.clearSettingsCache();
  check("clearing it survives the next boot", (await seedCaptureBudget()) === null);
  check("and it stays cleared", (await settings.getSetting(SETTING.CAPTURE_MONTHLY_BUDGET)) === null);

  const { readCaptureConfig } = await import("../src/services/captureConfig.js");
  check("which the config reads as no ceiling", (await readCaptureConfig()).monthlyBudgetUsd === null);

  // And a ceiling somebody already chose is never overwritten by the seed.
  await reset();
  await settings.setSetting(SETTING.CAPTURE_MONTHLY_BUDGET, "42");
  settings.clearSettingsCache();
  check("a ceiling already set is left alone", (await seedCaptureBudget()) === null);
  check("at the number that was chosen", (await settings.getSetting(SETTING.CAPTURE_MONTHLY_BUDGET)) === "42");
}

await reset();
await prisma.$disconnect();
server.close();

console.log(bad === 0 ? "\nAll deploy checks passed" : `\n${bad} deploy check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
