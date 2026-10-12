/**
 * A model is admitted by its rate, and the Owner can now declare one.
 *
 * The spending guard on the Settings screen refused any model it could not
 * price — rightly, because an unpriced model is billed at the dearest rate we
 * know of — and told the Owner to "add one under models.pricing first". Nothing
 * could: no route wrote that setting, and the guard read only the two price
 * tables in the code. So no model released after those tables were written
 * could be chosen for a job or a task level without a deploy, which is the one
 * thing a rate override exists to avoid.
 *
 * Driven over **real HTTP through the real settings router**, with the real
 * permission gate in front of it, because the refusal and the write both live
 * inside the handlers. The negatives carry as much weight as the positives:
 *
 *   - Without a declared rate the same request is still a 400, word for word.
 *   - A declared rate that is negative, not finite or not a number admits
 *     nothing.
 *   - The declaring route refuses a typo-sized rate rather than storing it.
 *   - Taking a rate back puts the choice that leaned on it back on what ships.
 *   - An id with no rate anywhere is still billed at the dearest rate.
 *   - A deployment that pinned its Claude model keeps the pin.
 *
 * A database and nothing else. `checks/run.ts` sets `DEV_NO_AUTH=true`, so the
 * gate resolves the real Owner row.
 *   npx tsx checks/declaredRates.ts
 */
import express from "express";
import type { AddressInfo } from "node:net";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Env wins over the database for both of these, and a value left in the
// shell would make every assertion about the database row meaningless.
const ENV = ["ANTHROPIC_MODEL", "ANTHROPIC_MODEL_ECONOMY"];
const savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
for (const name of ENV) delete process.env[name];

const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { prisma } = await import("../src/lib/prisma.js");
const { SETTING, clearSettingsCache, getSetting, setSetting } = await import("../src/lib/settings.js");
const { MODEL_PRICING, rateFor } = await import("../src/lib/claudePricing.js");
const { PROVIDER_PRICING, TIER_MODELS, isPricedModelAsync, isShippedPricedModel, modelForJob, tierSlot } = await import("../src/lib/models/registry.js");
const { rateForModel } = await import("../src/lib/models/call.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");

// The dev user is an Owner only once the Owner role exists. A fresh database has
// none until the server boots, and every PUT below then answers 403.
await ensureSystemRoles();

const SETTINGS = [
  SETTING.MODEL_PRICING,
  SETTING.ANTHROPIC_PRICING,
  SETTING.MODEL_JOB_MODELS,
  SETTING.MODEL_TIER_MODELS,
  SETTING.ANTHROPIC_MODEL,
  SETTING.ANTHROPIC_MODEL_ECONOMY,
];
const savedRows = await prisma.appSetting.findMany({ where: { key: { in: SETTINGS } } });

/** Nothing of ours in any of the six rows. Called first, and — rule 3 — the restore is last. */
async function clear() {
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
  clearSettingsCache();
}

async function restore() {
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
  for (const row of savedRows) await prisma.appSetting.create({ data: { key: row.key, value: row.value, secret: row.secret } });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearSettingsCache();
}

const app = express();
app.use(express.json());
app.use(attachUser);
app.use("/api", requireAuth);
app.use("/api/settings", settingsRouter);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;

async function call(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** An id no table in the code has ever heard of — a model released next month. */
const UNRELEASED = "claude-check-unreleased-9";
const SECOND = "claude-check-unreleased-10";
const UNPRICED_SENTENCE = (model: string) =>
  `There is no published rate here for ${model}, so what it costs could not be recorded. Add one under models.pricing first, or choose a listed model.`;

const chooseLevel = (model: string | null) => call("PUT", "/models/levels/anthropic/complex", { model });
const chooseJob = (model: string | null) => call("PUT", "/models/jobs/triage", { model });

try {
  await clear();

  console.log("\nWithout a rate, the guard refuses — in the same words as before");
  {
    check("the id really is unknown to the code", !isShippedPricedModel(UNRELEASED) && !(await isPricedModelAsync(UNRELEASED)));
    const level = await chooseLevel(UNRELEASED);
    check("a level is refused", level.status === 400, `${level.status} ${JSON.stringify(level.body)}`);
    check("with the sentence the screen has always shown", level.body?.error === UNPRICED_SENTENCE(UNRELEASED), level.body?.error);
    const job = await chooseJob(UNRELEASED);
    check("a job is refused", job.status === 400 && job.body?.error === UNPRICED_SENTENCE(UNRELEASED), `${job.status} ${job.body?.error}`);
    // The prototype keys of a plain object answer `in` — "constructor" is in
    // every object literal — so a guard written with `in` would wave it through.
    const proto = await chooseJob("constructor");
    check("an id that is only a property of every object is not a priced one", proto.status === 400, `${proto.status}`);
    const slot = await tierSlot("anthropic", "complex");
    check("and nothing was stored", slot.source === "shipped" && slot.model === TIER_MODELS.anthropic.complex, `${slot.model}/${slot.source}`);
  }

  console.log("\nA declared rate that is not a rate admits nothing");
  {
    // Written straight to the row, the way a hand edit or an old deploy would
    // leave it: the reader is the last line, so it has to hold on its own.
    // `1e400` is valid JSON and parses to Infinity.
    await setSetting(
      SETTING.MODEL_PRICING,
      `{"${UNRELEASED}":{"inputPerMTok":-1,"outputPerMTok":5},"${SECOND}":{"inputPerMTok":1e400,"outputPerMTok":5},"claude-check-words":{"inputPerMTok":"two","outputPerMTok":5}}`,
    );
    clearSettingsCache();
    for (const model of [UNRELEASED, SECOND, "claude-check-words"]) {
      check(`${model} is not admitted`, !(await isPricedModelAsync(model)));
    }
    const level = await chooseLevel(UNRELEASED);
    check("a negative rate still leaves the level refused", level.status === 400 && level.body?.error === UNPRICED_SENTENCE(UNRELEASED), `${level.status}`);
    const job = await chooseJob(SECOND);
    check("an infinite one still leaves the job refused", job.status === 400 && job.body?.error === UNPRICED_SENTENCE(SECOND), `${job.status}`);
    const words = await chooseJob("claude-check-words");
    check("and so does one written in words", words.status === 400, `${words.status}`);
    await clear();
  }

  console.log("\nA declared rate admits the model, and the bill uses it");
  {
    await setSetting(SETTING.MODEL_PRICING, JSON.stringify({ [UNRELEASED]: { inputPerMTok: 3, outputPerMTok: 12 } }));
    clearSettingsCache();
    check("the guard admits it", await isPricedModelAsync(UNRELEASED));
    const level = await chooseLevel(UNRELEASED);
    check("a level can be set to it", level.status === 200, `${level.status} ${JSON.stringify(level.body?.error ?? "")}`);
    const slot = await tierSlot("anthropic", "complex");
    check("and the slot is the Owner's", slot.model === UNRELEASED && slot.source === "owner", `${slot.model}/${slot.source}`);
    const job = await chooseJob(UNRELEASED);
    check("a job can be set to it", job.status === 200, `${job.status}`);
    check("and the job resolves to it", (await modelForJob("triage", "anthropic")) === UNRELEASED);
    const rate = await rateForModel(UNRELEASED);
    check("the bill is the declared rate", rate.inputPerMTok === 3 && rate.outputPerMTok === 12, JSON.stringify(rate));
    // One parser: the Claude half and the every-vendor half read one setting
    // the same way, so they cannot disagree about what a call cost.
    const claudeHalf = await rateFor(UNRELEASED);
    check("and both halves of the model layer read it the same", JSON.stringify(claudeHalf) === JSON.stringify(rate), `${JSON.stringify(claudeHalf)} vs ${JSON.stringify(rate)}`);
  }

  console.log("\nThe older anthropic.pricing is honoured by the same helper");
  {
    await setSetting(SETTING.ANTHROPIC_PRICING, JSON.stringify({ [SECOND]: { inputPerMTok: 1.5, outputPerMTok: 6 } }));
    clearSettingsCache();
    check("an id declared there is admitted", await isPricedModelAsync(SECOND));
    const job = await chooseJob(SECOND);
    check("and can be chosen", job.status === 200, `${job.status}`);
    const every = await rateForModel(SECOND);
    const claude = await rateFor(SECOND);
    check("both halves bill it at the declared rate", every.inputPerMTok === 1.5 && claude.inputPerMTok === 1.5, `${JSON.stringify(every)} / ${JSON.stringify(claude)}`);
    // The every-vendor half used to read `models.pricing` alone and reach the
    // old row only through the Claude table, after its own — so a correction
    // there to any id that table already held was ignored.
    await setSetting(SETTING.ANTHROPIC_PRICING, JSON.stringify({ [SECOND]: { inputPerMTok: 1.5, outputPerMTok: 6 }, "gpt-5.4": { inputPerMTok: 2.25, outputPerMTok: 14 } }));
    clearSettingsCache();
    check("a correction there reaches every vendor's rate", (await rateForModel("gpt-5.4")).inputPerMTok === 2.25, JSON.stringify(await rateForModel("gpt-5.4")));
    // Where both rows name one id, the Settings screen's row is the newer decision.
    await setSetting(SETTING.MODEL_PRICING, JSON.stringify({ [UNRELEASED]: { inputPerMTok: 3, outputPerMTok: 12 }, "claude-opus-5": { inputPerMTok: 4.8, outputPerMTok: 24 } }));
    clearSettingsCache();
    check("and models.pricing wins where both name it", (await rateFor("claude-opus-5")).inputPerMTok === 4.8 && (await rateForModel("claude-opus-5")).inputPerMTok === 4.8);
    await clear();
  }

  console.log("\nDeclaring a rate from the Settings screen");
  {
    const bad = [
      { label: "a negative rate", body: { inputPerMTok: -1, outputPerMTok: 5 } },
      { label: "a rate written in words", body: { inputPerMTok: "two", outputPerMTok: 5 } },
      { label: "an infinite rate", body: `{"inputPerMTok":1e400,"outputPerMTok":5}` },
      { label: "a decimal point in the wrong place", body: { inputPerMTok: 3, outputPerMTok: 15_000 } },
      { label: "a missing half", body: { inputPerMTok: 3 } },
    ];
    for (const { label, body } of bad) {
      const res = await call("PUT", `/models/pricing/${UNRELEASED}`, body);
      check(`${label} is refused`, res.status === 400 && typeof res.body?.error === "string", `${res.status} ${JSON.stringify(res.body)}`);
    }
    check("and none of them was stored", (await getSetting(SETTING.MODEL_PRICING)) === null, String(await getSetting(SETTING.MODEL_PRICING)));
    const badId = await call("PUT", `/models/pricing/${encodeURIComponent("not a model")}`, { inputPerMTok: 1, outputPerMTok: 1 });
    check("an id with a space in it is refused", badId.status === 400, `${badId.status}`);

    const ok = await call("PUT", `/models/pricing/${UNRELEASED}`, { inputPerMTok: 3, outputPerMTok: 12 });
    check("a real rate is stored", ok.status === 200, `${ok.status} ${JSON.stringify(ok.body?.error ?? "")}`);
    const row = JSON.parse((await getSetting(SETTING.MODEL_PRICING)) ?? "{}");
    check("in models.pricing, as declared", row[UNRELEASED]?.inputPerMTok === 3 && row[UNRELEASED]?.outputPerMTok === 12, JSON.stringify(row));
    const shown = (ok.body?.models?.declaredRates ?? []) as Array<{ model: string; inputPerMTok: number; shipped: boolean }>;
    check("the screen is told about it", shown.some((entry) => entry.model === UNRELEASED && entry.inputPerMTok === 3 && entry.shipped === false), JSON.stringify(shown));
    const level = await chooseLevel(UNRELEASED);
    check("and the level that was refused is now accepted", level.status === 200, `${level.status}`);

    // An id with a slash in it — every NVIDIA model is one — arrives encoded.
    const slashed = await call("PUT", `/models/pricing/${encodeURIComponent("vendor/check-model")}`, { inputPerMTok: 0, outputPerMTok: 0 });
    check("an id with a slash in it can be declared", slashed.status === 200, `${slashed.status}`);
    check("under its own name", Boolean(JSON.parse((await getSetting(SETTING.MODEL_PRICING)) ?? "{}")["vendor/check-model"]));
  }

  console.log("\nTaking a rate back");
  {
    const gone = await call("DELETE", `/models/pricing/${UNRELEASED}`);
    check("removes it", gone.status === 200, `${gone.status}`);
    check("from the row", !Object.hasOwn(JSON.parse((await getSetting(SETTING.MODEL_PRICING)) ?? "{}"), UNRELEASED));
    check("so the model is unpriced again", !(await isPricedModelAsync(UNRELEASED)));
    const slot = await tierSlot("anthropic", "complex");
    check("and the level that leaned on it is back on what ships", slot.source === "shipped" && slot.model === TIER_MODELS.anthropic.complex, `${slot.model}/${slot.source}`);
    check("as is the job", (await modelForJob("triage", "anthropic")) !== UNRELEASED);
    const again = await call("DELETE", `/models/pricing/${UNRELEASED}`);
    check("taking it back twice says there is nothing to take", again.status === 404, `${again.status}`);

    await setSetting(SETTING.ANTHROPIC_PRICING, JSON.stringify({ [SECOND]: { inputPerMTok: 1.5, outputPerMTok: 6 } }));
    clearSettingsCache();
    const old = await call("DELETE", `/models/pricing/${SECOND}`);
    check("a rate in the older row can be taken back too", old.status === 200 && (await getSetting(SETTING.ANTHROPIC_PRICING)) === null, `${old.status}`);
    await clear();
  }

  console.log("\nAn id with no rate anywhere is billed at the dearest one");
  {
    const rate = await rateForModel(UNRELEASED);
    const dearest = Math.max(...[...Object.values(MODEL_PRICING), ...Object.values(PROVIDER_PRICING)].map((entry) => entry.outputPerMTok));
    check("not at zero", rate.inputPerMTok > 0 && rate.outputPerMTok > 0, JSON.stringify(rate));
    check("at no less than the dearest rate in either table", rate.outputPerMTok >= dearest, `${rate.outputPerMTok} vs ${dearest}`);
    check("the same through the Claude half", JSON.stringify(await rateFor(UNRELEASED)) === JSON.stringify(rate));
    const proto = await rateForModel("constructor");
    check("and a prototype key is billed as unknown, not as a function", proto.outputPerMTok === rate.outputPerMTok, JSON.stringify(proto));
  }

  console.log("\nA Claude model the wire cannot ask is refused however it is priced");
  {
    check("Haiku 4.5 is still priced, for the calls it served", isShippedPricedModel("claude-haiku-4-5"));
    const level = await call("PUT", "/models/levels/anthropic/simple", { model: "claude-haiku-4-5" });
    check("but cannot be chosen for a level", level.status === 400 && /effort/.test(level.body?.error ?? ""), `${level.status} ${level.body?.error}`);
    check("and says what to choose instead", (level.body?.error ?? "").includes(TIER_MODELS.anthropic.simple), level.body?.error);
    const job = await call("PUT", "/models/jobs/triage", { model: "claude-haiku-4-5" });
    check("nor for a job", job.status === 400, `${job.status}`);
    // The read half: a value that got in before the refusal existed.
    await setSetting(SETTING.MODEL_TIER_MODELS, JSON.stringify({ anthropic: { simple: "claude-haiku-4-5" } }));
    clearSettingsCache();
    const slot = await tierSlot("anthropic", "simple");
    check("one already stored is ignored for what ships", slot.model === TIER_MODELS.anthropic.simple && slot.source === "shipped", `${slot.model}/${slot.source}`);
    await clear();
  }

  console.log("\nA pinned Claude model stays pinned");
  {
    await setSetting(SETTING.ANTHROPIC_MODEL, "claude-opus-5");
    await setSetting(SETTING.ANTHROPIC_MODEL_ECONOMY, "claude-sonnet-5");
    clearSettingsCache();
    const complex = await tierSlot("anthropic", "complex");
    const standard = await tierSlot("anthropic", "standard");
    check("the complex level keeps anthropic.model", complex.model === "claude-opus-5" && complex.source === "vendor-setting", `${complex.model}/${complex.source}`);
    check("the standard level keeps anthropic.model.economy", standard.model === "claude-sonnet-5" && standard.source === "vendor-setting", `${standard.model}/${standard.source}`);
    check("while the screen still says what ships now", complex.shipped === "claude-opus-5-5" && standard.shipped === "claude-sonnet-5-5", `${complex.shipped}/${standard.shipped}`);
    await clear();
  }
} catch (err) {
  failures.push(`the run stopped: ${(err as Error).message}`);
  console.log(`\n  THREW  ${(err as Error).stack ?? (err as Error).message}`);
} finally {
  server.close();
  await restore().catch(() => undefined);
  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
}
