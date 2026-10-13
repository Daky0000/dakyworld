/**
 * Does the model a call asks for reach the wire?
 *
 * There are two ways this app decides which model serves a request, they were
 * written months apart, and for most of that time neither was actually asked.
 *
 * `callClaude` took an `effort` argument, passed it to the API as the *thinking
 * budget*, and picked the model with `defaultModel()` — so `effort` never once
 * touched the model choice. `modelForEffort()` existed and was wired into the
 * agent loop alone, which made the split look finished: an agent turn reading a
 * record paid the economy rate while mail triage, which asks for `low` in so
 * many words and runs once per *arriving* message, paid the headline rate on
 * every message that arrived. And `registry.ts` carried a comment promising the
 * Owner could put triage on a cheap model from the Settings screen, while no
 * per-job model setting existed at all.
 *
 * This is the same shape of bug as the missing prompt cache, and it lasted for
 * the same reason: **nothing breaks.** No test fails, every answer is correct,
 * and the only symptom is the bill — which arrives a month later with no way to
 * say which run spent it. So it needs a check that fails the moment somebody
 * puts `defaultModel()` back, or adds a job and does not think about its tier.
 *
 * Asserted on the request body, never on the helper. A perfectly correct
 * `modelForJob()` that nothing calls is precisely the defect being fixed here.
 *
 * The negatives are the point:
 *   - **An explicit model still wins.** The model layer names a model on the
 *     way in; a tier that overruled it would silently un-choose every one.
 *   - **An unpriced model is ignored, not honoured.** An unknown model prices
 *     at the dearest rate we know of, which is the safe direction for a ceiling
 *     and a terrible place to find a typo.
 *   - **A standard-tier job is untouched.** Writing is what the good model is
 *     for, and a tier that quietly caught everything would be a quality
 *     regression dressed up as a saving.
 *
 * A database, and a fake Anthropic on localhost. No API key and no network.
 *   npx tsx checks/modelChoice.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every request body the model layer sent, in order. */
const sent: Record<string, any>[] = [];

/**
 * When set, the stub answers naming this model whatever was asked for — which
 * is what a server-side fallback looks like from the client's side.
 */
let answerAs: string | null = null;

function reply(asked: string) {
  return {
    id: "msg_check_model",
    type: "message",
    role: "assistant",
    // Echoed, because a real API echoes it. A stub that always names one model
    // makes the ledger look wrong when it is right — the first version of this
    // check failed its own last assertion for exactly that reason.
    model: answerAs ?? asked,
    content: [{ type: "text", text: JSON.stringify({ answer: "yes" }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

function fakeAnthropic(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        sent.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply(String(parsed.model ?? ""))));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

async function main() {
  const { server, url } = await fakeAnthropic();
  // Before the SDK is imported: it reads its environment at construction, and a
  // value assigned afterwards is one nothing sees.
  process.env.ANTHROPIC_BASE_URL = url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  // The four other vendors must stay unconnected, or the routing chain reaches
  // one of them and this check is asserting on the wrong wire.
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  // The environment beats the database for Claude's two model settings, so a
  // value left in the shell would decide the pin section below on its own.
  const savedPins = { ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL, ANTHROPIC_MODEL_ECONOMY: process.env.ANTHROPIC_MODEL_ECONOMY };
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL_ECONOMY;

  const { callClaude } = await import("../src/lib/claude.js");
  const { callModel } = await import("../src/lib/models/call.js");
  const { MODEL_DEFAULT, MODEL_ECONOMY } = await import("../src/lib/claudePricing.js");
  const { SETTING, setSetting, deleteSetting } = await import("../src/lib/settings.js");
  const { prisma } = await import("../src/lib/prisma.js");

  // Nothing from a previous run, and — rule 3 — nothing left after this one.
  const reset = async () => {
    await deleteSetting(SETTING.MODEL_JOB_MODELS);
    await deleteSetting(SETTING.MODEL_ROUTES);
    await deleteSetting(SETTING.ANTHROPIC_MODEL);
    await deleteSetting(SETTING.ANTHROPIC_MODEL_ECONOMY);
  };
  await reset();

  const ask = (over: Record<string, unknown>) =>
    callClaude<{ answer: string }>({
      purpose: "check.modelChoice",
      system: "You are a check.",
      prompt: () => "Say yes.",
      schema: SCHEMA,
      ...over,
    } as never);

  const askJob = (job: string, over: Record<string, unknown> = {}) =>
    callModel<{ answer: string }>({
      job,
      purpose: "check.modelChoice",
      system: "You are a check.",
      prompt: () => "Say yes.",
      schema: SCHEMA,
      ...over,
    } as never);

  const lastModel = () => sent.at(-1)?.model;

  console.log("\ncallClaude — the effort decides the model");
  await ask({ effort: "low" });
  check("low effort sends the economy model", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  await ask({ effort: "medium" });
  check("medium effort sends the economy model", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  await ask({ effort: "high" });
  check("high effort sends the headline model", lastModel() === MODEL_DEFAULT, `sent ${lastModel()}`);

  // Named the cheap way round on purpose: a level added above `high` and listed
  // nowhere must default to the better model rather than fall through to the
  // cheaper one because nobody remembered it.
  await ask({ effort: "max" });
  check("an effort above high sends the headline model", lastModel() === MODEL_DEFAULT, `sent ${lastModel()}`);

  await ask({ effort: "low", model: "claude-haiku-5-5" });
  check("an explicit model wins over the effort", lastModel() === "claude-haiku-5-5", `sent ${lastModel()}`);

  console.log("\ncallModel — the job's tier decides the model");
  await askJob("triage");
  check("an economy-tier job sends the economy model", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  await askJob("organise");
  check("organise is on the economy tier too", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  // The negative that keeps the tier honest. Writing is what the good model is
  // for; a tier that quietly caught prose would be a quality regression sold as
  // a saving. `text` routes to Gemini and falls back to Claude, which is the
  // state this check runs in.
  await askJob("text");
  check("a standard-tier job is left on the headline model", lastModel() === MODEL_DEFAULT, `sent ${lastModel()}`);

  // The effort a caller passes must not overrule the job's tier — `callModel`
  // names the model, so the tier is the answer whatever the thinking budget is.
  await askJob("text", { effort: "low" });
  check("a standard job at low effort still uses its tier's model", lastModel() === MODEL_DEFAULT, `sent ${lastModel()}`);

  console.log("\nThe Owner's per-job override");
  await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({ triage: "claude-haiku-5-5" }));
  await askJob("triage");
  check("an override reaches the wire", lastModel() === "claude-haiku-5-5", `sent ${lastModel()}`);

  await askJob("organise");
  check("overriding one job leaves the others alone", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  // An unpriced model would be billed at the dearest rate we know of, so it is
  // refused on write and ignored on read. This is the read half: a value that
  // got in some other way must not become a call nobody can price.
  await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({ triage: "claude-not-a-real-model" }));
  await askJob("triage");
  check("an unpriced override is ignored and the tier is used", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({ notajob: "claude-haiku-5-5", triage: "" }));
  await askJob("triage");
  check("a blank or unknown entry is dropped rather than sent", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  // Priced, and still not choosable. Haiku 4.5 takes no effort setting and
  // every request `callClaude` sends carries one, so honouring this would turn
  // every triage into a 400 and a quiet handover to another vendor. It was the
  // example in the setting's own comment until Oct 2026.
  await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({ triage: "claude-haiku-4-5" }));
  await askJob("triage");
  check("a priced model the wire cannot ask is ignored too", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  console.log("\nNor through Claude's own two model settings");
  // Refused for a job and for a level, Haiku 4.5 could still get in through the
  // settings a level falls back to and every unsized call reads: a deployment
  // that pinned the economy model to it while it was the shipped simple model
  // sent every standard-level turn and every economy one-shot to a 400, and on
  // to the next paid vendor. Ignored on read with one log line, refused on
  // write — and a pin that can take an effort is still honoured.
  {
    const { clearSettingsCache } = await import("../src/lib/settings.js");
    const { defaultModel, modelForEffort } = await import("../src/lib/claudePricing.js");
    const { tierSlot } = await import("../src/lib/models/registry.js");
    await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({}));

    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
      originalWarn(...args);
    };
    try {
      await setSetting(SETTING.ANTHROPIC_MODEL_ECONOMY, "claude-haiku-4-5");
      await setSetting(SETTING.ANTHROPIC_MODEL, "claude-haiku-4-5");
      const standard = await tierSlot("anthropic", "standard");
      check("a standard-level agent turn does not take an economy pin to Haiku 4.5", standard.model === MODEL_ECONOMY && standard.source === "shipped", `${standard.model}/${standard.source}`);
      const complex = await tierSlot("anthropic", "complex");
      check("nor a complex one a headline pin", complex.model === MODEL_DEFAULT && complex.source === "shipped", `${complex.model}/${complex.source}`);
      check("an unsized medium-effort turn falls back to the shipped economy model", (await modelForEffort("medium")) === MODEL_ECONOMY, await modelForEffort("medium"));
      check("and defaultModel to the shipped headline model", (await defaultModel()) === MODEL_DEFAULT, await defaultModel());
      await ask({ effort: "low" });
      check("on the wire too", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);
      await modelForEffort("low");
      const said = warned.filter((line) => line.includes("anthropic.model.economy") && line.includes("claude-haiku-4-5"));
      check("said once in the log, not on every read", said.length === 1, `${said.length} lines`);

      await deleteSetting(SETTING.ANTHROPIC_MODEL_ECONOMY);
      await deleteSetting(SETTING.ANTHROPIC_MODEL);
      process.env.ANTHROPIC_MODEL_ECONOMY = "claude-haiku-4-5";
      clearSettingsCache();
      check("the same pin in ANTHROPIC_MODEL_ECONOMY is ignored", (await modelForEffort("medium")) === MODEL_ECONOMY && (await tierSlot("anthropic", "standard")).model === MODEL_ECONOMY);
      delete process.env.ANTHROPIC_MODEL_ECONOMY;
      clearSettingsCache();

      // The negative: a pin that can take an effort is the Owner's, as before.
      await setSetting(SETTING.ANTHROPIC_MODEL_ECONOMY, "claude-sonnet-5");
      await setSetting(SETTING.ANTHROPIC_MODEL, "claude-opus-5");
      check("a pin that takes an effort is still honoured for the standard level", (await tierSlot("anthropic", "standard")).model === "claude-sonnet-5");
      check("and for unsized turns", (await modelForEffort("medium")) === "claude-sonnet-5" && (await defaultModel()) === "claude-opus-5");
    } finally {
      console.warn = originalWarn;
      await deleteSetting(SETTING.ANTHROPIC_MODEL_ECONOMY);
      await deleteSetting(SETTING.ANTHROPIC_MODEL);
    }

    // The write half, through the route the Settings screen uses.
    const express = (await import("express")).default;
    const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
    const { settingsRouter } = await import("../src/routes/settings.js");
    const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
    const { getSetting } = await import("../src/lib/settings.js");
    // The dev user is an Owner only once the Owner role exists.
    await ensureSystemRoles();
    const app = express();
    app.use(express.json());
    app.use(attachUser);
    app.use("/api", requireAuth);
    app.use("/api/settings", settingsRouter);
    const api = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => api.once("listening", resolve));
    const put = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${(api.address() as AddressInfo).port}/api/settings/models/anthropic`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    try {
      const refused = await put({ model: "claude-haiku-4-5" });
      check("PUT /settings/models/anthropic refuses Haiku 4.5", refused.status === 400 && String(refused.body?.error ?? "").includes("effort"), `${refused.status} ${JSON.stringify(refused.body).slice(0, 160)}`);
      check("and stores nothing", (await getSetting(SETTING.ANTHROPIC_MODEL)) == null);
      const taken = await put({ model: "claude-sonnet-5-5" });
      check("a model that takes an effort is stored as before", taken.status === 200 && (await getSetting(SETTING.ANTHROPIC_MODEL)) === "claude-sonnet-5-5", `${taken.status}`);
      const cleared = await put({ model: "" });
      check("and blank still restores the shipped default", cleared.status === 200 && (await getSetting(SETTING.ANTHROPIC_MODEL)) == null, `${cleared.status}`);

      // A key and a refused model in one request: refused whole, before the key
      // is written. It used to verify and save the key, then 400 on the model.
      // The key is the database's only while no environment variable holds it,
      // so the check's own one steps aside for this and comes straight back.
      const keyRowBefore = await prisma.appSetting.findUnique({ where: { key: SETTING.ANTHROPIC_KEY } });
      const envKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const both = await put({ key: "sk-ant-check-a-second-key-not-real", model: "claude-haiku-4-5" });
        const keyRowAfter = await prisma.appSetting.findUnique({ where: { key: SETTING.ANTHROPIC_KEY } });
        check("a key sent with a refused model is refused with it", both.status === 400 && String(both.body?.error ?? "").includes("effort"), `${both.status}`);
        check("and the key is not saved", keyRowAfter?.value === keyRowBefore?.value && Boolean(keyRowAfter) === Boolean(keyRowBefore), keyRowAfter ? "a key row was written" : "");
      } finally {
        process.env.ANTHROPIC_API_KEY = envKey;
        await prisma.appSetting.deleteMany({ where: { key: SETTING.ANTHROPIC_KEY } });
        if (keyRowBefore) await prisma.appSetting.create({ data: { key: keyRowBefore.key, value: keyRowBefore.value, secret: keyRowBefore.secret } });
        clearSettingsCache();
      }
    } finally {
      api.close();
      await deleteSetting(SETTING.ANTHROPIC_MODEL);
    }
  }

  console.log("\nThe ledger records what actually served it");
  const rows = await prisma.llmCall.findMany({ where: { purpose: "check.modelChoice" }, select: { model: true } });
  check("every call left a priced ledger row", rows.length === sent.length, `${rows.length} rows for ${sent.length} calls`);
  check("the ledger names the economy model at least once", rows.some((row) => row.model === MODEL_ECONOMY));
  check("the ledger names the headline model at least once", rows.some((row) => row.model === MODEL_DEFAULT));

  // The contract the ledger actually makes, and the reason it is worth a
  // separate assertion: it records **who answered**, not who was asked. A
  // server-side fallback re-serves a declined request on another model, and a
  // ledger recording the request would attribute that spend to a model that
  // never ran and price it at the wrong rate.
  // Opus 5 is where a declined Opus 5.5 request is re-served, so it is the
  // realistic answer here.
  answerAs = "claude-opus-5";
  await ask({ effort: "high", purpose: "check.modelChoice.fallback" });
  answerAs = null;
  const served = await prisma.llmCall.findFirst({ where: { purpose: "check.modelChoice.fallback" }, select: { model: true } });
  check("the ledger records who answered, not who was asked", served?.model === "claude-opus-5", `recorded ${served?.model}`);
  check("...and the request really did ask for the other one", sent.at(-1)?.model === MODEL_DEFAULT, `sent ${sent.at(-1)?.model}`);

  console.log("\nThe sheet analyst's own model");
  const { analyzeGrids } = await import("../src/lib/anthropic.js");
  const { PROVIDERS, routeFor } = await import("../src/lib/models/registry.js");

  // OpenRouter is the shipped answer for reading sheets, same as for writing
  // them. This environment holds no OpenRouter key, so what actually serves
  // right now is the stand-in — exactly the state a deployment with only a
  // Claude key is in.
  const route = await routeFor("spreadsheet");
  check("reading sheets ships routed to OpenRouter", route.chosen === "nvidia");
  // A stand-in is not "ready": ready means the chosen vendor is the one
  // serving, and the note is what says who is covering instead.
  check("with only a Claude key the stand-in serves it", route.serving === "anthropic" && !route.ready);

  // With nobody else connected the stand-in follows Claude's own model rather
  // than a frozen copy of the shipped default.
  await setSetting(SETTING.ANTHROPIC_MODEL, "claude-sonnet-5-5");
  check("the stand-in follows Claude's own model", (await routeFor("spreadsheet")).model === "claude-sonnet-5-5");

  // And the Owner can still pick the model for this one job from the Settings
  // screen, the same way as every other job.
  await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({ spreadsheet: "claude-haiku-5-5" }));
  check("the Owner's per-job override wins", (await routeFor("spreadsheet")).model === "claude-haiku-5-5");

  // It reaches the wire — asserted on the request body, never on the helper.
  // A perfectly correct resolution that analyzeGrids ignores is precisely the
  // defect class this file exists for.
  //
  // The ledger rows this call writes are cleaned up by id below: purpose
  // "sheet.analyse" is a real production purpose, so deleting every row with
  // it would erase genuine history from a database that has any.
  const knownSheetRows = new Set(
    (await prisma.llmCall.findMany({ where: { purpose: "sheet.analyse" }, select: { id: true } })).map((row) => row.id),
  );
  const analysis = await analyzeGrids([{ name: "Leads", rows: [["Name"], ["Kofi"]], totalRows: 2, truncated: false }], []);
  check("analyzeGrids sends the override to the wire", lastModel() === "claude-haiku-5-5");
  check("a call served by the fallback says so", analysis.note !== null && analysis.note.includes(PROVIDERS.nvidia.name));

  await prisma.llmCall.deleteMany({
    where: { purpose: "sheet.analyse", id: { notIn: [...knownSheetRows] } },
  });

  // Rule 3: everything this check created, gone — including the settings it
  // expected to be ignored. The delete is the last thing that happens.
  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: "check.modelChoice" } } });
  await reset();
  for (const [name, value] of Object.entries(savedPins)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await prisma.$disconnect();
  server.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
