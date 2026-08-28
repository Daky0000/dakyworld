/**
 * The free ladder: three free models tried in order, then the paid floor.
 *
 * OpenRouter publishes models that cost nothing per token. They are real models
 * and they are also the least reliable thing in this system — a free endpoint is
 * shared, so it queues, rate-limits, and some of the time simply does not
 * answer. One of them as *the* model is a system that stops working at busy
 * times. Three of them in a row with Claude behind them is a system that costs
 * nothing most days and never stops.
 *
 * Six claims, and the negatives are the half that matter:
 *
 *  1. Every rung is tried, in the order it was set, and the work still gets
 *     done by the last one that answers.
 *  2. When the whole ladder is silent, Claude finishes — and is asked for a
 *     *Claude* model, not the OpenRouter slug the run started on.
 *  3. A rate limit climbs the ladder. Without a ladder it must still requeue
 *     the task, which is a deliberately different answer for the same status
 *     and the one thing most likely to be "simplified" into agreement.
 *  4. A key-level refusal — wrong key, no credits, banned account — does **not**
 *     climb. It is true of every model on the account, so three calls into the
 *     same wall is three wasted calls and a slower failure.
 *  5. A rung is priced at zero in the ledger. An unpriced model falls through
 *     to the floor rate, which is deliberately the dearest we know of, so a
 *     free day would otherwise read as the most expensive one this company has
 *     ever had and trip every budget ceiling on money nobody spent.
 *  6. With no ladder set, nothing about the model layer changes.
 *
 * Both halves of the model layer are driven, because they are two separate
 * implementations of the same wire: `callModel` for one-shot work and
 * `runAgentLoop` for an agent turn. A ladder wired into one and not the other
 * is a feature that works for writing an email and does nothing for the
 * workforce.
 *
 * No API key and no network — the fakes serve everything locally.
 *   npx tsx checks/freeModels.ts
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

const RUNGS = ["free/one:free", "free/two:free", "free/three:free"];

interface Hit {
  path: string;
  model?: string;
}

/**
 * A fake OpenRouter that answers the catalogue and lets each test decide what
 * a completion does.
 *
 * The catalogue matters: the adapter asks whether a model compiles schemas
 * before it sends one, so a fake without `/models` makes every scenario here
 * fail on a lookup rather than on the thing being tested.
 */
function openRouterStub(
  hits: Hit[],
  reply: (model: string, hit: number) => { status: number; payload: unknown },
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        if (req.method === "GET" && path.includes("/models")) {
          hits.push({ path });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              data: [
                ...RUNGS.map((id) => ({
                  id,
                  name: id,
                  context_length: 32_000,
                  pricing: { prompt: "0", completion: "0" },
                  supported_parameters: ["tools", "response_format"],
                })),
                {
                  id: "paid/model",
                  name: "Paid model",
                  context_length: 200_000,
                  pricing: { prompt: "0.000003", completion: "0.000015" },
                  supported_parameters: ["tools", "structured_outputs", "response_format"],
                },
              ],
            }),
          );
          return;
        }

        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          body = {};
        }
        const model = String(body.model ?? "");
        const completions = hits.filter((hit) => !hit.path.includes("/models")).length;
        hits.push({ path, model });
        const answer = reply(model, completions);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(typeof answer.payload === "string" ? answer.payload : JSON.stringify(answer.payload));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

function anthropicStub(bodies: Record<string, unknown>[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          body = {};
        }
        bodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `msg_${bodies.length}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: '{"answer":"from claude"}' }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/** One completion a free model might actually return. */
function completion(model: string) {
  return {
    id: "chatcmpl_free",
    object: "chat.completion",
    model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"answer":"from a free model"}' } }],
    usage: { prompt_tokens: 200, completion_tokens: 40 },
  };
}

const lookUpTool = {
  name: "look_up",
  description: "Looks something up.",
  inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
  run: async () => ({ content: "It is a Tuesday." }),
};

async function main() {
  const { prisma } = await import("../src/lib/prisma.js");
  const { clearSettingsCache, SETTING, setSetting } = await import("../src/lib/settings.js");
  const { callModel } = await import("../src/lib/models/call.js");
  const { freeLadder, FREE_LADDER_MAX } = await import("../src/lib/models/registry.js");
  const { runAgentLoop, clearOpenRouterCooldown } = await import("../src/lib/claudeAgent.js");

  // Rule one of this directory: a database and nothing else, and certainly no
  // real vendor on the other end. A dev database holds whatever keys were
  // pasted while testing, and `getSetting` falls back to those rows — so a
  // scenario that wants a vendor unconnected has to remove the row as well as
  // the variable. Snapshotted and put back at the end.
  const VENDOR_SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.ANTHROPIC_MODEL,
    SETTING.ANTHROPIC_MODEL_ECONOMY,
    SETTING.OPENROUTER_KEY,
    SETTING.OPENROUTER_MODEL,
    SETTING.OPENROUTER_FREE_MODELS,
    SETTING.MODEL_ROUTES,
    SETTING.MODEL_JOB_MODELS,
  ];
  const saved = await prisma.appSetting.findMany({ where: { key: { in: VENDOR_SETTINGS } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: VENDOR_SETTINGS } } });
  clearSettingsCache();

  const restore = async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: VENDOR_SETTINGS } } });
    for (const row of saved) await prisma.appSetting.create({ data: { key: row.key, value: row.value, secret: row.secret } });
    clearSettingsCache();
  };

  // The schema as `callModel` takes it: JSON Schema, closed and fully required.
  const answer = {
    type: "object",
    additionalProperties: false,
    properties: { answer: { type: "string" } },
    required: ["answer"],
  } as Record<string, unknown>;
  const ask = (purpose: string) =>
    callModel<{ answer: string }>({
      purpose,
      job: "text",
      system: "You are a check.",
      prompt: () => "Say something.",
      schema: answer,
      effort: "low",
    });

  // --- The ladder itself -----------------------------------------------------

  await setSetting(SETTING.OPENROUTER_FREE_MODELS, JSON.stringify([...RUNGS, "free/four:free"]));
  clearSettingsCache();
  const ladder = await freeLadder();
  check(`the ladder is capped at ${FREE_LADDER_MAX}`, ladder.length === FREE_LADDER_MAX, String(ladder.length));
  check("and keeps the order it was set in", ladder.join(",") === RUNGS.join(","), ladder.join(","));

  await setSetting(SETTING.OPENROUTER_FREE_MODELS, JSON.stringify(["free/one:free", "free/one:free", "free/two:free"]));
  clearSettingsCache();
  // A repeated rung is a rung that proves nothing — the same endpoint that just
  // failed is asked again and the ladder is shorter than it looks.
  check("a duplicate rung is dropped", (await freeLadder()).join(",") === "free/one:free,free/two:free");

  await setSetting(SETTING.OPENROUTER_FREE_MODELS, "not json at all");
  clearSettingsCache();
  check("a corrupt setting means no ladder rather than a broken model layer", (await freeLadder()).length === 0);

  await setSetting(SETTING.OPENROUTER_FREE_MODELS, JSON.stringify(RUNGS));
  clearSettingsCache();

  // --- Scenario A: the second rung answers -----------------------------------

  const hitsA: Hit[] = [];
  const orA = await openRouterStub(hitsA, (model) =>
    model === RUNGS[0] ? { status: 429, payload: "Rate limit exceeded" } : { status: 200, payload: completion(model) },
  );
  const anthA: Record<string, unknown>[] = [];
  const claudeA = await anthropicStub(anthA);

  process.env.OPENROUTER_API_KEY = "sk-or-check-not-a-real-key";
  process.env.OPENROUTER_BASE_URL = orA.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  process.env.ANTHROPIC_BASE_URL = claudeA.url;
  clearSettingsCache();

  const first = await ask("check.free.secondRung");
  const calledA = hitsA.filter((hit) => !hit.path.includes("/models")).map((hit) => hit.model);
  check("a rate-limited rung is not waited for", calledA.length === 2, calledA.join(", "));
  check("the next rung is asked, in order", calledA[0] === RUNGS[0] && calledA[1] === RUNGS[1], calledA.join(" then "));
  check("and its answer is the answer", first.data.answer === "from a free model", first.data.answer);
  check("Claude was never troubled", anthA.length === 0, `${anthA.length} call(s)`);
  check("the reply says which model actually served it", first.model === RUNGS[1], first.model);

  // 5. Priced at nothing. The ledger is where a budget ceiling reads from, so
  // this is the assertion that stops a free day tripping one.
  check("a free rung costs nothing", first.costUsd === 0, String(first.costUsd));
  const ledger = await prisma.llmCall.findMany({ where: { purpose: "check.free.secondRung" }, orderBy: { createdAt: "asc" } });
  check("and the ledger agrees", ledger.every((row) => Number(row.costUsd) === 0), ledger.map((row) => `${row.model}=${row.costUsd}`).join(", "));
  check("with both attempts on the record, not just the one that worked", ledger.length === 2, String(ledger.length));
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.secondRung" } });
  orA.server.close();
  claudeA.server.close();

  // --- Scenario B: every rung silent, Claude finishes ------------------------

  const hitsB: Hit[] = [];
  const orB = await openRouterStub(hitsB, () => ({ status: 503, payload: "upstream is busy" }));
  const anthB: Record<string, unknown>[] = [];
  const claudeB = await anthropicStub(anthB);
  process.env.OPENROUTER_BASE_URL = orB.url;
  process.env.ANTHROPIC_BASE_URL = claudeB.url;
  clearSettingsCache();

  const second = await ask("check.free.allSilent");
  const calledB = hitsB.filter((hit) => !hit.path.includes("/models")).map((hit) => hit.model);
  check("all three rungs are tried", calledB.join(",") === RUNGS.join(","), calledB.join(","));
  check("then Claude does the work", second.provider === "anthropic" && second.data.answer === "from claude", `${second.provider} / ${second.data.answer}`);
  check(
    "and the note names the rungs rather than saying the vendor failed three times",
    RUNGS.every((rung) => (second.fallbackNote ?? "").includes(rung)),
    second.fallbackNote ?? "(none)",
  );
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.allSilent" } });
  orB.server.close();
  claudeB.server.close();

  // --- Scenario C: a refused key does not climb ------------------------------

  const hitsC: Hit[] = [];
  const orC = await openRouterStub(hitsC, () => ({ status: 402, payload: "Insufficient credits" }));
  const anthC: Record<string, unknown>[] = [];
  const claudeC = await anthropicStub(anthC);
  process.env.OPENROUTER_BASE_URL = orC.url;
  process.env.ANTHROPIC_BASE_URL = claudeC.url;
  clearSettingsCache();
  clearOpenRouterCooldown();

  const agent = await runAgentLoop({
    purpose: "check.free.agentRefused",
    system: "You are a check.",
    prompt: "Say you are done.",
    tools: [lookUpTool],
    effort: "medium",
  });
  const calledC = hitsC.filter((hit) => !hit.path.includes("/models")).map((hit) => hit.model);
  check("an empty balance is asked once, not once per rung", calledC.length === 1, calledC.join(", "));
  check("and the run still finishes on Claude", agent.stoppedBecause === "finished" && agent.model.startsWith("claude"), `${agent.stoppedBecause} / ${agent.model}`);
  check(
    "which was asked for a Claude model, not a free OpenRouter id",
    anthC.every((body) => String(body.model).startsWith("claude")),
    anthC.map((body) => String(body.model)).join(", "),
  );
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.agentRefused" } });
  orC.server.close();
  claudeC.server.close();

  // --- Scenario D: the agent loop climbs, then hands over --------------------

  const hitsD: Hit[] = [];
  const orD = await openRouterStub(hitsD, (model) => {
    if (model === RUNGS[2]) {
      return {
        status: 200,
        payload: {
          id: "chatcmpl_free_agent",
          object: "chat.completion",
          model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        },
      };
    }
    return { status: 429, payload: "Rate limit exceeded" };
  });
  const anthD: Record<string, unknown>[] = [];
  const claudeD = await anthropicStub(anthD);
  process.env.OPENROUTER_BASE_URL = orD.url;
  process.env.ANTHROPIC_BASE_URL = claudeD.url;
  clearSettingsCache();
  clearOpenRouterCooldown();

  const climbed = await runAgentLoop({
    purpose: "check.free.agentClimbs",
    system: "You are a check.",
    prompt: "Say you are done.",
    tools: [lookUpTool],
    effort: "medium",
  });
  const calledD = hitsD.filter((hit) => !hit.path.includes("/models")).map((hit) => hit.model);
  check("an agent turn climbs the ladder too", calledD.join(",") === RUNGS.join(","), calledD.join(","));
  check("and the third rung finishes the run", climbed.stoppedBecause === "finished" && climbed.model === RUNGS[2], `${climbed.stoppedBecause} / ${climbed.model}`);
  check("without paying for Claude", anthD.length === 0, `${anthD.length} call(s)`);
  check("and the run is priced at nothing", Number(climbed.costUsd) === 0, String(climbed.costUsd));
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.agentClimbs" } });
  orD.server.close();
  claudeD.server.close();

  // --- Scenario E: no ladder, and nothing changes ---------------------------
  //
  // The negative that matters most. Without a ladder a 429 requeues the task
  // rather than moving the bill to Claude — that is a deliberate difference for
  // the same status, and the one most likely to be flattened into agreement by
  // somebody reading only one of the two branches.

  await prisma.appSetting.deleteMany({ where: { key: SETTING.OPENROUTER_FREE_MODELS } });
  clearSettingsCache();
  clearOpenRouterCooldown();

  const hitsE: Hit[] = [];
  const orE = await openRouterStub(hitsE, () => ({ status: 429, payload: "Rate limit exceeded" }));
  const anthE: Record<string, unknown>[] = [];
  const claudeE = await anthropicStub(anthE);
  process.env.OPENROUTER_BASE_URL = orE.url;
  process.env.ANTHROPIC_BASE_URL = claudeE.url;
  clearSettingsCache();

  let requeued = "";
  try {
    await runAgentLoop({
      purpose: "check.free.noLadder",
      system: "You are a check.",
      prompt: "Say you are done.",
      tools: [lookUpTool],
      effort: "medium",
    });
  } catch (err) {
    requeued = (err as Error).message;
  }
  check("with no ladder a rate limit still requeues the task", requeued.includes("rate-limiting"), requeued || "(the run finished)");
  check("and does not quietly move the bill to Claude", anthE.length === 0, `${anthE.length} call(s)`);
  const calledE = hitsE.filter((hit) => !hit.path.includes("/models")).map((hit) => hit.model);
  check("asking the one configured model, not a free id", calledE.every((model) => !RUNGS.includes(model ?? "")), calledE.join(", "));
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.noLadder" } });
  orE.server.close();
  claudeE.server.close();

  await restore();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  const { prisma } = await import("../src/lib/prisma.js");
  await prisma.$disconnect();
  process.exitCode = 1;
});
