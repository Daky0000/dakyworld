/**
 * The free ladders: three free models per job, tried in order, then the paid floor.
 *
 * NVIDIA serves every model on this endpoint free. They are real models
 * and they are also the least reliable thing in this system — a free endpoint is
 * shared, so it queues, rate-limits, and some of the time simply does not
 * answer. One of them as *the* model is a system that stops working at busy
 * times. Three of them in a row with a paid floor behind them is a system that
 * costs nothing most days and never stops.
 *
 * Nine claims, and the negatives are the half that matter:
 *
 *  1. Every rung is tried, in the order it was set, and the work still gets
 *     done by the last one that answers.
 *  2. When the whole ladder is silent, Claude finishes — and is asked for a
 *     *Claude* model, not the free slug the run started on.
 *  3. A rate limit climbs the ladder. With free models switched off it must
 *     still requeue the task, which is a deliberately different answer for the
 *     same status and the one thing most likely to be "simplified" into
 *     agreement.
 *  4. A key-level refusal — wrong key, no credits, banned account — does **not**
 *     climb. It is true of every model on the account, so three calls into the
 *     same wall is three wasted calls and a slower failure.
 *  5. A rung is priced at zero in the ledger. An unpriced model falls through
 *     to the floor rate, which is deliberately the dearest we know of, so a
 *     free day would otherwise read as the most expensive one this company has
 *     ever had and trip every budget ceiling on money nobody spent.
 *  6. **A deployment that has configured nothing still runs free-first.** The
 *     ladder was an opt-in for one day, and an opt-in nobody has opted into is
 *     a feature that does nothing.
 *  7. **Unset, empty and unreadable are three different states.** Unset is the
 *     shipped ladder, an empty list is free models deliberately off, and a
 *     corrupt row falls back to the shipped ladder rather than quietly starting
 *     to spend money.
 *  8. **The paid floor is the best of three, not Claude alone.** A rate-limited
 *     Claude hands the run to ChatGPT, and a failing ChatGPT hands it to Gemini
 *     — with the conversation intact across all three wires.
 *  9. Every shipped rung is a model this app has probed and priced at zero,
 *     no ladder starts on one that would not serve, only models that can see
 *     are in the vision ladder, and only tool-callers are in the agent one.
 *     NVIDIA's catalogue publishes no capabilities at all, so this table is
 *     the only guarantee there is.
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

const RUNGS = ["free/one", "free/two", "free/three"];

interface Hit {
  path: string;
  model?: string;
  /**
   * What actually went over the wire.
   *
   * Carried because one scenario asserts on the *contents* of the request and
   * not just on how many there were: the continuation has to be visible in the
   * second rung's system prompt, and "two calls happened" is exactly the shape
   * of assertion that passes while the feature does nothing.
   */
  body?: Record<string, unknown>;
}

/**
 * A fake NVIDIA that answers the catalogue and lets each test decide what
 * a completion does.
 *
 * The catalogue is served because `verifyProviderKey` and `pruneFreeLadders`
 * read it, so a fake without `/models` makes every scenario here
 * fail on a lookup rather than on the thing being tested.
 */
/**
 * Every stub server this file starts, so the teardown can close the ones a
 * failing scenario never reached. A listening server keeps Node's event loop
 * alive; that is what turns one failed assertion into a run that never ends.
 */
const opened: Server[] = [];

function nvidiaStub(
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
          // NVIDIA's own catalogue shape, which is four fields and no
          // capabilities: no pricing, no `supported_parameters`, nothing about
          // tools, schemas or vision. That is the whole reason `FREE_MODELS`
          // exists as a written-down, probed table — a fake that published
          // capabilities here would be testing a lookup this app cannot make.
          res.end(
            JSON.stringify({
              data: [
                ...RUNGS.map((id) => ({ id, object: "model", created: 735790403, owned_by: id.split("/")[0] })),
                { id: "paid/model", object: "model", created: 735790403, owned_by: "paid" },
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
        hits.push({ path, model, body });
        const answer = reply(model, completions);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(typeof answer.payload === "string" ? answer.payload : JSON.stringify(answer.payload));
      });
    });
    opened.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

function anthropicStub(
  bodies: Record<string, unknown>[],
  /** Answers with something other than a completed turn — a refused key, say. */
  reply?: (body: Record<string, unknown>) => { status: number; payload: unknown },
): Promise<{ server: Server; url: string }> {
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
        const answer = reply?.(body);
        if (answer) {
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(typeof answer.payload === "string" ? answer.payload : JSON.stringify(answer.payload));
          return;
        }
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
    opened.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/**
 * A fake ChatGPT. Same wire as OpenRouter — which is the point of putting it
 * second on the paid floor — so this is the OpenRouter stub without a
 * catalogue.
 */
function chatCompletionsStub(
  hits: Hit[],
  reply: (model: string) => { status: number; payload: unknown },
): Promise<{ server: Server; url: string }> {
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
        const model = String(body.model ?? "");
        hits.push({ path: req.url ?? "", model });
        const answer = reply(model);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(typeof answer.payload === "string" ? answer.payload : JSON.stringify(answer.payload));
      });
    });
    opened.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/**
 * A fake Gemini, which is the one wire on the floor that is genuinely a
 * different shape: `:generateContent`, `contents` rather than `messages`, and
 * an answer in `candidates[0].content.parts`.
 */
function geminiStub(
  bodies: Record<string, unknown>[],
  reply?: (call: number) => Record<string, unknown>,
  /**
   * Refuse an unsigned function call the way Gemini 3 actually does.
   *
   * Without this the signature assertion is the only thing standing between a
   * regression and a green run, and a wire check that cannot reproduce the
   * vendor's refusal is a check that would have passed on the broken code.
   */
  signaturesRequired?: boolean,
): Promise<{ server: Server; url: string }> {
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
        const unsigned =
          signaturesRequired &&
          ((body.contents ?? []) as { parts?: Record<string, unknown>[] }[]).some((entry) =>
            (entry.parts ?? []).some((part) => part.functionCall && !part.thoughtSignature),
          );
        if (unsigned) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message:
                  "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly.",
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            reply?.(bodies.length) ?? {
              modelVersion: "gemini-check",
              candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Done, from Gemini." }] } }],
              usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 6 },
            },
          ),
        );
      });
    });
    opened.push(server);
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
  const { FREE_LADDER_BY_JOB, FREE_MODELS, freeLadderFor, freeLadderSource, isFreeModel, FREE_LADDER_MAX, PAID_AGENT_CHAIN } = await import("../src/lib/models/registry.js");

  // The ladders are stored per job now, so a scenario that wants "these three
  // rungs" has to say which job. Both halves of the model layer are driven
  // here — `callModel` on the `text` job and `runAgentLoop` on `agent` — and a
  // ladder set on one of them is a scenario that silently tests the shipped
  // ladder on the other.
  const ladders = (rungs: string[]) => JSON.stringify({ text: rungs, agent: rungs });
  const { runAgentLoop, clearNvidiaCooldown } = await import("../src/lib/claudeAgent.js");

  // Rule one of this directory: a database and nothing else, and certainly no
  // real vendor on the other end. A dev database holds whatever keys were
  // pasted while testing, and `getSetting` falls back to those rows — so a
  // scenario that wants a vendor unconnected has to remove the row as well as
  // the variable. Snapshotted and put back at the end.
  const VENDOR_SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.ANTHROPIC_MODEL,
    SETTING.ANTHROPIC_MODEL_ECONOMY,
    SETTING.NVIDIA_KEY,
    SETTING.NVIDIA_MODEL,
    SETTING.NVIDIA_FREE_MODELS,
    // The other two thirds of the paid floor. A machine with a real ChatGPT key
    // pasted would otherwise have the last scenario reach OpenAI for real.
    SETTING.OPENAI_KEY,
    SETTING.OPENAI_MODEL,
    SETTING.GEMINI_KEY,
    SETTING.GEMINI_MODEL,
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

  // Every scenario runs inside this. A stub server that is still listening
  // keeps the event loop alive, so a scenario that throws used to leave the
  // process hanging with nothing printed and the check keys still in the dev
  // database — which reads exactly like the check itself is broken. The
  // failure is reported and the machine put back either way.
  try {

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

  await setSetting(SETTING.NVIDIA_FREE_MODELS, ladders([...RUNGS, "free/four"]));
  clearSettingsCache();
  const ladder = await freeLadderFor("text");
  check(`the ladder is capped at ${FREE_LADDER_MAX}`, ladder.length === FREE_LADDER_MAX, String(ladder.length));
  check("and keeps the order it was set in", ladder.join(",") === RUNGS.join(","), ladder.join(","));
  // Set on both jobs by `ladders()`, and read back on both. A per-job store
  // whose keys are not actually separate is a store that looks configured and
  // serves one list to everything, which is what it replaced.
  check("and each job has its own", (await freeLadderFor("agent")).join(",") === RUNGS.join(","));

  await setSetting(SETTING.NVIDIA_FREE_MODELS, ladders(["free/one", "free/one", "free/two"]));
  clearSettingsCache();
  // A repeated rung is a rung that proves nothing — the same endpoint that just
  // failed is asked again and the ladder is shorter than it looks.
  check("a duplicate rung is dropped", (await freeLadderFor("text")).join(",") === "free/one,free/two");

  // 7. Unset, empty and unreadable are three different states, and the whole
  // "free first by default" promise rests on the first of them.
  await prisma.appSetting.deleteMany({ where: { key: SETTING.NVIDIA_FREE_MODELS } });
  clearSettingsCache();
  const shipped = await freeLadderFor("text");
  check("a deployment that has configured nothing still has a ladder", shipped.length === FREE_LADDER_MAX, String(shipped.length));
  check("and it is the shipped one", shipped.join(",") === FREE_LADDER_BY_JOB.text.join(","), shipped.join(","));
  check("named as the shipped one rather than as somebody's choice", (await freeLadderSource("text")) === "shipped");

  // 9. Every shipped rung is a model this app has actually probed and priced
  // at zero. `isFreeModel` is what stops a rung falling through to the floor
  // rate — deliberately the dearest we know of — so a free day would otherwise
  // read as the most expensive one this company has ever had.
  //
  // The vendor this replaced published a `:free` suffix and a per-model rate,
  // so a written-down list could be checked against a naming convention.
  // NVIDIA's catalogue publishes neither: `/v1/models` returns `id`, `object`,
  // `created` and `owned_by` and nothing else. Membership of `FREE_MODELS` —
  // where every flag was proved against the endpoint on a recorded date — is
  // the only guarantee there is, which is exactly why it is asserted here.
  const known = new Set(FREE_MODELS.map((model) => model.id));
  for (const [job, rungs] of Object.entries(FREE_LADDER_BY_JOB)) {
    check(
      `every shipped rung for ${job} is a model this app has verified`,
      rungs.every((id) => known.has(id)),
      rungs.filter((id) => !known.has(id)).join(", ") || "all known",
    );
  }
  const priced = await Promise.all(FREE_MODELS.map((model) => isFreeModel(model.id)));
  check("and every verified model is priced at zero", priced.every(Boolean));

  // 10. **Nothing that is known not to serve is in a shipped ladder.** Two
  // models in the catalogue would not answer when this app last checked, and a
  // first rung that times out costs every call sixty seconds before anything
  // useful happens — which is worse than not having it at all.
  const down = new Set(FREE_MODELS.filter((model) => model.down).map((model) => model.id));
  check(
    "no shipped ladder starts on a model that would not serve",
    Object.values(FREE_LADDER_BY_JOB).every((rungs) => rungs.every((id) => !down.has(id))),
    [...down].join(", "),
  );

  // 11. **The vision ladder can only hold models that can see.** Getting this
  // wrong is not a slow job, it is an Apify screenshot bought and then
  // described by a model that never looked at it — the exact failure the
  // routing chain was built for, one layer down.
  const blind = new Set(FREE_MODELS.filter((model) => !model.vision).map((model) => model.id));
  check(
    "every rung for vision can actually look at a picture",
    FREE_LADDER_BY_JOB.vision.every((id) => !blind.has(id)),
    FREE_LADDER_BY_JOB.vision.join(", "),
  );

  // 12. **Every rung for the agent loop can call tools.** One that cannot
  // fails on its first turn, having read the whole system prompt first.
  const toolless = new Set(FREE_MODELS.filter((model) => !model.tools).map((model) => model.id));
  check(
    "every rung for running agents can call tools",
    FREE_LADDER_BY_JOB.agent.every((id) => !toolless.has(id)),
    FREE_LADDER_BY_JOB.agent.join(", "),
  );

  await setSetting(SETTING.NVIDIA_FREE_MODELS, ladders([]));
  clearSettingsCache();
  check("an empty list is free models switched off, deliberately", (await freeLadderFor("text")).length === 0);
  check("and says so rather than reading as unconfigured", (await freeLadderSource("text")) === "off");

  await setSetting(SETTING.NVIDIA_FREE_MODELS, "not json at all");
  clearSettingsCache();
  // Unreadable is not the same as off. Falling through to the paid model here
  // would answer a corrupt settings row by starting to spend money.
  check("a corrupt setting falls back to the shipped ladder", (await freeLadderFor("text")).join(",") === FREE_LADDER_BY_JOB.text.join(","));

  await setSetting(SETTING.NVIDIA_FREE_MODELS, ladders(RUNGS));
  clearSettingsCache();
  check("a list picked here is named as the Owner's", (await freeLadderSource("text")) === "owner");
  check("and the paid floor is three vendors deep", PAID_AGENT_CHAIN.join(",") === "anthropic,openai,gemini", PAID_AGENT_CHAIN.join(","));

  // --- Scenario A: the second rung answers -----------------------------------

  const hitsA: Hit[] = [];
  const orA = await nvidiaStub(hitsA, (model) =>
    model === RUNGS[0] ? { status: 429, payload: "Rate limit exceeded" } : { status: 200, payload: completion(model) },
  );
  const anthA: Record<string, unknown>[] = [];
  const claudeA = await anthropicStub(anthA);

  process.env.NVIDIA_API_KEY = "nvapi-check-not-a-real-key";
  process.env.NVIDIA_BASE_URL = orA.url;
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
  const orB = await nvidiaStub(hitsB, () => ({ status: 503, payload: "upstream is busy" }));
  const anthB: Record<string, unknown>[] = [];
  const claudeB = await anthropicStub(anthB);
  process.env.NVIDIA_BASE_URL = orB.url;
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
  const orC = await nvidiaStub(hitsC, () => ({ status: 402, payload: "Insufficient credits" }));
  const anthC: Record<string, unknown>[] = [];
  const claudeC = await anthropicStub(anthC);
  process.env.NVIDIA_BASE_URL = orC.url;
  process.env.ANTHROPIC_BASE_URL = claudeC.url;
  clearSettingsCache();
  clearNvidiaCooldown();

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
  const orD = await nvidiaStub(hitsD, (model) => {
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
  process.env.NVIDIA_BASE_URL = orD.url;
  process.env.ANTHROPIC_BASE_URL = claudeD.url;
  clearSettingsCache();
  clearNvidiaCooldown();

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

  // --- Scenario E: free models off, and nothing changes ---------------------
  //
  // The negative that matters most. With free models deliberately off, a 429
  // requeues the task rather than moving the bill to a paid vendor — that is a
  // deliberate difference for the same status, and the one most likely to be
  // flattened into agreement by somebody reading only one of the two branches.
  //
  // Stored as `[]`, not deleted: deleting the row now means "use the shipped
  // ladder", which is the opposite of what this scenario is about.

  await setSetting(SETTING.NVIDIA_FREE_MODELS, ladders([]));
  clearSettingsCache();
  clearNvidiaCooldown();

  const hitsE: Hit[] = [];
  const orE = await nvidiaStub(hitsE, () => ({ status: 429, payload: "Rate limit exceeded" }));
  const anthE: Record<string, unknown>[] = [];
  const claudeE = await anthropicStub(anthE);
  process.env.NVIDIA_BASE_URL = orE.url;
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
  check("with free models off a rate limit still requeues the task", requeued.includes("rate-limiting"), requeued || "(the run finished)");
  check("and does not quietly move the bill to a paid vendor", anthE.length === 0, `${anthE.length} call(s)`);
  const calledE = hitsE.filter((hit) => !hit.path.includes("/models")).map((hit) => hit.model);
  check("asking the one configured model, not a free id", calledE.every((model) => !RUNGS.includes(model ?? "")), calledE.join(", "));
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.noLadder" } });
  orE.server.close();
  claudeE.server.close();

  // --- Scenario G: the next model finishes what the last one started --------
  //
  // The Owner's instruction: a paid model taking over from a free one "should
  // not start the process all over, but continue from where it left". The
  // agent loop has always done that — the conversation, the tool results and
  // the checkpoint all survive a handover. This is the other half of the model
  // layer, the one-shot `callModel` path, where every attempt used to start
  // from an empty page however much the last one had written.
  //
  // Rung one writes half a plan and hits the token ceiling. Rung two must be
  // handed that half, and the model that finally answers must have been handed
  // it too — the carry crosses vendors, not just rungs, because "do not start
  // over" reads oddly if it only holds once money is involved.
  //
  // The negatives are the half that matter, and they are asserted below:
  // a rung that produced *nothing* (rate-limited, refused, silent) carries
  // nothing, or the next model reads an empty block headed "work already done";
  // and the carry never arrives as a prior assistant turn, because a message
  // holding invalid JSON is one the next model is being asked to agree with,
  // and half of them will simply continue the broken string.

  const HALF = '{"answer":"the first half of a long ans';

  // Scenario E switched free models off. Back on, or this scenario is one call
  // to the vendor's own model and every assertion below is about a ladder that
  // was not in use — which is exactly how it failed the first time it ran.
  await setSetting(SETTING.NVIDIA_FREE_MODELS, ladders(RUNGS));
  clearSettingsCache();

  const hitsCarry: Hit[] = [];
  const orCarry = await nvidiaStub(hitsCarry, (model) =>
    model === RUNGS[0]
      ? {
          status: 200,
          payload: {
            id: "chatcmpl_cut",
            object: "chat.completion",
            model,
            // The expensive failure: it wrote something, and then ran out of
            // room. Valid-looking JSON, cut off mid-string.
            choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: HALF } }],
            usage: { prompt_tokens: 200, completion_tokens: 900 },
          },
        }
      : { status: 200, payload: completion(model) },
  );
  const anthCarry: Record<string, unknown>[] = [];
  const claudeCarry = await anthropicStub(anthCarry);
  process.env.NVIDIA_BASE_URL = orCarry.url;
  process.env.ANTHROPIC_BASE_URL = claudeCarry.url;
  clearSettingsCache();

  const finished = await ask("check.free.continuation");
  const bodiesCarry = hitsCarry.filter((hit) => !hit.path.includes("/models"));
  const secondSystem = String((bodiesCarry[1]?.body?.messages as { content?: unknown }[] | undefined)?.[0]?.content ?? "");

  check("a truncated rung still climbs to the next one", bodiesCarry.length === 2, String(bodiesCarry.length));
  check("and the next rung is handed what the last one wrote", secondSystem.includes(HALF), secondSystem.slice(-160));
  check("...as work to finish rather than an answer to trust", secondSystem.includes("Do not start again from nothing"));
  check("...in the system prompt, never as a prior assistant turn", (bodiesCarry[1]?.body?.messages as unknown[] | undefined)?.length === 2);
  check("the finished answer is the one that comes back", finished.data.answer === "from a free model", finished.data.answer);
  check("and the reply names whose work was finished on", finished.continuedFrom === RUNGS[0], String(finished.continuedFrom));
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.continuation" } });
  orCarry.server.close();
  claudeCarry.server.close();

  // The negative: a rung that produced nothing carries nothing. A rate limit,
  // a refused key and a timeout have all told us exactly as much about this
  // request as each other — which is nothing — and an empty block headed "work
  // already done" is worse than no block at all.
  const hitsBare: Hit[] = [];
  const orBare = await nvidiaStub(hitsBare, (model) =>
    model === RUNGS[0] ? { status: 429, payload: "Rate limit exceeded" } : { status: 200, payload: completion(model) },
  );
  const anthBare: Record<string, unknown>[] = [];
  const claudeBare = await anthropicStub(anthBare);
  process.env.NVIDIA_BASE_URL = orBare.url;
  process.env.ANTHROPIC_BASE_URL = claudeBare.url;
  clearSettingsCache();

  const empty = await ask("check.free.noCarry");
  const bodiesBare = hitsBare.filter((hit) => !hit.path.includes("/models"));
  const bareSystem = String((bodiesBare[1]?.body?.messages as { content?: unknown }[] | undefined)?.[0]?.content ?? "");
  check("a rung that produced nothing carries nothing forward", !bareSystem.includes("Work already done"), bareSystem.slice(-120));
  check("and the reply says nothing was finished", empty.continuedFrom === null, String(empty.continuedFrom));
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.noCarry" } });
  orBare.server.close();
  claudeBare.server.close();

  // --- Scenario F: the paid floor is the best of three ----------------------
  //
  // The instruction was "three free models, then the best paid one of the
  // three". A floor of one vendor under a ladder built entirely out of
  // endpoints that fail is a single point of failure in the place least able to
  // afford one: a run that survived three busy free models and then met a
  // rate-limited Claude died with two connected vendors sitting unasked.
  //
  // Claude refuses the key, ChatGPT breaks, Gemini finishes — over three
  // different wires, with the same conversation.

  await setSetting(SETTING.NVIDIA_FREE_MODELS, ladders(RUNGS));
  await setSetting(SETTING.OPENAI_KEY, "sk-check-not-a-real-key");
  await setSetting(SETTING.GEMINI_KEY, "gm-check-not-a-real-key");
  clearSettingsCache();
  clearNvidiaCooldown();

  const hitsF: Hit[] = [];
  const orF = await nvidiaStub(hitsF, () => ({ status: 503, payload: "upstream is busy" }));
  const anthF: Record<string, unknown>[] = [];
  const claudeF = await anthropicStub(anthF, () => ({ status: 401, payload: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }));
  const openAiF: Hit[] = [];
  const chatgptF = await chatCompletionsStub(openAiF, () => ({ status: 500, payload: "internal error" }));
  const geminiF: Record<string, unknown>[] = [];
  const gmF = await geminiStub(geminiF);

  process.env.NVIDIA_BASE_URL = orF.url;
  process.env.ANTHROPIC_BASE_URL = claudeF.url;
  process.env.OPENAI_BASE_URL = chatgptF.url;
  process.env.GEMINI_BASE_URL = gmF.url;
  clearSettingsCache();

  // What somebody watching this run would have seen while it happened. Every
  // line below was a `console.warn` on the server and nothing else until
  // 31 Aug 2026, so a run spending minutes climbing a ladder showed on the
  // screen as a task sitting still.
  const watched: string[] = [];
  const floor = await runAgentLoop({
    purpose: "check.free.paidFloor",
    system: "You are a check.",
    prompt: "Say you are done.",
    tools: [lookUpTool],
    effort: "medium",
    onServing: async (note) => {
      watched.push(note);
    },
  });
  const calledF = hitsF.filter((hit) => !hit.path.includes("/models")).map((hit) => hit.model);
  check("every free rung is tried before anything is paid for", calledF.join(",") === RUNGS.join(","), calledF.join(","));
  check("then Claude is asked first of the paid three", anthF.length === 1, `${anthF.length} call(s)`);
  check("a refused Claude hands on rather than losing the run", openAiF.length === 1, `${openAiF.length} ChatGPT call(s)`);
  check("and a broken ChatGPT hands on to Gemini", geminiF.length === 1, `${geminiF.length} Gemini call(s)`);
  check("which finishes it", floor.stoppedBecause === "finished", floor.stoppedBecause);
  check(
    "the conversation survived three different wires",
    typeof floor.text === "string" && floor.text.includes("Gemini"),
    floor.text,
  );
  // Each vendor is asked for its *own* model. The whole point of a handover is
  // to save a run, and asking Gemini for a free OpenRouter slug fails on the
  // model name at the first turn — which is exactly the defect that survived a
  // green harness once already.
  check(
    "each vendor was asked for a model of its own",
    anthF.every((body) => String(body.model).startsWith("claude")) && openAiF.every((hit) => !RUNGS.includes(hit.model ?? "")),
    `${anthF.map((body) => String(body.model)).join(", ")} | ${openAiF.map((hit) => hit.model).join(", ")}`,
  );
  // The account a person reads while it is still running.
  check("the run says who it is starting on, before the first turn", watched[0]?.includes(RUNGS[0]) === true, watched[0] ?? "(nothing)");
  check(
    "every rung that did not serve is said out loud",
    RUNGS.slice(1).every((rung) => watched.some((note) => note.includes(rung))),
    watched.join(" | ").slice(0, 200),
  );
  check(
    "and so is every handover between paid vendors",
    watched.some((note) => note.includes("ChatGPT takes the rest")) && watched.some((note) => note.includes("Gemini takes the rest")),
    watched.join(" | ").slice(0, 300),
  );
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.paidFloor" } });
  orF.server.close();
  claudeF.server.close();
  chatgptF.server.close();
  gmF.server.close();

  // --- Scenario G: Gemini's thought signatures survive the round trip -------
  //
  // Gemini 3 signs the reasoning behind a function call and requires the
  // signature back on the same part when that call reappears in the history.
  // Drop it and the *second* turn is a 400 INVALID_ARGUMENT naming the tool
  // and its position -- so a run only fails once it has actually used a tool,
  // which is every run that does any work. This happened live, on the first
  // task ever to reach the new floor.

  clearNvidiaCooldown();
  const SIGNATURE = "sig_check_Cg8KDXRob3VnaHRfc2lnbmF0dXJl";
  const geminiG: Record<string, unknown>[] = [];
  const gmG = await geminiStub(geminiG, (call) =>
    call === 1
      ? {
          modelVersion: "gemini-check",
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [{ thoughtSignature: SIGNATURE, functionCall: { name: "look_up", args: { what: "the record" } } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 8 },
        }
      : {
          modelVersion: "gemini-check",
          candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Looked it up, from Gemini." }] } }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 9 },
        },
    true,
  );

  // Gemini alone on the floor, so the run starts and finishes on that wire.
  await prisma.appSetting.deleteMany({
    where: { key: { in: [SETTING.ANTHROPIC_KEY, SETTING.OPENAI_KEY, SETTING.NVIDIA_KEY] } },
  });
  await setSetting(SETTING.GEMINI_KEY, "gm-check-not-a-real-key");
  await setSetting(SETTING.NVIDIA_FREE_MODELS, ladders([]));
  // The row is only half of it: `getSetting` prefers the environment, and the
  // scenarios above export three of these keys for the whole process. A vendor
  // meant to be unconnected has to lose both, or this run starts on OpenRouter
  // against a stub that has already been closed.
  delete process.env.NVIDIA_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.GEMINI_API_KEY = "gm-check-not-a-real-key";
  process.env.GEMINI_BASE_URL = gmG.url;
  clearSettingsCache();

  const signed = await runAgentLoop({
    purpose: "check.free.geminiSignature",
    system: "You are a check.",
    prompt: "Look something up, then say you are done.",
    tools: [lookUpTool],
    effort: "medium",
  });

  const secondTurn = geminiG[1] as { contents?: { parts?: Record<string, unknown>[] }[] } | undefined;
  const sentBack = (secondTurn?.contents ?? [])
    .flatMap((entry) => entry.parts ?? [])
    .find((part) => part.functionCall);
  check("a signed function call is answered rather than refused", signed.stoppedBecause === "finished", signed.stoppedBecause);
  check("the tool actually ran", signed.toolCalls === 1, `${signed.toolCalls} tool call(s)`);
  check("the history goes back with the call in it", Boolean(sentBack), JSON.stringify(secondTurn?.contents ?? []).slice(0, 200));
  check(
    "...carrying the thought signature Gemini issued with it",
    sentBack?.thoughtSignature === SIGNATURE,
    String(sentBack?.thoughtSignature),
  );
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.geminiSignature" } });
  gmG.server.close();

  // And the same signature must not reach Anthropic, which refuses a content
  // block carrying a field its schema does not define. A resumed run is where
  // that bites: the checkpoint holds the signed call, and the vendor above
  // Gemini on the floor is Claude.
  const anthG: Record<string, unknown>[] = [];
  const claudeG = await anthropicStub(anthG);
  await prisma.appSetting.deleteMany({ where: { key: { in: [SETTING.GEMINI_KEY] } } });
  await setSetting(SETTING.ANTHROPIC_KEY, "sk-ant-check-not-a-real-key");
  delete process.env.GEMINI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  process.env.ANTHROPIC_BASE_URL = claudeG.url;
  clearSettingsCache();

  const carried = await runAgentLoop({
    purpose: "check.free.signatureStrip",
    system: "You are a check.",
    prompt: "Carry on.",
    tools: [lookUpTool],
    effort: "medium",
    resume: {
      iteration: 1,
      messages: [
        { role: "user", content: "Look something up." },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "gemini_x", name: "look_up", input: { what: "the record" }, thoughtSignature: SIGNATURE } as never,
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "gemini_x", content: "the record" }] },
      ],
      narration: [],
      pendingAssistant: null,
      pendingResults: null,
      pendingStop: false,
      toolCalls: 1,
      inputTokens: 90,
      outputTokens: 8,
      costUsd: 0,
      model: "gemini-check",
    },
  });
  check(
    "a resumed run reaches Claude at all",
    anthG.length >= 1 && carried.stoppedBecause === "finished",
    `${anthG.length} call(s) / ${carried.stoppedBecause}`,
  );
  check(
    "...with no Gemini signature on any block Anthropic would refuse",
    !JSON.stringify(anthG).includes(SIGNATURE),
    JSON.stringify(anthG).slice(0, 200),
  );
  await prisma.llmCall.deleteMany({ where: { purpose: "check.free.signatureStrip" } });
  claudeG.server.close();

  } catch (err) {
    // A scenario that threw is a failed check, not a crashed script.
    failures.push(`the run stopped: ${(err as Error).message}`);
    console.log(`
  THREW  ${(err as Error).stack ?? (err as Error).message}`);
  } finally {
    for (const server of opened) {
      try {
        server.close();
      } catch {
        // Already closed by the scenario that opened it.
      }
    }
    await restore();
    console.log(`
${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) process.exitCode = 1;
    await prisma.$disconnect();
  }
}

void main().catch(async (err) => {
  console.error(err);
  const { prisma } = await import("../src/lib/prisma.js");
  await prisma.$disconnect();
  process.exitCode = 1;
});
