/**
 * One ledger row per paid turn, written the moment the turn is priced.
 *
 * The agent loop used to write a single `LlmCall` row when a run ended, holding
 * the run's total. Three things followed from that and none of them showed on
 * any screen:
 *
 *  - **A task's own ceiling could not see the run it was meant to stop.**
 *    `shouldStop` and the 80% ease-off read the ledger between turns, and the
 *    ledger held nothing for the run in progress until the run was over — so a
 *    task with a $0.01 ceiling could spend dollars before its first check
 *    noticed a cent. The notes said "a run cannot be stopped at one number and
 *    recorded at another"; inside a run, it was.
 *  - **A process that died mid-run took every turn it had paid for with it.**
 *    A container killed after the eight-second drain, against turns of up to two
 *    minutes, never reached the one write.
 *  - **The drawer's per-turn average divided by the number of rows**, which was
 *    one per run.
 *
 * What this holds still, all against a fake Anthropic on localhost:
 *
 *  1. A three-turn run inside a run context writes three rows, each carrying the
 *     task, agent, trace and stop reason, and the rows add up to what the run
 *     reports and to what its checkpoint says.
 *  2. A run killed after its second turn leaves two rows behind (it left none).
 *  3. Failure rows: a refusal is one failed row with its own cost; a vendor
 *     error is one zero-cost marker and nothing counted twice; an empty answer
 *     with nobody to hand to is its own failed row and no marker; an
 *     interrupted run adds nothing.
 *  4. Through a real `runTask`: a task with a $0.01 ceiling stops BLOCKED after
 *     exactly one model turn; a task past four fifths of its ceiling finishes on
 *     the next level's model and says so; a ceiling of null or zero changes
 *     nothing.
 *
 * A database and a local fake. No API key and no network.
 *   npx tsx checks/agentTurnLedger.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunRequest } from "../src/lib/claudeAgent.js";

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

type Answer = { status: number; payload: unknown };

/** Every request the fake received, in order. */
const seen: Record<string, any>[] = [];
/**
 * How the fake answers the agent loop's own turns, by the loop turn's index.
 * Any other model call a run makes on the way gets a plain "Done." — those are
 * not what is being judged here, and are counted apart.
 */
let script: (turn: number, body: Record<string, any>) => Answer | Promise<Answer> = () => message("end_turn", [{ type: "text", text: "Done." }]);
/** Which requests belong to the loop being judged. */
let isLoopTurn: (body: Record<string, any>) => boolean = () => true;
let loopTurns = 0;

function message(stop: string, content: unknown[], usage: { input?: number; output?: number } = {}, model?: string): Answer {
  return {
    status: 200,
    payload: {
      id: `msg_ledger_${seen.length}`,
      type: "message",
      role: "assistant",
      model: model ?? "claude-sonnet-5",
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: usage.input ?? 1_000, output_tokens: usage.output ?? 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

const toolTurn = (turn: number, body: Record<string, any>, input?: number) =>
  message("tool_use", [{ type: "text", text: `Turn ${turn}.` }, { type: "tool_use", id: `toolu_ledger_${seen.length}`, name: "look_up", input: { what: `t${turn}` } }], { input }, body.model);
const doneTurn = (body: Record<string, any>) => message("end_turn", [{ type: "text", text: "Done." }], { input: 100, output: 10 }, body.model);

function fakeAnthropic(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", async () => {
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          body = {};
        }
        seen.push(body);
        const answer = isLoopTurn(body) ? await script(loopTurns++, body) : doneTurn(body);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.payload));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const AGENT_KEY = "check.turnLedger.agent";
const PURPOSE = "check.turnLedger";
const sum = (rows: { costUsd: unknown }[]) => rows.reduce((total, row) => total + Number(String(row.costUsd)), 0);
const close = (a: number, b: number) => Math.abs(a - b) < 0.000_01;

async function main() {
  const { prisma } = await import("../src/lib/prisma.js");
  const { SETTING, clearSettingsCache, setSetting } = await import("../src/lib/settings.js");
  const { runAgentLoop } = await import("../src/lib/claudeAgent.js");
  const { withRunContext } = await import("../src/lib/runContext.js");
  const { runTask, spendOn } = await import("../src/services/agents/runner.js");
  const { modelForLevel } = await import("../src/lib/models/registry.js");

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
    await prisma.llmCall.deleteMany({ where: { createdAt: { gte: since }, OR: [{ purpose: { startsWith: PURPOSE } }, { agentKey: AGENT_KEY }] } });
    await prisma.toolCall.deleteMany({ where: { agentKey: AGENT_KEY } });
    await prisma.agentTaskStep.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
    await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
    await prisma.agentMemory.deleteMany({ where: { agentKey: AGENT_KEY } });
    await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
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
  // alone, pointed at the fake. Free models off for the loop, so every turn is
  // a paid one and has a price to sum.
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
  for (const name of ENV) delete process.env[name];
  const fake = await fakeAnthropic();
  for (const name of BASES) process.env[name] = fake.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  await setSetting(SETTING.NVIDIA_FREE_MODELS, JSON.stringify({ agent: [], routing: [] }));
  clearSettingsCache();

  const lookUp = {
    name: "look_up",
    description: "Looks something up.",
    inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
    run: async (input: Record<string, unknown>) => ({ content: `Nothing new about ${String(input.what)}.` }),
  };
  const loop = (purpose: string, extra: Partial<AgentRunRequest> = {}) =>
    runAgentLoop({ purpose, system: "You are a check.", prompt: "Look two things up, then stop.", tools: [lookUp], effort: "medium", ...extra });
  const rowsFor = (purpose: string) => prisma.llmCall.findMany({ where: { purpose, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  const begin = (next: typeof script) => {
    seen.length = 0;
    loopTurns = 0;
    isLoopTurn = () => true;
    script = next;
  };

  try {
    await reset();

    console.log("\nEvery turn is on the ledger as it is paid for");
    {
      begin((turn, body) => (turn < 2 ? toolTurn(turn, body) : doneTurn(body)));
      const context = { taskId: `check-ledger-task-${since.getTime()}`, traceId: `check-ledger-trace-${since.getTime()}`, agentKey: AGENT_KEY };
      let saved: { costUsd: number } | null = null;
      const result = await withRunContext(context, () =>
        loop(`${PURPOSE}.three`, {
          onCheckpoint: async (state: { costUsd: number }) => {
            saved = state;
          },
        }),
      );
      const rows = await rowsFor(`${PURPOSE}.three`);
      check("the run took three turns and finished", seen.length === 3 && result.stoppedBecause === "finished", `${seen.length} / ${result.stoppedBecause}`);
      check("three turns, three rows", rows.length === 3, `${rows.length} row(s)`);
      check(
        "each carries the task, the agent and the trace",
        rows.every((row) => row.taskId === context.taskId && row.agentKey === context.agentKey && row.traceId === context.traceId),
        rows.map((row) => `${row.taskId}/${row.agentKey}/${row.traceId}`).join(" | "),
      );
      check("and the stop reason it ended on", rows.map((row) => row.stopReason).join(",") === "tool_use,tool_use,end_turn", rows.map((row) => row.stopReason).join(","));
      check("each turn's own tokens, not a running total", rows.every((row) => row.inputTokens === 1_000 || row.inputTokens === 100), rows.map((row) => row.inputTokens).join(", "));
      check("and how long that one call took", rows.every((row) => typeof row.durationMs === "number" && row.durationMs >= 0), rows.map((row) => row.durationMs).join(", "));
      check("on a priced model, so the sum means something", result.costUsd > 0, String(result.costUsd));
      check("the rows add up to what the run reports", close(sum(rows), result.costUsd), `${sum(rows)} vs ${result.costUsd}`);
      check("and to the state it hands back", close(sum(rows), result.state.costUsd), `${sum(rows)} vs ${result.state.costUsd}`);
      // A finished run writes no checkpoint for its last turn, so the last one
      // saved is the place after turn two — and has to agree with the first two
      // rows, or a resume would carry a total the ledger does not.
      const checkpointed = (saved as { costUsd: number } | null)?.costUsd ?? -1;
      check("the last checkpoint agrees with the rows it covers", close(sum(rows.slice(0, 2)), checkpointed), `${sum(rows.slice(0, 2))} vs ${checkpointed}`);
      check("every one of them a success", rows.every((row) => row.ok && row.error === null), rows.map((row) => `${row.ok}/${row.error}`).join(", "));
    }

    console.log("\nA run killed part-way leaves the turns it paid for");
    {
      // `onToolCall` throwing is the closest thing to a process dying that a
      // check can arrange: nothing after it in the loop runs, so the run never
      // reaches an ending of any kind.
      begin((turn, body) => (turn < 2 ? toolTurn(turn, body) : doneTurn(body)));
      let calls = 0;
      const died = await loop(`${PURPOSE}.killed`, {
        onToolCall: async () => {
          calls += 1;
          if (calls === 2) throw new Error("the process died here");
        },
      }).then(
        () => null,
        (err: Error) => err,
      );
      const rows = await rowsFor(`${PURPOSE}.killed`);
      check("the run did not reach an ending", died?.message === "the process died here", died?.message ?? "it finished");
      check("two turns were paid for", seen.length === 2, `${seen.length} request(s)`);
      check("and both are on the ledger", rows.length === 2 && rows.every((row) => row.ok), rows.map((row) => `${row.stopReason}/${row.ok}`).join(", "));
    }

    console.log("\nA refusal is one failed row, with what it cost");
    {
      begin((_turn, body) => message("refusal", [], { input: 700, output: 0 }, body.model));
      const result = await loop(`${PURPOSE}.refusal`);
      const rows = await rowsFor(`${PURPOSE}.refusal`);
      check("the run ended on the refusal", result.stoppedBecause === "refusal", result.stoppedBecause);
      check("and was not routed around", seen.length === 1, `${seen.length} request(s)`);
      check("it says who declined, by name", result.text.startsWith("Claude declined"), result.text);
      check(
        "one row, written as a failure, with the refusal's own cost",
        rows.length === 1 && !rows[0].ok && rows[0].error === "refusal" && rows[0].stopReason === "refusal" && Number(String(rows[0].costUsd)) > 0,
        rows.map((row) => `ok=${row.ok} ${row.error} ${row.stopReason} $${row.costUsd}`).join(" | "),
      );
      check("which is what the run reports", close(sum(rows), result.costUsd), `${sum(rows)} vs ${result.costUsd}`);
    }

    console.log("\nA vendor error is one zero-cost marker, and nothing counted twice");
    {
      begin((turn, body) =>
        turn === 0
          ? toolTurn(turn, body)
          : { status: 400, payload: { type: "error", error: { type: "invalid_request_error", message: "messages.1: this request is malformed" } } },
      );
      const thrown = await loop(`${PURPOSE}.error`).then(
        () => null,
        (err: Error) => err,
      );
      const rows = await rowsFor(`${PURPOSE}.error`);
      check("the run threw", thrown !== null, "it returned");
      check("two rows: the paid turn, then the marker", rows.length === 2, `${rows.length} row(s)`);
      const [paid, marker] = rows;
      check("the paid turn is a success at its own price", Boolean(paid?.ok) && Number(String(paid?.costUsd)) > 0, `ok=${paid?.ok} $${paid?.costUsd}`);
      check(
        "the marker is a failure that cost nothing and used nothing",
        marker !== undefined && !marker.ok && Number(String(marker.costUsd)) === 0 && marker.inputTokens === 0 && marker.outputTokens === 0,
        `ok=${marker?.ok} $${marker?.costUsd} in=${marker?.inputTokens}`,
      );
      check("and carries the error the run ended on", Boolean(marker?.error) && thrown !== null && marker!.error === thrown.message, `${marker?.error} | ${thrown?.message}`);
      check("so the sum is the one turn that was paid for", close(sum(rows), Number(String(paid?.costUsd))), String(sum(rows)));
    }

    console.log("\nAn empty answer with nobody to hand to is its own failure, with no marker");
    {
      begin((_turn, body) => message("end_turn", [], { input: 300, output: 0 }, body.model));
      const thrown = await loop(`${PURPOSE}.empty`).then(
        () => null,
        (err: Error) => err,
      );
      const rows = await rowsFor(`${PURPOSE}.empty`);
      check("the run threw rather than reporting success", thrown !== null, "it returned");
      check(
        "one row, the turn itself, failed at its own price",
        rows.length === 1 && !rows[0].ok && Number(String(rows[0].costUsd)) > 0 && (rows[0].error ?? "").includes("answered with nothing"),
        rows.map((row) => `ok=${row.ok} $${row.costUsd} ${row.error}`).join(" | "),
      );
    }

    console.log("\nAn interrupted run adds nothing");
    {
      begin((turn, body) => (turn < 2 ? toolTurn(turn, body) : doneTurn(body)));
      const result = await loop(`${PURPOSE}.interrupted`, { shouldStop: () => seen.length >= 1 });
      const rows = await rowsFor(`${PURPOSE}.interrupted`);
      check("it stopped where it was asked to", result.stoppedBecause === "interrupted" && seen.length === 1, `${result.stoppedBecause} after ${seen.length}`);
      check("one turn paid for, one row, and no ending row", rows.length === 1 && rows[0].ok && rows[0].stopReason === "tool_use", rows.map((row) => `${row.stopReason}/${row.ok}`).join(", "));
    }

    // --- Through the runner ----------------------------------------------------

    await prisma.agent.create({
      data: {
        key: AGENT_KEY,
        name: "Ledger Check",
        title: "Ledger Check",
        tier: "SUB_AGENT",
        department: "TECHNOLOGY",
        status: "ACTIVE",
        mission: "Exists for one test run.",
        custom: true,
      },
    });
    const complexModel = await modelForLevel("anthropic", "complex");
    const standardModel = await modelForLevel("anthropic", "standard");

    /**
     * A task sized complex by hand — so no model is asked to size it — whose
     * first turn reports `input` tokens and asks for a tool, and whose second
     * says it is done.
     */
    async function runWith(title: string, budgetUsd: string | null, input: number, onSecondTurn?: (taskId: string) => Promise<void>) {
      const task = await prisma.agentTask.create({
        data: { agentKey: AGENT_KEY, title, brief: "Look one thing up, then stop.", levelOverride: "COMPLEX", budgetUsd },
      });
      begin(async (turn, body) => {
        if (turn === 0) return toolTurn(turn, body, input);
        if (turn === 1) await onSecondTurn?.(task.id);
        return doneTurn(body);
      });
      // The loop's own turns, picked out by the brief they open with. A run
      // can make other model calls on the way, and those are not what is being
      // counted.
      isLoopTurn = (body) => Array.isArray(body.tools) && body.tools.length > 0 && JSON.stringify(body.messages?.[0] ?? "").includes(`TASK: ${title}`);
      const outcome = await runTask(task.id);
      const loopBodies = seen.filter((body) => isLoopTurn(body));
      const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
      const serving = await prisma.agentTaskStep.findMany({ where: { taskId: task.id, kind: "SERVING" }, orderBy: { createdAt: "asc" } });
      return { task, outcome, row, loopBodies, serving };
    }

    console.log("\nWith no ceiling, a costly first turn changes nothing");
    let costOfAMillion = 0;
    {
      const free = await runWith("Ledger no ceiling", null, 1_000_000);
      check("it finishes", free.outcome.status === "DONE" || free.outcome.status === "NEEDS_APPROVAL", free.outcome.status);
      check("in two turns", free.loopBodies.length === 2, `${free.loopBodies.length} loop turn(s) of ${seen.length} request(s)`);
      check("both on the complex model", free.loopBodies.every((body) => body.model === complexModel), free.loopBodies.map((body) => body.model).join(" → "));
      check("and nothing eased off", !free.serving.some((step) => step.message.includes("Carrying on")), free.serving.map((step) => step.message).join(" | "));
      const first = await prisma.llmCall.findFirst({ where: { taskId: free.task.id, inputTokens: 1_000_000 } });
      costOfAMillion = Number(String(first?.costUsd ?? 0));
      check("a million input tokens is real money on that model", costOfAMillion > 0.01, `$${costOfAMillion}`);
    }

    console.log("\nA ceiling of zero is no ceiling");
    {
      const zero = await runWith("Ledger zero ceiling", "0", 1_000_000);
      check("it finishes", zero.outcome.status === "DONE" || zero.outcome.status === "NEEDS_APPROVAL", zero.outcome.status);
      check("in two turns, on the model it started on", zero.loopBodies.length === 2 && zero.loopBodies.every((body) => body.model === complexModel), zero.loopBodies.map((body) => body.model).join(" → "));
    }

    console.log("\nA run past its ceiling stops before its second turn");
    {
      const capped = await runWith("Ledger ceiling", "0.01", 1_000_000);
      check("it ends BLOCKED", capped.outcome.status === "BLOCKED" && capped.row.status === "BLOCKED", `${capped.outcome.status} / ${capped.row.status}`);
      check("on the ceiling sentence", (capped.row.blockedReason ?? "").includes("ceiling set on it"), capped.row.blockedReason ?? "(none)");
      check("after exactly one model turn", capped.loopBodies.length === 1, `${capped.loopBodies.length} loop turn(s) of ${seen.length} request(s)`);
      check("and the task's cost is that turn", close(Number(String(capped.row.costUsd)), await spendOn(capped.task.id)) && Number(String(capped.row.costUsd)) >= 0.01, `$${capped.row.costUsd}`);
    }

    console.log("\nA run past four fifths of its ceiling finishes on the next level down");
    {
      // Sized so the first turn alone is nine tenths of a one-dollar ceiling,
      // from the price the ledger itself put on a million tokens above.
      const input = Math.round((0.9 * 1_000_000) / costOfAMillion);
      let spentBeforeTurnTwo = -1;
      const eased = await runWith("Ledger ease off", "1.00", input, async (taskId) => {
        spentBeforeTurnTwo = await spendOn(taskId);
      });
      check("the first turn put it between four fifths and the whole", spentBeforeTurnTwo >= 0.8 && spentBeforeTurnTwo < 1, `$${spentBeforeTurnTwo}`);
      check("it finishes rather than stopping", eased.outcome.status === "DONE" || eased.outcome.status === "NEEDS_APPROVAL", eased.outcome.status);
      check(
        "the first turn on the complex model, the second on the standard one",
        eased.loopBodies.length === 2 && eased.loopBodies[0].model === complexModel && eased.loopBodies[1].model === standardModel,
        eased.loopBodies.map((body) => body.model).join(" → "),
      );
      check(
        "and it says so on the timeline",
        eased.serving.some((step) => step.message.startsWith("Carrying on as a standard task rather than complex")),
        eased.serving.map((step) => step.message).join(" | "),
      );
    }
  } catch (err) {
    failures.push(`the run stopped: ${(err as Error).message}`);
    console.log(`\n  THREW  ${(err as Error).stack ?? (err as Error).message}`);
  } finally {
    fake.server.close();
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
