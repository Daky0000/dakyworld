/**
 * Task sizing: every agent task is judged simple, standard or complex before it
 * starts, and the level picks which of a paid vendor's three models runs it.
 *
 * Before this the model came from **who the agent was** — the board and anybody
 * writing to a stranger on Claude's top model, everyone else on the economy
 * one, ChatGPT and Gemini on one model each whatever the task. The router sits
 * between the task and the agent and asks what the task is instead.
 *
 * What this holds still, in three halves:
 *
 *  1. **The rules**, as pure functions: the score of a dozen task shapes the
 *     workforce actually produces, the thresholds, the clamp, and that every
 *     model a level can resolve to has a published rate. An unpriced model is
 *     billed at the dearest rate known, so a day of cheap simple tasks would
 *     read as the most expensive day the company has had.
 *  2. **The decision**, with the free-model look replaced by a fake: the
 *     Owner's override wins, a resumed conversation keeps its level, a failed
 *     run comes back one level up, the look is asked only on a boundary and is
 *     clamped to one step, a failed look keeps the rules' answer, `off` gives
 *     back exactly the old effort, and a budget in its downgrade band holds
 *     the level at standard.
 *  3. **The wire.** Asserted on the request body of each vendor on its own —
 *     the small model reaches Claude, ChatGPT and Gemini for a simple task and
 *     the flagship for a complex one. A blanket "somebody answered" assertion
 *     over a fallback chain cannot see one broken member of it; that trap has
 *     cost this codebase a green run before. Then a real `runTask`, so the
 *     level is shown to be written down, said on the timeline, and sent.
 *
 * A database and local fakes. No API key and no network.
 *   npx tsx checks/taskRouting.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Agent, AgentTask } from "@prisma/client";

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

const {
  OUTSIDE_WRITING_FLOOR,
  WRITES_FOR_OUTSIDE,
  clampLevel,
  fromStored,
  isUnclear,
  legacyEffort,
  levelForScore,
  routeTask,
  scoreTask,
  stepUp,
  toStored,
} = await import("../src/services/agents/complexity.js");
type TaskFacts = import("../src/services/agents/complexity.js").TaskFacts;
const {
  FREE_LADDER_BY_JOB,
  FREE_MODELS,
  JOBS,
  MODEL_JOBS,
  PAID_AGENT_CHAIN,
  PROVIDERS,
  PROVIDER_PRICING,
  TASK_LEVELS,
  TIER_MODELS,
  effortForLevel,
  isPricedModel,
  levelForEffort,
} = await import("../src/lib/models/registry.js");
const { MODEL_PRICING } = await import("../src/lib/claudePricing.js");

const NO_LINKS = { lead: false, client: false, project: false, proposal: false, invoice: false };

function facts(over: Partial<TaskFacts>): TaskFacts {
  return {
    title: "A task",
    brief: "Do the thing that needs doing.",
    inputChars: 0,
    origin: "OWNER",
    agentKey: "check.routing.agent",
    agentTier: "OPERATIONAL",
    toolkit: [],
    likely: [],
    linked: NO_LINKS,
    ...over,
  };
}

/** About 1,200 characters of a brief that says nothing either way. */
const MIDDLING =
  "The client has asked for a fortnightly note about the work in progress on their account, covering what was done, what is next and anything waiting on them. ".repeat(8);

// --- 1. The rules --------------------------------------------------------------

console.log("\nThe rules");
{
  const lookup = scoreTask(
    facts({
      agentTier: "SUB_AGENT",
      origin: "AGENT",
      title: "Phone number",
      brief: "Look up the lead's phone number and update the record.",
      likely: ["lead.read"],
      toolkit: [
        { key: "lead.read", scope: "read" },
        { key: "lead.update", scope: "write" },
      ],
    }),
  );
  check("a sub-agent's delegated lookup is simple", levelForScore(lookup.score) === "simple", `${lookup.score}: ${lookup.reasons.join("; ")}`);
  check("and clearly so, so nobody is asked", !isUnclear(lookup.score), String(lookup.score));

  const neutral = scoreTask(facts({ brief: MIDDLING }));
  check(
    "a task with nothing to say about it is standard, not simple",
    levelForScore(neutral.score) === "standard",
    `${neutral.score}: ${neutral.reasons.join("; ")}`,
  );

  const strategy = scoreTask(
    facts({
      agentTier: "EXECUTIVE",
      title: "Pricing strategy",
      brief: `${MIDDLING} Compare the three options, decide which strategy to recommend and say why.`,
    }),
  );
  check("an executive weighing a strategy is complex", levelForScore(strategy.score) === "complex", `${strategy.score}: ${strategy.reasons.join("; ")}`);

  const weekly = scoreTask(facts({ agentTier: "BOARD", origin: "SCHEDULE", title: "Weekly", brief: "Summarise the week for the board." }));
  check(
    "a board member's routine weekly summary is not complex just for the rank",
    levelForScore(weekly.score) !== "complex",
    `${weekly.score}: ${weekly.reasons.join("; ")}`,
  );

  const build = scoreTask(
    facts({
      brief: MIDDLING,
      likely: ["proposal.draft"],
      toolkit: [{ key: "proposal.draft", scope: "write" }],
      linked: { ...NO_LINKS, proposal: true },
    }),
  );
  check("a task that looks like it needs a proposal drafted scores higher", build.score >= neutral.score + 3, `${build.score} vs ${neutral.score}`);

  const carePlan = scoreTask(facts({ title: "Renewal", brief: "Check the care plan renewal date for this client." }));
  check(
    "\"care plan\" is a product here, not a request to plan",
    !carePlan.reasons.some((reason) => reason.includes("(+") && /\bplan\b/.test(reason)),
    carePlan.reasons.join("; "),
  );
  const realPlan = scoreTask(facts({ title: "Launch", brief: "Plan the launch for next month." }));
  check("while a real plan still counts", realPlan.reasons.some((reason) => reason.includes("(+") && /\bplan\b/.test(reason)), realPlan.reasons.join("; "));

  const writer = [...WRITES_FOR_OUTSIDE][0];
  const outside = scoreTask(facts({ agentKey: writer, brief: MIDDLING }));
  check("writing for outside the company counts for something", outside.score === neutral.score + 1, `${outside.score} vs ${neutral.score}`);
  check(
    "but is no longer a floor — the founder's call, 9 Oct 2026",
    OUTSIDE_WRITING_FLOOR === null,
    String(OUTSIDE_WRITING_FLOOR),
  );
  const shortFollowUp = scoreTask(
    facts({ agentKey: writer, agentTier: "SUB_AGENT", origin: "AGENT", brief: "Send the two-line reminder we agreed." }),
  );
  check("so a short follow-up from a writer can reach the small model", levelForScore(shortFollowUp.score) === "simple", `${shortFollowUp.score}`);

  const long = scoreTask(facts({ brief: "x ".repeat(3_500) }));
  check("a very long brief counts", long.reasons.some((reason) => reason.includes("very long")), long.reasons.join("; "));
  const wide = scoreTask(facts({ toolkit: Array.from({ length: 13 }, (_, i) => ({ key: `t.${i}`, scope: "read" })) }));
  check("a wide toolkit counts", wide.reasons.some((reason) => reason.includes("wide toolkit")), wide.reasons.join("; "));

  check("below zero is simple", levelForScore(-1) === "simple");
  check("zero to three is standard", levelForScore(0) === "standard" && levelForScore(3) === "standard");
  check("four and above is complex", levelForScore(4) === "complex");
  check("the boundaries are the unclear scores", [-1, 0, 3, 4].every(isUnclear) && ![-2, 1, 2, 5].some(isUnclear));

  check("a look is held to one step from the rules", clampLevel("complex", "simple") === "standard" && clampLevel("simple", "complex") === "standard");
  check("and is free within it", clampLevel("simple", "standard") === "simple" && clampLevel("complex", "standard") === "complex");
  check("stepping up stops at complex", stepUp("simple") === "standard" && stepUp("complex") === "complex");
  check(
    "level and effort move together, both ways",
    TASK_LEVELS.every((level) => levelForEffort(effortForLevel(level)) === level),
    TASK_LEVELS.map((level) => `${level}→${effortForLevel(level)}`).join(", "),
  );
  check("the database spelling round-trips", TASK_LEVELS.every((level) => fromStored(toStored(level)) === level) && fromStored(null) === null);
  check(
    "off gives back the old effort exactly",
    legacyEffort({ tier: "BOARD", key: "x" }) === "high" &&
      legacyEffort({ tier: "SUB_AGENT", key: writer }) === "high" &&
      legacyEffort({ tier: "SUB_AGENT", key: "x" }) === "medium",
  );
}

console.log("\nEvery level resolves to a model this app can price");
{
  for (const vendor of PAID_AGENT_CHAIN) {
    const ids = TASK_LEVELS.map((level) => TIER_MODELS[vendor][level]);
    check(`${vendor}: every level is priced`, ids.every(isPricedModel), ids.filter((id) => !isPricedModel(id)).join(", ") || "all priced");
    check(`${vendor}: three different models`, new Set(ids).size === 3, ids.join(", "));
    const rate = (id: string) => (PROVIDER_PRICING[id] ?? MODEL_PRICING[id])?.outputPerMTok ?? Infinity;
    check(
      `${vendor}: simple costs less than complex`,
      rate(ids[0]) < rate(ids[2]),
      ids.map((id) => `${id} $${rate(id)}`).join(", "),
    );
  }
}

console.log("\nSizing a task is a job of its own, and a cheap one");
{
  check("it is a routed job", MODEL_JOBS.includes("routing"));
  check("on the economy tier", JOBS.routing.tier === "economy");
  check("starting free", JOBS.routing.defaultProvider === "nvidia");
  const known = new Map(FREE_MODELS.map((model) => [model.id, model]));
  const ladder = FREE_LADDER_BY_JOB.routing;
  check("with three free rungs", ladder.length === 3, ladder.join(", "));
  check(
    "each one a verified model whose schema is enforced and which is not down",
    ladder.every((id) => known.get(id)?.schema === "enforced" && !known.get(id)?.down),
    ladder.join(", "),
  );
  check("from three different houses", new Set(ladder.map((id) => known.get(id)?.house)).size === 3, ladder.map((id) => known.get(id)?.house).join(", "));
  // Sizing a task on a paid model would be paying to decide how much to pay.
  check(
    "and only the free vendor can be asked — never a paid one",
    PAID_AGENT_CHAIN.every((vendor) => !PROVIDERS[vendor].jobs.includes("routing")) && PROVIDERS.nvidia.jobs.includes("routing"),
    Object.values(PROVIDERS).filter((provider) => provider.jobs.includes("routing")).map((provider) => provider.key).join(", "),
  );
}

// --- 2. The decision -------------------------------------------------------------

function agentRow(over: Partial<Agent> = {}): Agent {
  return { key: "check.routing.agent", name: "Routing Check", title: "Routing Check", tier: "OPERATIONAL", toolkit: [], ...over } as Agent;
}

function taskRow(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "check-task",
    title: "A task",
    brief: MIDDLING,
    input: null,
    origin: "OWNER",
    level: null,
    levelOverride: null,
    levelReason: null,
    levelSource: null,
    leadId: null,
    clientId: null,
    projectId: null,
    proposalId: null,
    invoiceId: null,
    ...over,
  } as AgentTask;
}

/** A fake free-model look that records whether it was asked. */
function fakeLook(answer: { level: "simple" | "standard" | "complex"; reason: string } | null | "throw") {
  const calls: string[] = [];
  const look = async (agent: { key: string }) => {
    calls.push(agent.key);
    if (answer === "throw") throw new Error("the free model fell over");
    return answer;
  };
  return { look: look as never, calls };
}

async function decisions() {
  console.log("\nThe decision");
  const base: { toolkit: Array<{ key: string; scope: string }>; likely: string[]; resuming: boolean; previousStatus: null } = {
    toolkit: [],
    likely: [],
    resuming: false,
    previousStatus: null,
  };

  const off = await routeTask({ ...base, agent: agentRow({ tier: "BOARD" }), task: taskRow(), mode: "off" });
  check("off sizes nothing", off.level === null && off.decidedBy === "legacy", `${off.level}/${off.decidedBy}`);
  check("and hands back the old effort", off.effort === "high", off.effort);
  check("and says nothing on the timeline", off.sentence === null);

  const owner = await routeTask({ ...base, agent: agentRow(), task: taskRow({ levelOverride: "SIMPLE" }), mode: "full", look: fakeLook(null).look });
  check("the Owner's call wins", owner.level === "simple" && owner.decidedBy === "owner", `${owner.level}/${owner.decidedBy}`);

  const resumed = await routeTask({ ...base, agent: agentRow(), task: taskRow({ level: "COMPLEX" }), resuming: true, mode: "full" });
  check("a resumed conversation keeps its level", resumed.level === "complex" && resumed.decidedBy === "stored", `${resumed.level}/${resumed.decidedBy}`);
  check("without a fresh line every time it resumes", resumed.sentence === null, resumed.sentence ?? "");

  const retried = await routeTask({ ...base, agent: agentRow(), task: taskRow({ level: "SIMPLE" }), resuming: true, previousStatus: "FAILED", mode: "full" });
  check("a run that failed comes back one level up", retried.level === "standard" && retried.decidedBy === "retry", `${retried.level}/${retried.decidedBy}`);

  const paused = await routeTask({ ...base, agent: agentRow(), task: taskRow({ level: "SIMPLE" }), resuming: true, previousStatus: "QUEUED", mode: "full" });
  check("a run put down for a busy vendor does not", paused.level === "simple", paused.level ?? "null");

  // A short neutral brief scores -1: on the simple/standard line.
  const shortTask = taskRow({ title: "Note", brief: "Send the usual note." });

  const rulesOnly = fakeLook({ level: "complex", reason: "unused" });
  const ruled = await routeTask({ ...base, agent: agentRow(), task: shortTask, mode: "rules", look: rulesOnly.look });
  check("rules mode never asks a model", rulesOnly.calls.length === 0 && ruled.decidedBy === "rules", `${rulesOnly.calls.length} call(s)`);

  const looked = fakeLook({ level: "complex", reason: "It is secretly a negotiation." });
  const clamped = await routeTask({ ...base, agent: agentRow(), task: shortTask, mode: "full", look: looked.look });
  check("full mode asks on a boundary", looked.calls.length === 1, `${looked.calls.length} call(s)`);
  check("and holds the answer to one step from the rules", clamped.level === "standard" && clamped.decidedBy === "model", `${clamped.level}/${clamped.decidedBy}`);
  check("and says what the model said", (clamped.sentence ?? "").includes("secretly a negotiation"), clamped.sentence ?? "");

  const silent = fakeLook(null);
  const kept = await routeTask({ ...base, agent: agentRow(), task: shortTask, mode: "full", look: silent.look });
  check("a look with no answer keeps the rules' level", kept.level === "simple" && kept.decidedBy === "rules", `${kept.level}/${kept.decidedBy}`);

  const broken = fakeLook("throw");
  const survived = await routeTask({ ...base, agent: agentRow(), task: shortTask, mode: "full", look: broken.look });
  check("and so does one that throws — sizing never stops a task", survived.level === "simple", survived.level ?? "null");

  const clear = fakeLook({ level: "complex", reason: "unused" });
  await routeTask({
    ...base,
    agent: agentRow({ tier: "SUB_AGENT" }),
    task: taskRow({ origin: "AGENT", title: "Lookup", brief: "Look up the number and update the record." }),
    mode: "full",
    look: clear.look,
  });
  check("a clear score asks nobody", clear.calls.length === 0, `${clear.calls.length} call(s)`);
}

// No database needed: the mode is passed in, the look is faked, and a budget
// that cannot be read leaves the level where it was.
await decisions();

// --- 3. The wire ---------------------------------------------------------------

const opened: Server[] = [];

interface Seen {
  url: string;
  body: Record<string, any>;
}

function stub(seen: Seen[], reply: (seen: Seen) => { status: number; payload: unknown }): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          body = {};
        }
        const hit = { url: req.url ?? "", body };
        seen.push(hit);
        const answer = reply(hit);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(typeof answer.payload === "string" ? answer.payload : JSON.stringify(answer.payload));
      });
    });
    opened.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

const claudeDone = (hit: Seen) => ({
  status: 200,
  payload: {
    id: "msg_check",
    type: "message",
    role: "assistant",
    model: hit.body.model,
    content: [{ type: "text", text: "Done, from Claude." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});

const claudeRefuses = () => ({
  status: 401,
  payload: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
});

const chatgptDone = (hit: Seen) => ({
  status: 200,
  payload: {
    id: "chatcmpl_check",
    object: "chat.completion",
    model: hit.body.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done, from ChatGPT." } }],
    usage: { prompt_tokens: 50, completion_tokens: 5 },
  },
});

const geminiDone = () => ({
  status: 200,
  payload: {
    modelVersion: "gemini-check",
    candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Done, from Gemini." }] } }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
  },
});

const AGENT_KEY = "check.routing.agent";
const PURPOSE = "check.routing";

async function main() {
  const { prisma } = await import("../src/lib/prisma.js");
  const { SETTING, clearSettingsCache, setSetting } = await import("../src/lib/settings.js");
  const { runAgentLoop } = await import("../src/lib/claudeAgent.js");
  const { runTask } = await import("../src/services/agents/runner.js");
  const { forgetBudgets, setBudget } = await import("../src/services/budgets.js");

  const SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.ANTHROPIC_MODEL,
    SETTING.ANTHROPIC_MODEL_ECONOMY,
    SETTING.OPENAI_KEY,
    SETTING.OPENAI_MODEL,
    SETTING.GEMINI_KEY,
    SETTING.GEMINI_MODEL,
    SETTING.NVIDIA_KEY,
    SETTING.NVIDIA_FREE_MODELS,
    SETTING.PERPLEXITY_KEY,
    SETTING.MODEL_ROUTES,
    SETTING.MODEL_TIER_MODELS,
    SETTING.AGENT_ROUTING,
  ];
  const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY", "PERPLEXITY_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_ECONOMY"];
  const BASES = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GEMINI_BASE_URL", "NVIDIA_BASE_URL"];
  const savedRows = await prisma.appSetting.findMany({ where: { key: { in: SETTINGS } } });
  const savedEnv = Object.fromEntries([...ENV, ...BASES].map((name) => [name, process.env[name]]));

  const reset = async () => {
    await prisma.llmCall.deleteMany({ where: { OR: [{ purpose: { startsWith: PURPOSE } }, { agentKey: AGENT_KEY }] } });
    await prisma.toolCall.deleteMany({ where: { agentKey: AGENT_KEY } });
    await prisma.agentTaskStep.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
    await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
    await prisma.agentMemory.deleteMany({ where: { agentKey: AGENT_KEY } });
    await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
    await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
    await prisma.budget.deleteMany({ where: { scopeType: "AGENT", scopeId: AGENT_KEY } });
  };

  const restore = async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
    for (const row of savedRows) await prisma.appSetting.create({ data: { key: row.key, value: row.value, secret: row.secret } });
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    clearSettingsCache();
  };

  // Every vendor off, in the database and in the environment, so nothing here
  // can reach a real one on a machine with keys pasted into it. Free models off
  // for the agent loop, so each run starts on the paid floor this is about.
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
  for (const name of ENV) delete process.env[name];
  await setSetting(SETTING.NVIDIA_FREE_MODELS, JSON.stringify({ agent: [], routing: [] }));
  clearSettingsCache();

  try {
    await reset();

    console.log("\nA budget in its downgrade band holds complex at standard");
    {
      await prisma.llmCall.create({
        data: { purpose: `${PURPOSE}.budget`, model: "check", agentKey: AGENT_KEY, inputTokens: 1, outputTokens: 1, costUsd: "0.800000", durationMs: 1, ok: true },
      });
      // Through `setBudget`, which drops the thirty-second cache: the decisions
      // above have already asked, and a cached "no budgets anywhere" would make
      // this assert nothing.
      await setBudget({ scopeType: "AGENT", scopeId: AGENT_KEY, period: "MONTH", hardLimitUsd: 1 });
      const capped = await routeTask({
        agent: agentRow(),
        task: taskRow({ levelOverride: "COMPLEX" }),
        toolkit: [],
        likely: [],
        resuming: false,
        previousStatus: null,
        mode: "full",
      });
      check("even over the Owner's own call — the ceiling is theirs too", capped.level === "standard" && capped.cappedByBudget, `${capped.level}/${capped.cappedByBudget}`);
      check("and the timeline says why", (capped.sentence ?? "").includes("downgrade band"), capped.sentence ?? "");
      await prisma.budget.deleteMany({ where: { scopeType: "AGENT", scopeId: AGENT_KEY } });
      await prisma.llmCall.deleteMany({ where: { purpose: `${PURPOSE}.budget` } });
      forgetBudgets();
    }

    console.log("\nThe level reaches each vendor's wire");
    const claudeSeen: Seen[] = [];
    let claudeReply: (hit: Seen) => { status: number; payload: unknown } = claudeDone;
    process.env.ANTHROPIC_BASE_URL = await stub(claudeSeen, (hit) => claudeReply(hit));
    const openaiSeen: Seen[] = [];
    let openaiReply: (hit: Seen) => { status: number; payload: unknown } = chatgptDone;
    process.env.OPENAI_BASE_URL = await stub(openaiSeen, (hit) => openaiReply(hit));
    const geminiSeen: Seen[] = [];
    process.env.GEMINI_BASE_URL = await stub(geminiSeen, geminiDone);
    process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
    process.env.OPENAI_API_KEY = "sk-check-not-a-real-key";
    process.env.GEMINI_API_KEY = "gm-check-not-a-real-key";
    clearSettingsCache();

    const run = (level?: "simple" | "standard" | "complex", effort?: "low" | "medium" | "high") =>
      runAgentLoop({
        purpose: `${PURPOSE}.wire`,
        system: "You are a check.",
        prompt: "Say you are done.",
        tools: [],
        ...(level ? { level } : {}),
        ...(effort ? { effort } : {}),
      });

    for (const level of ["simple", "complex"] as const) {
      claudeSeen.length = 0;
      await run(level);
      const body = claudeSeen[0]?.body ?? {};
      check(`a ${level} task reaches Claude on ${TIER_MODELS.anthropic[level]}`, body.model === TIER_MODELS.anthropic[level], String(body.model));
      check(`with ${effortForLevel(level)} effort`, body.output_config?.effort === effortForLevel(level), JSON.stringify(body.output_config));
    }

    claudeReply = claudeRefuses;
    openaiSeen.length = 0;
    await run("simple");
    check("with Claude refusing, ChatGPT gets its own small model", openaiSeen[0]?.body.model === TIER_MODELS.openai.simple, String(openaiSeen[0]?.body.model));
    check("and the effort to match", openaiSeen[0]?.body.reasoning_effort === "low", String(openaiSeen[0]?.body.reasoning_effort));

    openaiReply = () => ({ status: 500, payload: "internal error" });
    geminiSeen.length = 0;
    await run("complex");
    check(
      "with both refusing, Gemini gets its flagship",
      geminiSeen[0]?.url.includes(`/models/${encodeURIComponent(TIER_MODELS.gemini.complex)}:generateContent`) === true,
      geminiSeen[0]?.url ?? "(not asked)",
    );

    claudeReply = claudeDone;
    openaiReply = chatgptDone;
    claudeSeen.length = 0;
    await run(undefined, "high");
    check("a run nobody sized keeps the old answer", claudeSeen[0]?.body.model === "claude-opus-5", String(claudeSeen[0]?.body.model));

    await setSetting(SETTING.MODEL_TIER_MODELS, JSON.stringify({ anthropic: { simple: "claude-sonnet-5", complex: "claude-made-up-9" } }));
    clearSettingsCache();
    claudeSeen.length = 0;
    await run("simple");
    check("the Owner's own model for a level reaches the wire", claudeSeen[0]?.body.model === "claude-sonnet-5", String(claudeSeen[0]?.body.model));
    claudeSeen.length = 0;
    await run("complex");
    check("an unpriced one is ignored rather than billed at a guess", claudeSeen[0]?.body.model === TIER_MODELS.anthropic.complex, String(claudeSeen[0]?.body.model));
    await prisma.appSetting.deleteMany({ where: { key: SETTING.MODEL_TIER_MODELS } });

    await setSetting(SETTING.ANTHROPIC_MODEL, "claude-opus-4-8");
    clearSettingsCache();
    claudeSeen.length = 0;
    await run("complex");
    check("a Claude model the Owner set before levels existed is still honoured", claudeSeen[0]?.body.model === "claude-opus-4-8", String(claudeSeen[0]?.body.model));
    await prisma.appSetting.deleteMany({ where: { key: SETTING.ANTHROPIC_MODEL } });
    clearSettingsCache();

    // Easing off between turns moves the level, not just the effort word.
    claudeSeen.length = 0;
    claudeReply = (hit) =>
      claudeSeen.length === 1
        ? {
            status: 200,
            payload: {
              id: "msg_tool",
              type: "message",
              role: "assistant",
              model: hit.body.model,
              content: [{ type: "tool_use", id: "toolu_check", name: "look_up", input: { what: "x" } }],
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            },
          }
        : claudeDone(hit);
    let asked = 0;
    await runAgentLoop({
      purpose: `${PURPOSE}.ease`,
      system: "You are a check.",
      prompt: "Look something up, then stop.",
      tools: [{ name: "look_up", description: "Looks something up.", inputSchema: { type: "object", properties: { what: { type: "string" } } }, run: async () => ({ content: "Tuesday." }) }],
      level: "complex",
      easeOff: async () => (asked++ === 0 ? null : "medium"),
    });
    check(
      "a run easing off finishes on the next level down",
      claudeSeen[0]?.body.model === TIER_MODELS.anthropic.complex && claudeSeen[1]?.body.model === TIER_MODELS.anthropic.standard,
      claudeSeen.map((hit) => hit.body.model).join(" → "),
    );
    claudeReply = claudeDone;

    console.log("\nA real task is sized, says so, and runs at that size");
    // The agent loop's own turn, picked out by the brief it opens with. A run
    // can make other model calls on the way — a writer, a consult — and the
    // first request to reach the fake is not necessarily the one being judged.
    const loopTurn = () => claudeSeen.find((hit) => JSON.stringify(hit.body.messages?.[0] ?? "").includes("TASK: Done"));
    await prisma.agent.create({
      data: {
        key: AGENT_KEY,
        name: "Routing Check",
        title: "Routing Check",
        tier: "SUB_AGENT",
        department: "TECHNOLOGY",
        status: "ACTIVE",
        mission: "Exists for one test run.",
        custom: true,
      },
    });

    const sized = await prisma.agentTask.create({ data: { agentKey: AGENT_KEY, title: "Done", brief: "Say you are done." } });
    claudeSeen.length = 0;
    const outcome = await runTask(sized.id);
    const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: sized.id } });
    const routed = await prisma.agentTaskStep.findFirst({ where: { taskId: sized.id, kind: "ROUTED" } });
    check("it finishes", outcome.status === "DONE" || outcome.status === "NEEDS_APPROVAL", outcome.status);
    check("the level is written on the task", row.level === "SIMPLE" && row.levelSource === "rules", `${row.level}/${row.levelSource}`);
    check("and said on its timeline", Boolean(routed?.message.includes("simple")), routed?.message ?? "(no ROUTED step)");
    check("and the small model did the work", loopTurn()?.body.model === TIER_MODELS.anthropic.simple, String(loopTurn()?.body.model));

    const forced = await prisma.agentTask.create({
      data: { agentKey: AGENT_KEY, title: "Done", brief: "Say you are done.", levelOverride: "COMPLEX" },
    });
    claudeSeen.length = 0;
    await runTask(forced.id);
    const forcedRow = await prisma.agentTask.findUniqueOrThrow({ where: { id: forced.id } });
    check("an override is what runs", loopTurn()?.body.model === TIER_MODELS.anthropic.complex, String(loopTurn()?.body.model));
    check("and is recorded as the Owner's", forcedRow.level === "COMPLEX" && forcedRow.levelSource === "owner", `${forcedRow.level}/${forcedRow.levelSource}`);

    await setSetting(SETTING.AGENT_ROUTING, "off");
    clearSettingsCache();
    const legacy = await prisma.agentTask.create({ data: { agentKey: AGENT_KEY, title: "Done", brief: "Say you are done." } });
    claudeSeen.length = 0;
    await runTask(legacy.id);
    const legacyRow = await prisma.agentTask.findUniqueOrThrow({ where: { id: legacy.id } });
    const legacySteps = await prisma.agentTaskStep.count({ where: { taskId: legacy.id, kind: "ROUTED" } });
    check("switched off, a task is not sized", legacyRow.level === null && legacySteps === 0, `${legacyRow.level}/${legacySteps}`);
    check("and runs where it always did", loopTurn()?.body.model === "claude-sonnet-5", String(loopTurn()?.body.model));
  } catch (err) {
    failures.push(`the run stopped: ${(err as Error).message}`);
    console.log(`\n  THREW  ${(err as Error).stack ?? (err as Error).message}`);
  } finally {
    for (const server of opened) {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    }
    await reset().catch(() => undefined);
    await restore().catch(() => undefined);
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) process.exitCode = 1;
    await prisma.$disconnect();
  }
}

void main().catch(async (err) => {
  console.error(`\n  THREW  ${(err as Error).stack ?? (err as Error).message}`);
  console.log(`\n${passed} passed, ${failures.length + 1} failed`);
  process.exitCode = 1;
  const { prisma } = await import("../src/lib/prisma.js");
  await prisma.$disconnect();
});
