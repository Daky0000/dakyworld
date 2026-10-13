/**
 * How does a run end when the model did not finish?
 *
 * The loop reports three endings without throwing — the model declined, the
 * reply ran out of room, every turn was used — and all three used to fall
 * through to the summary and finish DONE: the last thing the model said read
 * as the account of a job it had not done, the checkpoint went with it, and
 * the autonomy evidence counted each one as a success. This file holds each of
 * them to an honest ending, and holds the endings that were already right
 * exactly where they were.
 *
 * What it asserts, against the real runner and the real loop, with a local
 * Anthropic stub and a local ChatGPT stub standing in for two paid vendors:
 *
 *   - **Truncated is FAILED**, its conversation kept, nothing FINISHED, and one
 *     request made. **Refused is BLOCKED**, naming the model and saying it was
 *     not retried — and the second vendor is never asked, because a content
 *     refusal is never routed around.
 *   - **Out of turns is BLOCKED**, at exactly sixteen requests, with the place
 *     kept and marked; "Carry on" buys eight more, once, and says so on the
 *     timeline; the next time the cap is reached it blocks again.
 *   - **The negatives**: a run that finishes is still DONE with its checkpoint
 *     gone, an escalation is still BLOCKED on the agent's own words, prepared
 *     work is still NEEDS_APPROVAL, and the cap with prepared work behind it
 *     names that work on the card.
 *   - **A child's ending is noted once on a parent that is not running**, and
 *     never on one that is.
 *   - **The retry ladder, on the wire**: the first retry after a failure keeps
 *     the model and sends a higher effort, is told why in exactly one text
 *     block after the tool results, and a pause halfway through it comes back
 *     on the same rung without being told twice; the second failure in a row
 *     moves the model up. **Except after a truncation**: a reply that ran out
 *     of room comes back on the same model at the same effort, because
 *     thinking is counted inside the same fixed reply budget.
 *
 * A database and nothing else. No API key, no network — both vendors are
 * local stubs on ports the OS picks.
 *   npx tsx checks/agentRunEndings.ts
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/lib/prisma.js";
import { clearSettingsCache } from "../src/lib/settings.js";
import { CAP_GRANT_TURNS, failureClassOf, runTask } from "../src/services/agents/runner.js";
import { transition } from "../src/services/agents/state.js";
import { recordOwnerAnswer } from "../src/services/agents/escalations.js";
import { MAX_ITERATIONS } from "../src/lib/claudeAgent.js";

const AGENT_KEY = "tmp.runendings";
const BOSS_KEY = "tmp.runendings.boss";
const STUB_MODEL = "claude-opus-5";

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

// --- The two vendors ---------------------------------------------------------

interface Seen {
  model: string;
  effort: string | null;
  messages: { role: string; content: unknown }[];
}

type Reply = { status?: number; headers?: Record<string, string>; body: unknown };
type Script = (turn: number, seen: Seen) => Reply;

const anthropicSeen: Seen[] = [];
let openaiRequests = 0;
let script: Script = () => say([{ type: "text", text: "Nothing scripted." }], "end_turn");

function say(content: unknown[], stop: string): Reply {
  return {
    body: {
      id: `msg_${anthropicSeen.length}`,
      type: "message",
      role: "assistant",
      model: STUB_MODEL,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 400, output_tokens: 60 },
    },
  };
}

/** A `remember` call, which every agent has and which needs nothing to exist. */
function rememberTurn(turn: number): Reply {
  return say(
    [
      { type: "text", text: `Still working through it, turn ${turn}.` },
      { type: "tool_use", id: `call_${turn}_${Date.now()}`, name: "remember", input: { kind: "LESSON", content: `Turn ${turn}: still looking into it.`, about: "myself" } },
    ],
    "tool_use",
  );
}

function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const reply = (r: Reply) => {
        res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.body));
      };
      if (req.method === "GET" && url.includes("/v1/models/")) return reply({ body: { id: url.split("/").pop(), display_name: "Stub" } });
      if (url.includes("/chat/completions")) {
        // The second vendor. Answers cleanly, so a handover would finish the
        // task DONE — which is exactly what must never happen after a refusal.
        openaiRequests += 1;
        return reply({
          body: {
            id: "chat_1",
            model: "gpt-stub",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done it another way." } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        });
      }
      if (!url.includes("/v1/messages")) return reply({ status: 404, body: { error: { message: `no stub route for ${url}` } } });
      const body = JSON.parse(raw || "{}") as { model?: string; output_config?: { effort?: string }; messages?: Seen["messages"] };
      const seen: Seen = { model: String(body.model ?? ""), effort: body.output_config?.effort ?? null, messages: body.messages ?? [] };
      anthropicSeen.push(seen);
      return reply(script(anthropicSeen.length, seen));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// --- Rows --------------------------------------------------------------------

async function reset() {
  const tasks = await prisma.agentTask.findMany({ where: { agentKey: { in: [AGENT_KEY, BOSS_KEY] } }, select: { id: true } });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.actionRequest.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.llmCall.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.toolCall.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentMemory.deleteMany({ where: { sourceTaskId: { in: ids } } });
    // Children first: a task's parent is a foreign key.
    await prisma.agentTask.deleteMany({ where: { id: { in: ids }, parentId: { not: null } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.actionRequest.deleteMany({ where: { agentKey: { in: [AGENT_KEY, BOSS_KEY] } } });
  await prisma.llmCall.deleteMany({ where: { agentKey: { in: [AGENT_KEY, BOSS_KEY] } } });
  await prisma.llmCall.deleteMany({ where: { purpose: `agent.${AGENT_KEY}` } });
  await prisma.toolCall.deleteMany({ where: { agentKey: { in: [AGENT_KEY, BOSS_KEY] } } });
  await prisma.agentMemory.deleteMany({ where: { OR: [{ agentKey: { in: [AGENT_KEY, BOSS_KEY] } }, { authorKey: { in: [AGENT_KEY, BOSS_KEY] } }] } });
  await prisma.agent.deleteMany({ where: { key: { in: [AGENT_KEY, BOSS_KEY] } } });
}

async function makeTask(title: string, extra: { parentId?: string } = {}) {
  return prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title, brief: "Look into the account and say what you found.", origin: "OWNER", ...extra },
  });
}

async function run(title: string, scripted: Script, extra: { parentId?: string } = {}) {
  const task = await makeTask(title, extra);
  anthropicSeen.length = 0;
  openaiRequests = 0;
  script = scripted;
  const outcome = await runTask(task.id);
  const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  return { task, outcome, row, requests: anthropicSeen.length };
}

const lastTransition = (taskId: string) =>
  prisma.agentTaskTransition.findFirst({ where: { taskId }, orderBy: [{ at: "desc" }, { id: "desc" }] });

/** Re-files the newest FAILED under `tool-error`, a class the ladder climbs for. */
async function asModelFault(taskId: string) {
  const failed = await prisma.agentTaskTransition.findFirst({ where: { taskId, to: "FAILED" }, orderBy: [{ at: "desc" }, { id: "desc" }] });
  if (failed) await prisma.agentTaskTransition.update({ where: { id: failed.id }, data: { reason: failed.reason.replace(/^\[[a-z-]+\]/, "[tool-error]") } });
}

async function requeue(taskId: string, from: "FAILED" | "BLOCKED" | "DONE") {
  await transition(taskId, { to: "QUEUED", reason: "Run again by the check.", actor: "owner", expect: [from] });
}

/** Roles strictly alternate, starting with the user. */
function alternates(messages: { role: string }[]): boolean {
  return messages.every((message, at) => message.role === (at % 2 === 0 ? "user" : "assistant"));
}

const TRACE = "Your last run on this task ended FAILED";

function traceBlocks(messages: { role: string; content: unknown }[]): number {
  let found = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.content.includes(TRACE)) found += 1;
      continue;
    }
    for (const block of message.content as { type?: string; text?: string }[]) {
      if (block.type === "text" && (block.text ?? "").includes(TRACE)) found += 1;
    }
  }
  return found;
}

async function main() {
  const server = await startStub();
  const port = (server.address() as AddressInfo).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.OPENAI_API_KEY = "stub";
  // No free vendor, so the chain is the two paid stubs and nothing else.
  delete process.env.NVIDIA_API_KEY;
  clearSettingsCache();

  await reset();
  await prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Endings Harness",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      autonomyLevel: 1,
      // On, so the one write tool it holds is prepared rather than done.
      dryRun: true,
      mission: "Look into things and say what was found.",
      toolkit: ["tasks.write"],
      prompt: {
        role: "You are a harness.",
        mission: "Look into things.",
        scope: "Nothing else.",
        dataRules: "",
        tools: "tasks.write",
        policy: "",
        process: "Look, then say what you found.",
        escalateWhen: "When unsure.",
        output: "One sentence.",
        memory: "",
      },
    },
  });
  await prisma.agent.create({
    data: { key: BOSS_KEY, name: "Endings Boss", title: "Harness", tier: "FUNCTIONAL", department: "TECHNOLOGY", status: "DRAFT", mission: "Hands work out.", toolkit: [] },
  });

  // --- Truncated -------------------------------------------------------------
  console.log("\nThe reply ran out of room");
  const cut = await run("Endings: truncated", () => say([{ type: "text", text: "Here is the first half of what I" }], "max_tokens"));
  const cutSeen = anthropicSeen[0];
  check("it finishes FAILED, not DONE", cut.row.status === "FAILED", cut.row.status);
  check("the runner reports the same", cut.outcome.status === "FAILED", cut.outcome.status);
  check("the error says the reply ran out of room", (cut.row.error ?? "").includes("ran out of room"), cut.row.error ?? "");
  check("its conversation is kept for Run again", Boolean(await prisma.agentTaskCheckpoint.findUnique({ where: { taskId: cut.task.id } })));
  check("nothing on the timeline calls it finished", (await prisma.agentTaskStep.count({ where: { taskId: cut.task.id, kind: "FINISHED" } })) === 0);
  check("the vendor was asked exactly once", cut.requests === 1, String(cut.requests));
  check("and the second vendor not at all", openaiRequests === 0, String(openaiRequests));
  const cutStep = await prisma.agentTaskStep.findFirst({ where: { taskId: cut.task.id, kind: "FAILED" } });
  check("the FAILED step carries stoppedBecause", (cutStep?.data as { stoppedBecause?: string } | null)?.stoppedBecause === "truncated", JSON.stringify(cutStep?.data));
  check("so does the result", (cut.row.result as { stoppedBecause?: string } | null)?.stoppedBecause === "truncated");
  check("and the history names the class", failureClassOf((await lastTransition(cut.task.id))?.reason) === "truncated", (await lastTransition(cut.task.id))?.reason);

  // Run again on a truncation: the same model at the same effort. Thinking is
  // counted inside the same fixed `max_tokens`, so a rung up would spend more
  // of a budget that was already too small.
  const cutModel = cutSeen?.model;
  const cutEffort = cutSeen?.effort;
  await requeue(cut.task.id, "FAILED");
  anthropicSeen.length = 0;
  script = () => say([{ type: "text", text: "All of it, this time." }], "end_turn");
  await runTask(cut.task.id);
  check(
    "a retry after a truncation keeps the model and does not think harder",
    anthropicSeen[0]?.model === cutModel && anthropicSeen[0]?.effort === cutEffort,
    `${cutModel}/${cutEffort} → ${anthropicSeen[0]?.model}/${anthropicSeen[0]?.effort}`,
  );
  const cutRouted = await prisma.agentTaskStep.findFirst({ where: { taskId: cut.task.id, kind: "ROUTED" }, orderBy: { seq: "desc" } });
  check("and the ROUTED step says why", (cutRouted?.message ?? "").includes("ran out of room") && (cutRouted?.message ?? "").includes("rather than climbing"), cutRouted?.message);

  // --- Refused ---------------------------------------------------------------
  console.log("\nThe model declined");
  const refused = await run("Endings: refusal", () => say([], "refusal"));
  check("it finishes BLOCKED", refused.row.status === "BLOCKED", refused.row.status);
  check("the reason names the model", (refused.row.blockedReason ?? "").includes(STUB_MODEL), refused.row.blockedReason ?? "");
  check("and says it was not retried", (refused.row.blockedReason ?? "").includes("not retried"), refused.row.blockedReason ?? "");
  check("one request to the model that declined", refused.requests === 1, String(refused.requests));
  check("and none to the next vendor in the chain — a refusal is never routed around", openaiRequests === 0, String(openaiRequests));
  check("the history names the class", failureClassOf((await lastTransition(refused.task.id))?.reason) === "refusal");
  check("its place is kept, so an answer has a conversation to join", Boolean(await prisma.agentTaskCheckpoint.findUnique({ where: { taskId: refused.task.id } })));

  // The second vendor is only there to prove the negative above; every
  // scenario below runs on Claude alone so a failure cannot hand over.
  delete process.env.OPENAI_API_KEY;
  clearSettingsCache();

  // --- Out of turns ----------------------------------------------------------
  console.log("\nEvery turn used");
  const capped = await run("Endings: iteration cap", (turn) => rememberTurn(turn));
  check(`exactly ${MAX_ITERATIONS} requests`, capped.requests === MAX_ITERATIONS, String(capped.requests));
  check("it finishes BLOCKED", capped.row.status === "BLOCKED", capped.row.status);
  check(`the reason names the ${MAX_ITERATIONS} turns`, (capped.row.blockedReason ?? "").includes(`${MAX_ITERATIONS} turns`), capped.row.blockedReason ?? "");
  check("and quotes the last thing it said", (capped.row.blockedReason ?? "").includes(`turn ${MAX_ITERATIONS}`), capped.row.blockedReason ?? "");
  check(`and offers ${CAP_GRANT_TURNS} more`, (capped.row.blockedReason ?? "").includes(`${CAP_GRANT_TURNS} more`), capped.row.blockedReason ?? "");
  const atCap = await prisma.agentTaskCheckpoint.findUnique({ where: { taskId: capped.task.id } });
  check(`its checkpoint is at iteration ${MAX_ITERATIONS}`, atCap?.iteration === MAX_ITERATIONS, String(atCap?.iteration));
  check("marked as ended by the cap", (atCap?.counters as { endedBy?: string } | null)?.endedBy === "iteration-cap", JSON.stringify(atCap?.counters));
  check("the history names the class", failureClassOf((await lastTransition(capped.task.id))?.reason) === "iteration-cap");

  // "Carry on": the shared answer path, exactly as the browser and Slack use it.
  await recordOwnerAnswer({ id: capped.task.id, brief: capped.row.brief, status: capped.row.status }, "Carry on.", { who: "The check" });
  anthropicSeen.length = 0;
  script = (turn) => rememberTurn(100 + turn);
  await runTask(capped.task.id);
  const granted = await prisma.agentTask.findUniqueOrThrow({ where: { id: capped.task.id } });
  check(`carrying on bought ${CAP_GRANT_TURNS} more requests and no more`, anthropicSeen.length === CAP_GRANT_TURNS, String(anthropicSeen.length));
  const grantStep = await prisma.agentTaskStep.findFirst({ where: { taskId: capped.task.id, kind: "NOTED", message: { contains: `${CAP_GRANT_TURNS} more turns` } } });
  check("the grant is on the timeline as an exception", Boolean(grantStep), "no NOTED step");
  check("and the cap stops it again — one grant per time the cap is reached", granted.status === "BLOCKED" && (granted.blockedReason ?? "").includes(`${MAX_ITERATIONS} turns`), `${granted.status}: ${granted.blockedReason}`);
  const atCapAgain = await prisma.agentTaskCheckpoint.findUnique({ where: { taskId: capped.task.id } });
  check("back at the ceiling, marked again", atCapAgain?.iteration === MAX_ITERATIONS && (atCapAgain?.counters as { endedBy?: string } | null)?.endedBy === "iteration-cap");
  // Requeued without the cap having been reached again would be a second,
  // free grant. A claim that finds no `endedBy` gets nothing.
  await prisma.agentTaskCheckpoint.update({ where: { taskId: capped.task.id }, data: { counters: { ...(atCapAgain?.counters as object), endedBy: undefined } } });
  await requeue(capped.task.id, "BLOCKED");
  anthropicSeen.length = 0;
  await runTask(capped.task.id);
  check("a checkpoint at the ceiling without the cap's mark buys nothing", anthropicSeen.length === 0, String(anthropicSeen.length));

  // --- The endings that were already right ----------------------------------
  console.log("\nThe endings that were already right");
  const done = await run("Endings: finished", (turn) => (turn === 1 ? rememberTurn(turn) : say([{ type: "text", text: "Looked into it; nothing is wrong." }], "end_turn")));
  check("a run that finishes on turn two is DONE", done.row.status === "DONE", done.row.status);
  check("with its checkpoint gone", !(await prisma.agentTaskCheckpoint.findUnique({ where: { taskId: done.task.id } })));
  check("and no class on its history", failureClassOf((await lastTransition(done.task.id))?.reason) === null);

  const asked = await run("Endings: escalate", () =>
    say([{ type: "tool_use", id: "call_esc", name: "escalate", input: { reason: "Which of the two billing addresses is the current one?" } }], "tool_use"),
  );
  check("an escalation is BLOCKED", asked.row.status === "BLOCKED", asked.row.status);
  check("on the agent's own words", asked.row.blockedReason === "Which of the two billing addresses is the current one?", asked.row.blockedReason ?? "");
  check("which carry no failure class — asking is not failing", failureClassOf((await lastTransition(asked.task.id))?.reason) === null, (await lastTransition(asked.task.id))?.reason);

  const prep = await run("Endings: prepared", (turn) =>
    turn === 1
      ? say([{ type: "tool_use", id: "call_prep", name: "tasks__write", input: { title: "Chase the printer", projectId: "harness-project" } }], "tool_use")
      : say([{ type: "text", text: "Prepared the task for a person to approve." }], "end_turn"),
  );
  check("a run that prepared work is NEEDS_APPROVAL", prep.row.status === "NEEDS_APPROVAL", prep.row.status);
  check("with the preparation counted", prep.row.dryRunCalls === 1, String(prep.row.dryRunCalls));

  const capPrep = await run("Endings: cap with prepared work", (turn) =>
    turn === 1 ? say([{ type: "tool_use", id: "call_prep2", name: "tasks__write", input: { title: "Chase the printer", projectId: "harness-project" } }], "tool_use") : rememberTurn(turn),
  );
  check("the cap outranks prepared work: BLOCKED", capPrep.row.status === "BLOCKED", capPrep.row.status);
  check("and the card names the prepared action", (capPrep.row.blockedReason ?? "").includes("1 prepared action is waiting under Approvals"), capPrep.row.blockedReason ?? "");

  // --- A parent hears how its child ended ------------------------------------
  console.log("\nA parent hears how its child ended");
  const parent = await prisma.agentTask.create({ data: { agentKey: BOSS_KEY, title: "Endings: a parent", brief: "Handed something out.", status: "DONE", origin: "OWNER" } });
  const child = await run("Endings: a child", () => say([{ type: "text", text: "Checked the account; it is in order." }], "end_turn"), { parentId: parent.id });
  check("the child finished", child.row.status === "DONE", child.row.status);
  const notes = () => prisma.agentTaskStep.findMany({ where: { taskId: parent.id, kind: "NOTED" } });
  const first = await notes();
  check("exactly one line on a parent that is not running", first.length === 1, String(first.length));
  check("naming the child, the agent and the ending", (first[0]?.message ?? "").includes("Endings Harness") && (first[0]?.message ?? "").includes("Endings: a child") && (first[0]?.message ?? "").includes("DONE"), first[0]?.message);
  check("with the child's id on it", (first[0]?.data as { childTaskId?: string } | null)?.childTaskId === child.task.id);
  await requeue(child.task.id, "DONE");
  script = () => say([{ type: "text", text: "Checked again; still in order." }], "end_turn");
  await runTask(child.task.id);
  check("finishing the same way again adds no second line", (await notes()).length === 1, String((await notes()).length));

  const busyParent = await prisma.agentTask.create({ data: { agentKey: BOSS_KEY, title: "Endings: a busy parent", brief: "Still working.", status: "RUNNING", origin: "OWNER" } });
  await run("Endings: a busy parent's child", () => say([{ type: "text", text: "Done." }], "end_turn"), { parentId: busyParent.id });
  check("and nothing is written into a parent's live run", (await prisma.agentTaskStep.count({ where: { taskId: busyParent.id } })) === 0);
  await prisma.agentTask.update({ where: { id: busyParent.id }, data: { status: "DONE" } });

  // --- The retry ladder, on the wire -----------------------------------------
  console.log("\nThe retry ladder, on the wire");
  const ladder = await run("Endings: the ladder", (turn) => (turn === 1 ? rememberTurn(turn) : say([{ type: "text", text: "and then the" }], "max_tokens")));
  check("the first run failed", ladder.row.status === "FAILED", ladder.row.status);
  // The stub can end a run short only by truncating it, and a truncation no
  // longer climbs (above). So each failure here is re-filed under the class a
  // failure from our own side of the run carries — the one word `routeTask`
  // reads — and the ladder itself is exercised exactly as it was.
  await asModelFault(ladder.task.id);
  const firstModel = anthropicSeen[0]?.model;
  const firstEffort = anthropicSeen[0]?.effort;
  const firstLevel = ladder.row.level;

  // Rung one: requeued the way Run again does it, and this time the vendor is
  // busy, so the run pauses part-way through its retry.
  await requeue(ladder.task.id, "FAILED");
  anthropicSeen.length = 0;
  script = () => ({ status: 503, headers: { "x-should-retry": "false" }, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
  await runTask(ladder.task.id);
  const rungOne = anthropicSeen[0];
  console.log(`    first run ${firstLevel}: ${firstModel} at ${firstEffort}; first retry: ${rungOne?.model} at ${rungOne?.effort}`);
  const afterRungOne = await prisma.agentTask.findUniqueOrThrow({ where: { id: ladder.task.id } });
  check("the first retry keeps the level", afterRungOne.level === firstLevel, `${firstLevel} → ${afterRungOne.level}`);
  check("and so the model", rungOne?.model === firstModel, `${firstModel} → ${rungOne?.model}`);
  check("but asks it to think harder", Boolean(rungOne?.effort) && rungOne?.effort !== firstEffort, `${firstEffort} → ${rungOne?.effort}`);
  const sent = rungOne?.messages ?? [];
  check("it is told why, exactly once", traceBlocks(sent) === 1, String(traceBlocks(sent)));
  const tail = sent.at(-1);
  const tailBlocks = Array.isArray(tail?.content) ? (tail!.content as { type?: string; text?: string }[]) : [];
  check(
    "as text after the tool results, in the same user turn",
    tail?.role === "user" && tailBlocks[0]?.type === "tool_result" && tailBlocks.at(-1)?.type === "text" && (tailBlocks.at(-1)?.text ?? "").includes("ran out of room"),
    JSON.stringify(tailBlocks.map((block) => block.type)),
  );
  check("and the conversation still alternates — no two user turns in a row", alternates(sent));
  check("the busy vendor paused it rather than failing it", afterRungOne.status === "QUEUED" && Boolean(afterRungOne.retryReason), `${afterRungOne.status} / ${afterRungOne.retryReason}`);

  // The pause ends: the same retry, picked up again.
  anthropicSeen.length = 0;
  script = () => say([{ type: "text", text: "and then the" }], "max_tokens");
  await runTask(ladder.task.id);
  const resumed = anthropicSeen[0];
  check("a pause in the middle of the retry comes back on the same rung", resumed?.effort === rungOne?.effort && resumed?.model === rungOne?.model, `${resumed?.model}/${resumed?.effort}`);
  check("without being told about the failure a second time", traceBlocks(resumed?.messages ?? []) === 1, String(traceBlocks(resumed?.messages ?? [])));
  const afterSecond = await prisma.agentTask.findUniqueOrThrow({ where: { id: ladder.task.id } });
  check("and it failed again", afterSecond.status === "FAILED", afterSecond.status);
  await asModelFault(ladder.task.id);

  // Rung two: a second failure in a row is the evidence thinking was not enough.
  await requeue(ladder.task.id, "FAILED");
  anthropicSeen.length = 0;
  script = () => say([{ type: "text", text: "All done." }], "end_turn");
  await runTask(ladder.task.id);
  const rungTwo = anthropicSeen[0];
  console.log(`    second retry: ${rungTwo?.model} at ${rungTwo?.effort}`);
  const afterRungTwo = await prisma.agentTask.findUniqueOrThrow({ where: { id: ladder.task.id } });
  check("the second failure in a row moves the level up", afterRungTwo.level !== firstLevel && afterRungTwo.levelSource === "retry", `${firstLevel} → ${afterRungTwo.level} (${afterRungTwo.levelSource})`);
  check("and the model with it", Boolean(rungTwo?.model) && rungTwo?.model !== firstModel, `${firstModel} → ${rungTwo?.model}`);
  check("told why once more — once per retry", traceBlocks(rungTwo?.messages ?? []) === 2, String(traceBlocks(rungTwo?.messages ?? [])));
  check("and still alternating", alternates(rungTwo?.messages ?? []));
  check("it finished", afterRungTwo.status === "DONE", afterRungTwo.status);

  // A run that died half-way through a turn keeps that turn outside the
  // conversation, so the last user message there is one the model already
  // answered. Telling the retry there would be an edit to history, not an
  // append — so it rejoins untold rather than with a rewritten past.
  console.log("\nA retry that rejoins half-way through a turn");
  const brief = "Look into the account and say what you found.";
  const half = await prisma.agentTask.create({ data: { agentKey: AGENT_KEY, title: "Endings: half a turn", brief, origin: "OWNER", status: "FAILED", level: "STANDARD" } });
  const seededAt = Date.now() - 5_000;
  const seeded: Array<[null | "QUEUED" | "RUNNING", "QUEUED" | "RUNNING" | "FAILED", string]> = [
    [null, "QUEUED", "seeded"],
    ["QUEUED", "RUNNING", "seeded"],
    ["RUNNING", "FAILED", "[tool-error] A write did not land."],
  ];
  for (const [index, [from, to, reason]] of seeded.entries()) {
    await prisma.agentTaskTransition.create({ data: { taskId: half.id, from, to, reason, actor: index === 0 ? "owner" : "runner", at: new Date(seededAt + index * 1000) } });
  }
  await prisma.agentTaskCheckpoint.create({
    data: {
      taskId: half.id,
      iteration: 1,
      messages: [{ role: "user", content: brief }],
      narration: [],
      pendingAssistant: [{ type: "tool_use", id: "call_half", name: "remember", input: { kind: "LESSON", content: "Half a turn.", about: "myself" } }],
      pendingResults: [],
      counters: { toolCalls: 0, claimIteration: 0 },
    },
  });
  await requeue(half.id, "FAILED");
  anthropicSeen.length = 0;
  script = () => say([{ type: "text", text: "Looked into it; nothing is wrong." }], "end_turn");
  await runTask(half.id);
  const rejoined = anthropicSeen[0]?.messages ?? [];
  // As text: the loop sends the first turn as a block so it can carry a cache
  // breakpoint, which is not an edit — the words are what matter.
  const firstTurn = rejoined[0]?.content;
  const firstText = typeof firstTurn === "string" ? firstTurn : (firstTurn as { type?: string; text?: string }[] | undefined)?.map((block) => block.text ?? "").join("");
  check("the turn the model already answered is sent exactly as it was", firstText === brief, JSON.stringify(firstTurn).slice(0, 160));
  check("so the trace is nowhere in it", traceBlocks(rejoined) === 0, String(traceBlocks(rejoined)));
  check("and the half-finished turn is completed in order", rejoined.length === 3 && alternates(rejoined), JSON.stringify(rejoined.map((message) => message.role)));
  check("it finished", (await prisma.agentTask.findUniqueOrThrow({ where: { id: half.id } })).status === "DONE");

  server.close();
  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
