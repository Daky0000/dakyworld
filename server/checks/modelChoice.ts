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
  // The three other vendors must stay unconnected, or the routing chain reaches
  // one of them and this check is asserting on the wrong wire.
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;

  const { callClaude } = await import("../src/lib/claude.js");
  const { callModel } = await import("../src/lib/models/call.js");
  const { MODEL_DEFAULT, MODEL_ECONOMY } = await import("../src/lib/claudePricing.js");
  const { SETTING, setSetting, deleteSetting } = await import("../src/lib/settings.js");
  const { prisma } = await import("../src/lib/prisma.js");

  // Nothing from a previous run, and — rule 3 — nothing left after this one.
  const reset = async () => {
    await deleteSetting(SETTING.MODEL_JOB_MODELS);
    await deleteSetting(SETTING.MODEL_ROUTES);
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

  await ask({ effort: "low", model: "claude-haiku-4-5" });
  check("an explicit model wins over the effort", lastModel() === "claude-haiku-4-5", `sent ${lastModel()}`);

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
  await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({ triage: "claude-haiku-4-5" }));
  await askJob("triage");
  check("an override reaches the wire", lastModel() === "claude-haiku-4-5", `sent ${lastModel()}`);

  await askJob("organise");
  check("overriding one job leaves the others alone", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  // An unpriced model would be billed at the dearest rate we know of, so it is
  // refused on write and ignored on read. This is the read half: a value that
  // got in some other way must not become a call nobody can price.
  await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({ triage: "claude-not-a-real-model" }));
  await askJob("triage");
  check("an unpriced override is ignored and the tier is used", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

  await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify({ notajob: "claude-haiku-4-5", triage: "" }));
  await askJob("triage");
  check("a blank or unknown entry is dropped rather than sent", lastModel() === MODEL_ECONOMY, `sent ${lastModel()}`);

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
  answerAs = "claude-haiku-4-5";
  await ask({ effort: "high", purpose: "check.modelChoice.fallback" });
  answerAs = null;
  const served = await prisma.llmCall.findFirst({ where: { purpose: "check.modelChoice.fallback" }, select: { model: true } });
  check("the ledger records who answered, not who was asked", served?.model === "claude-haiku-4-5", `recorded ${served?.model}`);
  check("...and the request really did ask for the other one", sent.at(-1)?.model === MODEL_DEFAULT, `sent ${sent.at(-1)?.model}`);

  // Rule 3: everything this check created, gone — including the settings it
  // expected to be ignored. The delete is the last thing that happens.
  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: "check.modelChoice" } } });
  await reset();
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
