/**
 * Bringing the clock forward, and the two things that must not come with it.
 *
 * "Start the day" exists because everything in this system is on a clock, and
 * a clock is the right way for it to run and the wrong way to watch it run.
 * Its whole promise is in one sentence of its own doc: it does what the
 * scheduler would have done at the next slot, and *nothing the scheduler would
 * not*. Every assertion here is a way of breaking that promise.
 *
 *  - **A task somebody scheduled for Tuesday is not a paused task.** Both sit
 *    QUEUED with a future `scheduledFor`, and only one of them is waiting on a
 *    vendor. Waking both meant pressing this on Monday morning started work
 *    the Owner had deliberately put off — which the button is not allowed to
 *    do and nothing anywhere would have said it had. `retryReason` is what
 *    tells them apart, because `retry.ts` is the only thing that writes the
 *    pair, and it is the same predicate `isPaused` reads.
 *  - **A slot brought forward is a slot spent.** Press it at 07:29 and the
 *    07:30 tick must not raise the same standing job again.
 *  - **A draft or paused agent stays asleep.** This is a way to move the time,
 *    never a way to start an agent somebody switched off.
 *
 * And, behind `flags.workflows`, **the daily chain keeps its order** — on the
 * minute tick and on the button. A stage whose upstream is still QUEUED or
 * RUNNING is held without spending its slot; it goes the moment the upstream
 * is done, or after ninety minutes with a warning; a BLOCKED or NEEDS_APPROVAL
 * upstream holds nobody, because it is waiting on a person. With the flag off,
 * both stages go together exactly as they always did. The chain here is the
 * check's own (`after`), not the shipped one, so nothing touches a real agent.
 *
 * A database and a local stub. No key, no network: every agent here is a draft
 * or has its own ceiling, so nothing the button starts reaches a model; the
 * section on runs that ended short calls `runTask` itself, against a stub
 * Anthropic on a port the OS picks.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startTheDay } from "../src/services/agents/startTheDay.js";
import { inChainOrder, raiseStandingWork } from "../src/services/agents/standingWork.js";
import { isPaused } from "../src/services/agents/retry.js";
import { failureClassOf, runTask } from "../src/services/agents/runner.js";
import { recordCreated, transition } from "../src/services/agents/state.js";
import { closeEscalation } from "../src/services/agents/escalationDigest.js";
import { FLAG, flagOn, forgetFlags, setFlag } from "../src/lib/featureFlags.js";
import { clearSettingsCache } from "../src/lib/settings.js";
import { prisma } from "../src/lib/prisma.js";

// The env beats the database for a flag, and this file decides the flag for
// itself in each half. Removed before anything reads it.
delete process.env.FLAG_WORKFLOWS;
const flagFound = await prisma.appSetting.findUnique({ where: { key: FLAG.WORKFLOWS } });

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.startday.agent";
const DRAFT_KEY = "check.startday.draft";
// The chain: B waits for A. C is in no chain at all.
const A_KEY = "check.startday.chain.a";
const B_KEY = "check.startday.chain.b";
const C_KEY = "check.startday.chain.c";
const KEYS = [AGENT_KEY, DRAFT_KEY, A_KEY, B_KEY, C_KEY];

async function clearWork() {
  await prisma.agentSchedule.deleteMany({ where: { agentKey: { in: KEYS } } });
  await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: { in: KEYS } } } });
  await prisma.agentTaskStep.deleteMany({ where: { task: { agentKey: { in: KEYS } } } });
  // What a real run leaves behind, in the section that runs one.
  await prisma.agentTaskCheckpoint.deleteMany({ where: { task: { agentKey: { in: KEYS } } } });
  await prisma.actionRequest.deleteMany({ where: { agentKey: { in: KEYS } } });
  await prisma.llmCall.deleteMany({ where: { OR: [{ agentKey: { in: KEYS } }, { purpose: { in: KEYS.map((key) => `agent.${key}`) } }] } });
  await prisma.toolCall.deleteMany({ where: { agentKey: { in: KEYS } } });
  await prisma.agentMemory.deleteMany({ where: { OR: [{ agentKey: { in: KEYS } }, { authorKey: { in: KEYS } }] } });
  await prisma.agentTask.deleteMany({ where: { agentKey: { in: KEYS } } });
}

async function reset() {
  await clearWork();
  await prisma.agent.deleteMany({ where: { key: { in: KEYS } } });
}

await reset();
for (const [key, name, status] of [
  [AGENT_KEY, "Start The Day Check", "ACTIVE"],
  [DRAFT_KEY, "Still A Draft", "DRAFT"],
  [A_KEY, "Chain Stage A", "ACTIVE"],
  [B_KEY, "Chain Stage B", "ACTIVE"],
  [C_KEY, "Chain Stage C", "ACTIVE"],
] as const) {
  await prisma.agent.create({
    data: {
      key,
      name,
      title: name,
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status,
      mission: "Exists for one test run.",
      custom: true,
      // Its own ceiling of zero, so `runDueTasks` holds everything this file
      // creates before a model is ever asked for anything. The button is still
      // exercised end to end; what it must not do here is spend money.
      maxTasksPerDay: 0,
    },
  });
}

const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
const inFive = new Date(Date.now() + 5 * 60_000);

// The sections that predate the chain run as they always did: flag off.
await setFlag(FLAG.WORKFLOWS, false);

console.log("\nAn appointment is not a pause");
{
  const appointment = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "on Tuesday", brief: "b", status: "QUEUED", scheduledFor: tomorrow, origin: "OWNER" },
  });
  const paused = await prisma.agentTask.create({
    data: {
      agentKey: AGENT_KEY,
      title: "paused on a vendor",
      brief: "b",
      status: "QUEUED",
      scheduledFor: inFive,
      retryCount: 1,
      retryReason: "The model provider is rate-limiting us. Paused for 5 minutes.",
    },
  });

  // The two look identical to anything reading `status` and `scheduledFor`
  // alone, which is the whole point of the assertion below.
  const before = await prisma.agentTask.findUniqueOrThrow({ where: { id: paused.id } });
  check("the paused one reads as paused", isPaused(before));
  const appt = await prisma.agentTask.findUniqueOrThrow({ where: { id: appointment.id } });
  check("and the appointment does not", !isPaused(appt));

  const result = await startTheDay();
  const after = async (id: string) => prisma.agentTask.findUniqueOrThrow({ where: { id } });

  check("the paused task is woken", (await after(paused.id)).scheduledFor === null, `${(await after(paused.id)).scheduledFor}`);
  check("and its wait budget starts afresh", (await after(paused.id)).retryCount === 0, `${(await after(paused.id)).retryCount}`);
  check("the appointment is left where it is", (await after(appointment.id)).scheduledFor !== null, `${(await after(appointment.id)).scheduledFor}`);
  check("exactly one was woken", result.woken === 1, `${result.woken}`);

  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
}

console.log("\nA slot brought forward is a slot spent");
{
  // 23:59 tomorrow, so its own `nextRunAt` is genuinely in the future and the
  // ordinary tick would not fire it. Pressing the button must raise it anyway,
  // and must then move the slot on.
  const schedule = await prisma.agentSchedule.create({
    data: {
      agentKey: AGENT_KEY,
      title: "The daily brief",
      brief: "Write the daily brief.",
      runTimes: ["23:59"],
      timezone: "UTC",
      enabled: true,
      maxOpenTasks: 1,
      nextRunAt: tomorrow,
    },
  });

  const first = await startTheDay();
  check("the standing job is raised", first.raised >= 1, `${first.raised}`);
  const moved = await prisma.agentSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
  check("the slot moved on", moved.nextRunAt !== null && moved.nextRunAt.getTime() !== tomorrow.getTime(), `${moved.nextRunAt}`);
  check("and it is recorded as having run", moved.lastRunAt !== null);

  // Pressing it twice is the same mistake as the 07:29 press followed by the
  // 07:30 tick: `maxOpenTasks` is what stops one job becoming two.
  const second = await startTheDay();
  check("pressing it again raises nothing", second.raised === 0, `${second.raised}`);
  const open = await prisma.agentTask.count({ where: { agentKey: AGENT_KEY, origin: "SCHEDULE" } });
  check("so there is still one open job, not two", open === 1, `${open}`);

  await prisma.agentSchedule.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
}

console.log("\nAnd an agent somebody switched off stays off");
{
  await prisma.agentSchedule.create({
    data: {
      agentKey: DRAFT_KEY,
      title: "Something the draft would do",
      brief: "b",
      runTimes: ["23:59"],
      timezone: "UTC",
      enabled: true,
      maxOpenTasks: 1,
      nextRunAt: tomorrow,
    },
  });

  const result = await startTheDay();
  const raised = await prisma.agentTask.count({ where: { agentKey: DRAFT_KEY } });
  check("no task is raised for it", raised === 0, `${raised}`);
  check("and it is named as asleep", result.asleep.some((entry) => entry.includes("Still A Draft")), result.asleep.join(", "));
  check("in words a person can act on", result.summary.includes("not Active"), result.summary.slice(0, 120));
}

/** Every `console.warn` while `run` runs, still printed. */
async function warningsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
    original(...args);
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return seen;
}

// --- A run that ended short does not stop the standing job --------------------
//
// A run that used every turn, or that the model declined, ends BLOCKED with
// its class at the front of the transition (`[iteration-cap]`, `[refusal]`).
// Counted as open against `maxOpenTasks` 1, one bad morning stopped the job
// for good: every later slot said "already has 1 open" and nothing else did.
// The blocked task still waits for a person; the next slot runs beside it,
// and its timeline says why the one before it is still there. A BLOCKED task
// that asked a question is different — its answer is the work — and still
// holds the slot.
//
// **Every ending here is a real run**: `runTask` against a local Anthropic
// stub, so the row is in exactly the state production leaves it in. The first
// version of this section wrote its BLOCKED rows by hand, which skipped
// `transition()` — and `transition()` sets `escalationStatus` PENDING on every
// road into BLOCKED. The hand-made rows had none, so the check passed against
// a fix that never fired on a real capped run. `runTask` ignores the agent's
// ceiling of zero (only `runDueTasks` reads it), so these run while the button
// sections above and below still start nothing.
const SHORT_TITLE = "The job that ran out of turns";

type StubReply = { content: unknown[]; stop: string };
let stubScript: (turn: number) => StubReply = () => ({ content: [{ type: "text", text: "Done." }], stop: "end_turn" });
let stubTurns = 0;
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = req.url ?? "";
    if (!url.includes("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no stub route for ${url}` } }));
      return;
    }
    const asked = JSON.parse(raw || "{}") as { model?: string };
    stubTurns += 1;
    const { content, stop } = stubScript(stubTurns);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_startday_${stubTurns}`,
        type: "message",
        role: "assistant",
        model: asked.model ?? "claude-opus-5",
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 10 },
      }),
    );
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
// Claude alone, at the stub: every other vendor's key out of the environment
// and every base URL pointed here, so nothing can reach a real one.
for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY", "PERPLEXITY_API_KEY"]) delete process.env[name];
for (const name of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GEMINI_BASE_URL", "NVIDIA_BASE_URL", "PERPLEXITY_BASE_URL"]) process.env[name] = stubUrl;
process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
clearSettingsCache();

const ENDINGS = {
  // Sixteen turns of a tool every agent has, and never an answer.
  "used every turn": (turn: number): StubReply => ({
    content: [
      { type: "text", text: `Still going, turn ${turn}.` },
      { type: "tool_use", id: `call_startday_${turn}_${Date.now()}`, name: "remember", input: { kind: "LESSON", content: `Turn ${turn}: still at it.`, about: "myself" } },
    ],
    stop: "tool_use",
  }),
  "was declined by the model": (): StubReply => ({ content: [], stop: "refusal" }),
  asked: (turn: number): StubReply => ({
    content: [{ type: "tool_use", id: `call_startday_ask_${turn}`, name: "escalate", input: { reason: "Which of the two lists should I work from this morning?" } }],
    stop: "tool_use",
  }),
} as const;

/** A scheduled run of the job, raised the way standing work raises one, and run for real. */
async function endedBy(how: keyof typeof ENDINGS) {
  const task = await prisma.agentTask.create({ data: { agentKey: AGENT_KEY, title: SHORT_TITLE, brief: "Work through the list.", origin: "SCHEDULE" } });
  await recordCreated(task.id, task.traceId, task.status, { reason: "Raised by the check's schedule.", actor: "schedule" });
  stubTurns = 0;
  stubScript = ENDINGS[how];
  await runTask(task.id);
  return prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
}
const newestBlocked = (taskId: string) =>
  prisma.agentTaskTransition.findFirst({ where: { taskId, to: "BLOCKED" }, orderBy: [{ at: "desc" }, { id: "desc" }] });
const shortSchedule = () =>
  prisma.agentSchedule.create({
    data: { agentKey: AGENT_KEY, title: SHORT_TITLE, brief: "b", runTimes: ["23:59"], timezone: "UTC", enabled: true, maxOpenTasks: 1, nextRunAt: new Date(Date.now() - 60_000) },
  });
const raisedSince = (before: string[]) =>
  prisma.agentTask.findMany({ where: { agentKey: AGENT_KEY, origin: "SCHEDULE", id: { notIn: before } }, include: { steps: true } });

console.log("\nA run that ended short does not stop the standing job");
for (const [label, failureClass] of [
  ["used every turn", "iteration-cap"],
  ["was declined by the model", "refusal"],
] as const) {
  await clearWork();
  await shortSchedule();
  const blocked = await endedBy(label);
  const reason = (await newestBlocked(blocked.id))?.reason ?? "";
  check(`a run that ${label} really ends BLOCKED, classed ${failureClass}`, blocked.status === "BLOCKED" && failureClassOf(reason) === failureClass, `${blocked.status} / ${reason}`);
  // The state the first version of this section never built.
  check("with its escalation PENDING, as every road into BLOCKED leaves it", blocked.escalationStatus === "PENDING", String(blocked.escalationStatus));
  await raiseStandingWork(new Date());
  const fresh = await raisedSince([blocked.id]);
  check(`the next slot is raised beside a run that ${label}`, fresh.length === 1, `${fresh.length}`);
  const note = fresh[0]?.steps.find((one) => one.kind === "NOTED");
  check(
    "and its timeline says the slot before it ended short, and why",
    Boolean(note && note.message.includes(blocked.id) && note.message.includes(failureClass)),
    note?.message,
  );
  check("the blocked one is left waiting for a person", (await prisma.agentTask.findUniqueOrThrow({ where: { id: blocked.id } })).status === "BLOCKED");
  await prisma.agentSchedule.updateMany({ where: { agentKey: AGENT_KEY }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
  const warned = await warningsDuring(() => raiseStandingWork(new Date()));
  check("and the new one still holds the slot after it, as any open task does", (await raisedSince([blocked.id])).length === 1);
  check("which the log names as open", warned.some((line) => line.includes(SHORT_TITLE) && line.includes("already has 1 open")), warned.join(" | "));
}
{
  await clearWork();
  await shortSchedule();
  const blocked = await endedBy("used every turn");
  const result = await startTheDay();
  const fresh = await raisedSince([blocked.id]);
  check("the button raises it too", fresh.length === 1 && result.raised >= 1, `${fresh.length} / ${result.raised}`);
  check("with the same note", fresh[0]?.steps.some((one) => one.kind === "NOTED" && one.message.includes(blocked.id)) === true);
}
{
  // Closing the card on a capped run — "read and left as it is" — writes an
  // untagged BLOCKED-to-BLOCKED entry. The run is still one that ended short.
  await clearWork();
  await shortSchedule();
  const blocked = await endedBy("used every turn");
  check("(a capped run's card can be closed)", await closeEscalation(blocked.id, { who: "the check" }));
  await raiseStandingWork(new Date());
  check("a capped run whose card was closed still does not hold the slot", (await raisedSince([blocked.id])).length === 1);
}
{
  // The negatives: a question waiting for an answer holds the slot, and so do
  // an ending with no class on it and a capped task somebody set going again.
  await clearWork();
  await shortSchedule();
  const asked = await endedBy("asked");
  check(
    "(an agent that asked really ends BLOCKED, untagged and PENDING)",
    asked.status === "BLOCKED" && asked.escalationStatus === "PENDING" && failureClassOf((await newestBlocked(asked.id))?.reason) === null,
    `${asked.status} / ${asked.escalationStatus}`,
  );
  await raiseStandingWork(new Date());
  check("a BLOCKED task waiting on an escalation answer still holds the slot", (await raisedSince([asked.id])).length === 0);

  await clearWork();
  await shortSchedule();
  const untagged = await prisma.agentTask.create({ data: { agentKey: AGENT_KEY, title: SHORT_TITLE, brief: "b", origin: "SCHEDULE" } });
  await recordCreated(untagged.id, untagged.traceId, untagged.status, { reason: "Raised by the check's schedule.", actor: "schedule" });
  await transition(untagged.id, { to: "RUNNING", reason: "Claimed.", actor: "runner", expect: ["QUEUED"] });
  await transition(untagged.id, { to: "BLOCKED", reason: "Blocked for a reason with no class on it.", actor: "runner", expect: ["RUNNING"] });
  await raiseStandingWork(new Date());
  check("so does a BLOCKED task with no class on its ending", (await raisedSince([untagged.id])).length === 0);

  await clearWork();
  await shortSchedule();
  const carried = await endedBy("used every turn");
  await transition(carried.id, { to: "QUEUED", reason: "Carry on.", actor: "owner", expect: ["BLOCKED"] });
  await raiseStandingWork(new Date());
  check("and so does a capped task somebody pressed Carry on for", (await raisedSince([carried.id])).length === 0);
}
await clearWork();
stub.close();

// --- The daily chain, behind flags.workflows --------------------------------
const STAGE_A = "Stage A";
const STAGE_B = "Stage B";
const STAGE_C = "Stage C";
const AFTER = { [`${B_KEY}|${STAGE_B}`]: `${A_KEY}|${STAGE_A}` } as const;

async function schedule(agentKey: string, title: string, nextRunAt: Date) {
  return prisma.agentSchedule.create({
    data: { agentKey, title, brief: `${title}, for the check.`, runTimes: ["23:59"], timezone: "UTC", enabled: true, maxOpenTasks: 1, nextRunAt },
  });
}
async function taskFor(agentKey: string, title: string, status: "QUEUED" | "RUNNING" | "BLOCKED" | "NEEDS_APPROVAL" | "DONE") {
  return prisma.agentTask.create({ data: { agentKey, title, brief: "b", origin: "SCHEDULE", status } });
}
const tasksOf = (agentKey: string) => prisma.agentTask.count({ where: { agentKey, origin: "SCHEDULE" } });
const scheduleOf = (id: string) => prisma.agentSchedule.findUniqueOrThrow({ where: { id } });

console.log("\nThe chain keeps its order on the minute tick (flag on)");
await setFlag(FLAG.WORKFLOWS, true);
{
  await clearWork();
  const slot = new Date(Date.now() - 60_000);
  // B is created first, so a table read in insertion order hands it back
  // first — the order in which, without the chain order, B would look for A's
  // task, find none, and start.
  const b = await schedule(B_KEY, STAGE_B, slot);
  await schedule(A_KEY, STAGE_A, slot);

  const order = inChainOrder([{ agentKey: B_KEY, title: STAGE_B }, { agentKey: A_KEY, title: STAGE_A }], AFTER).map((one) => one.agentKey);
  check("upstream is put first even when it is handed over second", order.join(",") === [A_KEY, B_KEY].join(","), order.join(","));
  const unrelated = inChainOrder([{ agentKey: C_KEY, title: STAGE_C }, { agentKey: A_KEY, title: STAGE_A }], AFTER).map((one) => one.agentKey);
  check("and a schedule in no chain keeps its place", unrelated.join(",") === [C_KEY, A_KEY].join(","), unrelated.join(","));

  // Counted per agent rather than read off the return value: the tick works
  // every due schedule on the database, which on a developer's copy includes
  // the shipped ones — the same reach the button above already has.
  await raiseStandingWork(new Date(), AFTER);
  check("A is raised", (await tasksOf(A_KEY)) === 1, `${await tasksOf(A_KEY)}`);
  check("B is not raised while A is queued — in the same tick, whatever order the table came back in", (await tasksOf(B_KEY)) === 0, `${await tasksOf(B_KEY)}`);
  const heldB = await scheduleOf(b.id);
  check("B's slot is not spent", heldB.nextRunAt?.getTime() === slot.getTime() && heldB.lastRunAt === null, `${heldB.nextRunAt?.toISOString()} / ${heldB.lastRunAt}`);

  await raiseStandingWork(new Date(), AFTER);
  check("the next tick still holds B while A has not finished", (await tasksOf(B_KEY)) === 0, `${await tasksOf(B_KEY)}`);

  await prisma.agentTask.updateMany({ where: { agentKey: A_KEY }, data: { status: "DONE" } });
  await raiseStandingWork(new Date(), AFTER);
  check("once A is done, the next tick raises B", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
  const spent = await scheduleOf(b.id);
  check("and spends B's slot then", spent.nextRunAt !== null && spent.nextRunAt.getTime() > Date.now() && spent.lastRunAt !== null, `${spent.nextRunAt?.toISOString()}`);
  await raiseStandingWork(new Date(), AFTER);
  check("exactly once", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
}

console.log("\nAn upstream stuck for ninety minutes stops holding anybody");
{
  await clearWork();
  const slot = new Date(Date.now() - 60_000);
  const b = await schedule(B_KEY, STAGE_B, slot);
  await taskFor(A_KEY, STAGE_A, "RUNNING");

  await raiseStandingWork(new Date(slot.getTime() + 89 * 60_000), AFTER);
  check("at 89 minutes B is still held", (await tasksOf(B_KEY)) === 0, `${await tasksOf(B_KEY)}`);

  const warned = await warningsDuring(() => raiseStandingWork(new Date(slot.getTime() + 91 * 60_000), AFTER));
  check("at 91 minutes B is raised anyway", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
  check(
    "and it says so",
    warned.some((line) => line.includes(STAGE_B) && line.includes(STAGE_A) && line.includes("running")),
    warned.join(" | ").slice(0, 200),
  );
  check("its slot spent like any other", (await scheduleOf(b.id)).lastRunAt !== null);
}

console.log("\nOnly work in progress holds anybody");
for (const status of ["BLOCKED", "NEEDS_APPROVAL", "DONE"] as const) {
  await clearWork();
  await schedule(B_KEY, STAGE_B, new Date(Date.now() - 60_000));
  await taskFor(A_KEY, STAGE_A, status);
  await raiseStandingWork(new Date(), AFTER);
  check(`an upstream that is ${status} does not hold B`, (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
}
{
  // An upstream agent somebody switched off: `runDueTasks` starts nothing for
  // it, so its queued task waits on a person as surely as a BLOCKED one does.
  await clearWork();
  await prisma.agent.update({ where: { key: A_KEY }, data: { status: "PAUSED" } });
  await schedule(B_KEY, STAGE_B, new Date(Date.now() - 60_000));
  await taskFor(A_KEY, STAGE_A, "QUEUED");
  await raiseStandingWork(new Date(), AFTER);
  check("a queued upstream whose agent is paused does not hold B", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
  await prisma.agent.update({ where: { key: A_KEY }, data: { status: "ACTIVE" } });
}
{
  // Yesterday's run is not this morning's: a queued task older than the
  // lookback holds nobody.
  await clearWork();
  await schedule(B_KEY, STAGE_B, new Date(Date.now() - 60_000));
  const old = await taskFor(A_KEY, STAGE_A, "QUEUED");
  await prisma.agentTask.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 13 * 60 * 60_000) } });
  await raiseStandingWork(new Date(), AFTER);
  check("an upstream task from thirteen hours ago does not hold B", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
}
{
  await clearWork();
  await schedule(C_KEY, STAGE_C, new Date(Date.now() - 60_000));
  await taskFor(A_KEY, STAGE_A, "QUEUED");
  await raiseStandingWork(new Date(), AFTER);
  check("a schedule with no upstream is raised while A is queued", (await tasksOf(C_KEY)) === 1, `${await tasksOf(C_KEY)}`);
}
{
  // The ceiling that was there before the chain: B already has its one open
  // task, nothing upstream is open, so the slot is spent and nothing is added.
  await clearWork();
  const b = await schedule(B_KEY, STAGE_B, new Date(Date.now() - 60_000));
  await taskFor(B_KEY, STAGE_B, "QUEUED");
  await raiseStandingWork(new Date(), AFTER);
  check("maxOpenTasks still stops a second B", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
  check("and the slot is spent as before", (await scheduleOf(b.id)).lastRunAt !== null);
}
{
  // B's own last run is waiting on a person — a refused or capped run ends
  // BLOCKED now rather than DONE — so B raises nothing whatever A is doing.
  // Holding it behind a queued A would only put off spending a slot that was
  // never going to raise anything.
  await clearWork();
  const b = await schedule(B_KEY, STAGE_B, new Date(Date.now() - 60_000));
  await taskFor(B_KEY, STAGE_B, "BLOCKED");
  await taskFor(A_KEY, STAGE_A, "QUEUED");
  await raiseStandingWork(new Date(), AFTER);
  check("a B whose own last run is BLOCKED is not held behind a queued A — its slot is spent", (await scheduleOf(b.id)).lastRunAt !== null);
  check("and no second B is raised beside the blocked one", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
}

console.log("\nThe button keeps the order too (flag on)");
{
  await clearWork();
  const b = await schedule(B_KEY, STAGE_B, tomorrow);
  await schedule(A_KEY, STAGE_A, tomorrow);
  const pressedAt = Date.now();
  const result = await startTheDay({ after: AFTER });
  check("A is raised", (await tasksOf(A_KEY)) === 1, `${await tasksOf(A_KEY)}`);
  check("B is not", (await tasksOf(B_KEY)) === 0, `${await tasksOf(B_KEY)}`);
  const held = await scheduleOf(b.id);
  check(
    "B is brought forward and left unspent",
    held.nextRunAt !== null && held.nextRunAt.getTime() <= Date.now() && held.nextRunAt.getTime() >= pressedAt - 1000 && held.lastRunAt === null,
    `${held.nextRunAt?.toISOString()} / ${held.lastRunAt}`,
  );
  check("the reply names B as waiting", result.held.some((entry) => entry.includes("Chain Stage B") && entry.includes("Chain Stage A")), result.held.join(", "));
  check("in the sentence a person reads", result.summary.includes("Waiting for the stage before them"), result.summary.slice(0, 200));
  // Every ceiling still applies: these agents may start nothing today.
  const running = await prisma.agentTask.count({ where: { agentKey: { in: KEYS }, status: "RUNNING" } });
  check("and nothing was started past its agent's own ceiling", running === 0, `${running}`);

  await prisma.agentTask.updateMany({ where: { agentKey: A_KEY }, data: { status: "DONE" } });
  await raiseStandingWork(new Date(), AFTER);
  check("once A is done, the minute tick raises B", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
}
{
  // The reply is a promise: a stage named as waiting is one the tick will
  // raise. A B whose own last run is BLOCKED will not be, so it is not named.
  await clearWork();
  await schedule(B_KEY, STAGE_B, tomorrow);
  await schedule(A_KEY, STAGE_A, tomorrow);
  await taskFor(B_KEY, STAGE_B, "BLOCKED");
  const result = await startTheDay({ after: AFTER });
  check("A is raised beside a B that is blocked on its own", (await tasksOf(A_KEY)) === 1, `${await tasksOf(A_KEY)}`);
  check(
    "a B whose own last run is BLOCKED is not reported as waiting",
    result.held.length === 0 && !result.summary.includes("Waiting for the stage before them"),
    `${result.held.join(", ")} / ${result.summary.slice(0, 160)}`,
  );
  check("and nothing more is raised for it", (await tasksOf(B_KEY)) === 1, `${await tasksOf(B_KEY)}`);
}
{
  // A draft stage is asleep, not waiting: holding it would only delay saying so.
  await clearWork();
  await prisma.agent.update({ where: { key: B_KEY }, data: { status: "DRAFT" } });
  await schedule(B_KEY, STAGE_B, tomorrow);
  await schedule(A_KEY, STAGE_A, tomorrow);
  const result = await startTheDay({ after: AFTER });
  check("a draft B is not held", result.held.length === 0, result.held.join(", "));
  check("it is named asleep instead", result.asleep.some((entry) => entry.includes("Chain Stage B")), result.asleep.join(", "));
  check("and nothing is raised for it", (await tasksOf(B_KEY)) === 0, `${await tasksOf(B_KEY)}`);
  await prisma.agent.update({ where: { key: B_KEY }, data: { status: "ACTIVE" } });
}

console.log("\nWith the flag off, nothing about any of this changes");
// Off as it ships: no row and no env, rather than a row saying false — the
// state every database is in until somebody turns it on.
await prisma.appSetting.deleteMany({ where: { key: FLAG.WORKFLOWS } });
clearSettingsCache();
forgetFlags();
check("flags.workflows ships off", !(await flagOn(FLAG.WORKFLOWS)));
{
  await clearWork();
  const slot = new Date(Date.now() - 60_000);
  const b = await schedule(B_KEY, STAGE_B, slot);
  await schedule(A_KEY, STAGE_A, slot);
  await raiseStandingWork(new Date(), AFTER);
  check("the tick raises both stages together", (await tasksOf(A_KEY)) === 1 && (await tasksOf(B_KEY)) === 1, `${await tasksOf(A_KEY)} / ${await tasksOf(B_KEY)}`);
  check("and spends B's slot", (await scheduleOf(b.id)).lastRunAt !== null);
}
{
  await clearWork();
  await schedule(B_KEY, STAGE_B, tomorrow);
  await schedule(A_KEY, STAGE_A, tomorrow);
  const result = await startTheDay({ after: AFTER });
  check("the button raises both stages together", (await tasksOf(A_KEY)) === 1 && (await tasksOf(B_KEY)) === 1, `${result.raised}`);
  check("and holds nobody", result.held.length === 0, result.held.join(", "));
}

await reset();
// The flag put back as it was found — deleted when there was no row, which is
// how it ships.
await prisma.appSetting.deleteMany({ where: { key: FLAG.WORKFLOWS } });
if (flagFound) await prisma.appSetting.create({ data: { key: flagFound.key, value: flagFound.value, secret: flagFound.secret } });
clearSettingsCache();
forgetFlags();
await prisma.$disconnect();

console.log(bad === 0 ? "\nAll good.\n" : `\n${bad} problem(s).\n`);
process.exit(bad === 0 ? 0 : 1);
