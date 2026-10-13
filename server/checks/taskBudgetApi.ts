/**
 * A task's own spending ceiling, set from the app rather than from psql.
 *
 * `AgentTask.budgetUsd` has been the task's own ceiling since the runner learnt
 * to stop at it — `shouldStop` reads it between turns and `easeOff` reads it a
 * step earlier — and nothing anywhere wrote it. The only way to give a task a
 * ceiling was to edit the database, and the runner's own sentence for a task
 * that hit one ("raise the ceiling and carry on") named a control that did not
 * exist. This holds the route that writes it, end to end:
 *
 *  1. `POST /agents/:key/tasks` stores a ceiling it is given, refuses one that
 *     is negative or past $100, and stores 0 and null alike as **no ceiling**
 *     — the schema's call for this column, which is the opposite of a
 *     `Budget`, where 0 stops everything. A task given no ceiling is exactly
 *     what it was before.
 *  2. `POST /agents/tasks/:id/budget` changes it afterwards, under the same
 *     rules, so a task stopped at its ceiling can be raised and carried on.
 *  3. **The runner reads what the route stored.** Through a real `runTask`
 *     against a fake Anthropic on localhost: a $0.01 ceiling set over HTTP
 *     stops the run BLOCKED after one turn; raised over HTTP, the same task
 *     carries on and finishes; 0 and null set over HTTP change nothing. The
 *     first is what makes the last two mean something — a fake that never
 *     charged would pass them too.
 *  4. The task drawer's spend block carries the cache reads and writes, and
 *     the cost of the whole tree the task delegated — the task and everything
 *     under it, never an unrelated task, and a `parentId` loop answers rather
 *     than hanging the request.
 *
 * Mounted on port 0, the way `index.ts` mounts the router. A database and a
 * local fake; no API key and no network.
 *   npx tsx checks/taskBudgetApi.ts
 */
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/lib/prisma.js";
import { ensureSystemRoles } from "../src/lib/accessRoles.js";
import { SETTING, clearSettingsCache, setSetting } from "../src/lib/settings.js";
import { attachUser, requireAuth } from "../src/middleware/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { agentsRouter } from "../src/routes/agents.js";
import { runTask } from "../src/services/agents/runner.js";

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

const AGENT_KEY = "check.taskBudget.agent";
const near = (a: number, b: number) => Math.abs(a - b) < 0.000_01;

// --- A fake Anthropic --------------------------------------------------------

type Answer = { status: number; payload: unknown };
/** Every request the fake received since the last `begin`. */
const seen: Record<string, any>[] = [];
let isLoopTurn: (body: Record<string, any>) => boolean = () => true;
let script: (turn: number, body: Record<string, any>) => Answer = () => done({});
let loopTurns = 0;

function message(stop: string, content: unknown[], input: number, model: string): Answer {
  return {
    status: 200,
    payload: {
      id: `msg_budget_${seen.length}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: input, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}
/** A turn that asks for a tool and reports a million tokens in — real money on any Claude model. */
const costlyToolTurn = (body: Record<string, any>) =>
  message("tool_use", [{ type: "text", text: "Looking." }, { type: "tool_use", id: `toolu_budget_${seen.length}`, name: "look_up", input: { what: "x" } }], 1_000_000, body.model);
const done = (body: Record<string, any>) => message("end_turn", [{ type: "text", text: "Done." }], 100, body.model ?? "claude-sonnet-5-5");

function fakeAnthropic(): Promise<{ server: Server; url: string }> {
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
        seen.push(body);
        const answer = isLoopTurn(body) ? script(loopTurns++, body) : done(body);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.payload));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

async function main() {
  // Every row this file reads or deletes was written after this, and is its own.
  const since = new Date();

  const SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.ANTHROPIC_MODEL,
    SETTING.ANTHROPIC_MODEL_ECONOMY,
    SETTING.OPENAI_KEY,
    SETTING.GEMINI_KEY,
    SETTING.NVIDIA_KEY,
    SETTING.NVIDIA_FREE_MODELS,
    SETTING.PERPLEXITY_KEY,
    SETTING.MODEL_ROUTES,
    SETTING.MODEL_TIER_MODELS,
  ];
  const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY", "PERPLEXITY_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_ECONOMY"];
  const BASES = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GEMINI_BASE_URL", "NVIDIA_BASE_URL", "PERPLEXITY_BASE_URL"];
  const savedRows = await prisma.appSetting.findMany({ where: { key: { in: SETTINGS } } });
  const savedEnv = Object.fromEntries([...ENV, ...BASES].map((name) => [name, process.env[name]]));

  const reset = async () => {
    const tasks = await prisma.agentTask.findMany({ where: { agentKey: AGENT_KEY }, select: { id: true } });
    const ids = tasks.map((task) => task.id);
    await prisma.llmCall.deleteMany({ where: { createdAt: { gte: since }, OR: [{ agentKey: AGENT_KEY }, { taskId: { in: ids } }] } });
    await prisma.toolCall.deleteMany({ where: { OR: [{ agentKey: AGENT_KEY }, { taskId: { in: ids } }] } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentMemory.deleteMany({ where: { agentKey: AGENT_KEY } });
    // A delegation loop has to be untied before its rows can go.
    await prisma.agentTask.updateMany({ where: { id: { in: ids } }, data: { parentId: null } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
    await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
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
  // can reach a real one on a machine with keys pasted into it — then Claude
  // alone, pointed at the fake. Free models off, so every turn is a paid one.
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
  for (const name of ENV) delete process.env[name];
  const fake = await fakeAnthropic();
  for (const name of BASES) process.env[name] = fake.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  await setSetting(SETTING.NVIDIA_FREE_MODELS, JSON.stringify({ agent: [], routing: [] }));
  clearSettingsCache();

  // The dev Owner `DEV_NO_AUTH` signs in as is pinned to the Owner role, and a
  // fresh database has none until the server's boot seeds them.
  await ensureSystemRoles();

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use("/api", requireAuth);
  app.use("/api/agents", agentsRouter);
  app.use(errorHandler);
  const api = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => api.once("listening", resolve));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/agents`;

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const give = (title: string, extra: Record<string, unknown> = {}) =>
    post(`/${AGENT_KEY}/tasks`, { title, brief: "Look one thing up, then stop.", level: "complex", ...extra });
  const stored = (id: string) => prisma.agentTask.findUniqueOrThrow({ where: { id } });

  try {
    await reset();
    await prisma.agent.create({
      data: {
        key: AGENT_KEY,
        name: "Budget Check",
        title: "Budget Check",
        tier: "SUB_AGENT",
        department: "TECHNOLOGY",
        status: "ACTIVE",
        mission: "Exists for one test run.",
        custom: true,
      },
    });

    console.log("\nA ceiling set when the task is given");
    let capped = "";
    {
      const res = await give("Budget half a dollar", { budgetUsd: 0.5 });
      check("the task is created", res.status === 201, `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      const id = String(res.body.task?.id ?? "");
      const row = id ? await stored(id) : null;
      check("the ceiling is stored as 0.50", row?.budgetUsd?.toFixed(2) === "0.50", `${row?.budgetUsd}`);
      check("and the summary returns it", res.body.task?.budgetUsd === 0.5, `${res.body.task?.budgetUsd}`);

      const before = await prisma.agentTask.count({ where: { agentKey: AGENT_KEY } });
      const negative = await give("Budget negative", { budgetUsd: -1 });
      check("a negative ceiling is a 400", negative.status === 400, `${negative.status}`);
      const tooHigh = await give("Budget too high", { budgetUsd: 100.01 });
      check("so is one past $100", tooHigh.status === 400, `${tooHigh.status}`);
      const words = await give("Budget in words", { budgetUsd: "a lot" });
      check("and one that is not a number", words.status === 400, `${words.status}`);
      check("and none of the three created anything", (await prisma.agentTask.count({ where: { agentKey: AGENT_KEY } })) === before);

      // Zero on a task is no ceiling, by the schema's own comment — the
      // reverse of a Budget, where zero stops everything. Both are stored the
      // one way, so no reader has to know there are two spellings of "none".
      for (const [label, value] of [["zero", 0], ["null", null]] as const) {
        const given = await give(`Budget ${label}`, { budgetUsd: value });
        const row = given.body.task?.id ? await stored(String(given.body.task.id)) : null;
        check(`a ceiling of ${label} is accepted`, given.status === 201, `${given.status}`);
        check(`and stored as no ceiling at all`, row !== null && row.budgetUsd === null, `${row?.budgetUsd}`);
        check(`and summarised as none`, given.body.task?.budgetUsd === null, `${given.body.task?.budgetUsd}`);
      }

      // The commonest call of all: no ceiling mentioned. Nothing about it moves.
      const plain = await give("Budget never mentioned");
      const plainRow = plain.body.task?.id ? await stored(String(plain.body.task.id)) : null;
      check(
        "a task given no ceiling is created as before",
        plain.status === 201 && plainRow?.budgetUsd === null && plainRow?.priority === 2 && plainRow?.status === "QUEUED",
        `${plain.status} ${plainRow?.budgetUsd} ${plainRow?.priority} ${plainRow?.status}`,
      );
      capped = id;
    }

    console.log("\nChanging it afterwards");
    {
      const raised = await post(`/tasks/${capped}/budget`, { budgetUsd: 2 });
      check("a ceiling can be raised", raised.status === 200 && (await stored(capped)).budgetUsd?.toFixed(2) === "2.00", `${raised.status} ${(await stored(capped)).budgetUsd}`);
      check("and the reply says what it is now", raised.body.task?.budgetUsd === 2, JSON.stringify(raised.body).slice(0, 160));
      const refused = await post(`/tasks/${capped}/budget`, { budgetUsd: -0.01 });
      check("a negative one is still a 400", refused.status === 400 && (await stored(capped)).budgetUsd?.toFixed(2) === "2.00", `${refused.status}`);
      const cleared = await post(`/tasks/${capped}/budget`, { budgetUsd: 0 });
      check("zero clears it", cleared.status === 200 && (await stored(capped)).budgetUsd === null, `${cleared.status} ${(await stored(capped)).budgetUsd}`);
      const missing = await post(`/tasks/no-such-task/budget`, { budgetUsd: 1 });
      check("an unknown task is a 404", missing.status === 404, `${missing.status}`);
    }

    console.log("\nThe runner reads what the route stored");
    {
      /** Creates the task over HTTP, then runs it against the fake: a costly first turn, then done. */
      const runVia = async (title: string, budgetUsd: number | null) => {
        const res = await give(title, { budgetUsd });
        const id = String(res.body.task?.id ?? "");
        return { id, ...(await runAgain(id, title)) };
      };
      const runAgain = async (id: string, title: string, resuming = false) => {
        seen.length = 0;
        loopTurns = 0;
        // A fresh run opens on the costly turn; a resumed one has had it, and
        // the fake answers its next turn as finished.
        script = (turn, body) => (turn === 0 && !resuming ? costlyToolTurn(body) : done(body));
        // The loop's own turns, picked out by the brief they open with. A run can
        // make other model calls on the way, and those are not being counted.
        isLoopTurn = (body) => Array.isArray(body.tools) && body.tools.length > 0 && JSON.stringify(body.messages ?? "").includes(`TASK: ${title}`);
        const outcome = await runTask(id);
        const loop = seen.filter((body) => isLoopTurn(body));
        return { outcome, turns: loop.length, first: loop[0], row: await stored(id) };
      };
      const finished = (status: string) => status === "DONE" || status === "NEEDS_APPROVAL";

      // The control. If this one does not stop, the fake is not charging and the
      // two below would pass for the wrong reason.
      const stopped = await runVia("Budget one cent", 0.01);
      check("a one-cent ceiling set over HTTP stops the run BLOCKED", stopped.outcome.status === "BLOCKED" && stopped.row.status === "BLOCKED", `${stopped.outcome.status} / ${stopped.row.status}`);
      check("after exactly one model turn", stopped.turns === 1, `${stopped.turns} loop turn(s)`);
      check("on the ceiling's own sentence", (stopped.row.blockedReason ?? "").includes("ceiling set on it"), stopped.row.blockedReason ?? "(none)");

      // What the sentence tells the Owner to do, done over HTTP.
      const raise = await post(`/tasks/${stopped.id}/budget`, { budgetUsd: 100 });
      check("raised over HTTP", raise.status === 200, `${raise.status}`);
      const resumed = await runAgain(stopped.id, "Budget one cent", true);
      check("the same task carries on and finishes", finished(resumed.outcome.status), resumed.outcome.status);
      check("in one more turn", resumed.turns === 1, `${resumed.turns} loop turn(s)`);
      check(
        "from where it stopped — the costly turn is already in the conversation it sends",
        JSON.stringify(resumed.first?.messages ?? "").includes("toolu_budget_"),
      );

      for (const [label, value] of [["zero", 0], ["null", null]] as const) {
        const free = await runVia(`Budget run ${label}`, value);
        check(`a ceiling of ${label} set over HTTP does not stop a costly run`, finished(free.outcome.status), free.outcome.status);
        check(`it takes both its turns`, free.turns === 2, `${free.turns} loop turn(s)`);
      }
    }

    console.log("\nThe task drawer's spend, and the tree under it");
    {
      const make = (title: string, parentId: string | null = null) =>
        prisma.agentTask.create({ data: { agentKey: AGENT_KEY, title, brief: "Seeded.", status: "DONE", parentId, origin: parentId ? "AGENT" : "OWNER" } });
      const parent = await make("Tree parent");
      const child = await make("Tree child", parent.id);
      const grandchild = await make("Tree grandchild", child.id);
      const unrelated = await make("Tree unrelated");
      const ledger = (taskId: string, costUsd: string, read = 0, written = 0) => ({
        purpose: "check.taskBudget", model: "claude-sonnet-5-5", taskId, agentKey: AGENT_KEY,
        inputTokens: 100, outputTokens: 10, cacheReadTokens: read, cacheCreationTokens: written, costUsd, durationMs: 1, ok: true,
      });
      await prisma.llmCall.createMany({
        data: [
          ledger(parent.id, "0.100000", 400, 100),
          ledger(parent.id, "0.050000", 200, 0),
          ledger(child.id, "0.200000"),
          ledger(grandchild.id, "0.300000"),
          ledger(unrelated.id, "0.400000"),
        ],
      });
      // A screenshot or an Apify run is money against a ceiling exactly as a
      // model turn is, so the tree counts it too.
      await prisma.toolCall.create({ data: { tool: "check.taskBudget.tool", agentKey: AGENT_KEY, taskId: grandchild.id, ok: true, dryRun: false, costUsd: "0.050000" } });

      const detail = async (id: string) => {
        const res = await fetch(`${base}/tasks/${id}`, { signal: AbortSignal.timeout(15_000) });
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };
      const view = await detail(parent.id);
      check("the spend block carries the cache reads", view.body.spend?.cacheReadTokens === 600, `${view.body.spend?.cacheReadTokens}`);
      check("and the cache writes", view.body.spend?.cacheCreationTokens === 100, `${view.body.spend?.cacheCreationTokens}`);
      check(
        "the tree's cost is the task, its child and its grandchild, tools included",
        typeof view.body.treeCostUsd === "number" && near(view.body.treeCostUsd, 0.15 + 0.2 + 0.3 + 0.05),
        `${view.body.treeCostUsd}`,
      );
      check("and says how many tasks that is", view.body.treeTasks === 3, `${view.body.treeTasks}`);
      const fromChild = await detail(child.id);
      check("a subtree counts only what is under it", near(fromChild.body.treeCostUsd ?? -1, 0.55), `${fromChild.body.treeCostUsd}`);
      const alone = await detail(unrelated.id);
      check("a task that delegated nothing is its own cost", near(alone.body.treeCostUsd ?? -1, 0.4) && alone.body.treeTasks === 1, `${alone.body.treeCostUsd} over ${alone.body.treeTasks}`);

      // Two tasks that each name the other as parent. Nothing writes that
      // today; a walk with no memory of where it has been would never return.
      const first = await make("Loop first");
      const second = await make("Loop second", first.id);
      await prisma.agentTask.update({ where: { id: first.id }, data: { parentId: second.id } });
      await prisma.llmCall.createMany({ data: [ledger(first.id, "0.010000"), ledger(second.id, "0.020000")] });
      const loop = await detail(first.id).catch((err: Error) => ({ status: 0, body: { error: err.message } as Record<string, any> }));
      check("a parent loop answers", loop.status === 200, `${loop.status} ${loop.body.error ?? ""}`);
      check("counting each task once", near(loop.body.treeCostUsd ?? -1, 0.03) && loop.body.treeTasks === 2, `${loop.body.treeCostUsd} over ${loop.body.treeTasks}`);
    }
  } catch (err) {
    failures.push(`the run stopped: ${(err as Error).message}`);
    console.log(`\n  THREW  ${(err as Error).stack ?? (err as Error).message}`);
  } finally {
    api.close();
    fake.server.close();
    await reset().catch((err) => console.log(`  cleanup failed: ${(err as Error).message}`));
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
  await prisma.$disconnect();
});
