/**
 * What happens to a run whose process died, and to a run that failed?
 *
 * Two rules decide whether a task is tried again, and both were half-built.
 *
 * **A task that kills its process must not be handed back for ever.** The cap
 * on dying — three attempts without getting any further — lived only in the
 * reaper. The road that actually runs after a crash is the boot pass, which
 * requeued every RUNNING row it found without asking anything, so a task whose
 * first tool call took the container down came back on every restart. Both
 * roads share one rule now, read off the checkpoint: did the dead run get
 * further than the claim that started it?
 *
 * **A retry must know it is a retry.** The ladder — think harder first, then a
 * stronger model — keyed on the claim's own `from`, which says QUEUED whenever
 * anybody requeued the task before it was claimed, which is nearly always. It
 * is read from the transitions now, and the negatives matter as much as the
 * positives: a failure the reaper or a restart wrote is not the model's, a
 * pause for a busy vendor is not a failure, and a task already at the top
 * level is never moved further.
 *
 * Rows are seeded directly — no model, no stub, no network.
 *   npx tsx checks/agentResume.ts
 */
import type { AgentTaskStatus } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { abandonedRun, failureTrace, lastFailure, resumeInterruptedTasks, runDueTasks } from "../src/services/agents/runner.js";
import { routeTask } from "../src/services/agents/complexity.js";

const AGENT_KEY = "tmp.resume";

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

async function reset() {
  const tasks = await prisma.agentTask.findMany({ where: { agentKey: AGENT_KEY }, select: { id: true } });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
}

/** A RUNNING row as a dead process leaves it, with or without a checkpoint. */
async function stranded(
  title: string,
  attempts: number,
  checkpoint: { iteration: number; counters: Record<string, unknown> } | null,
  heartbeatAt: Date | null = new Date(),
) {
  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title, brief: "Seeded by the check.", status: "RUNNING", attempts, startedAt: new Date(), heartbeatAt, runOwner: "a-process-that-died" },
  });
  if (checkpoint) {
    await prisma.agentTaskCheckpoint.create({
      data: {
        taskId: task.id,
        iteration: checkpoint.iteration,
        messages: [{ role: "user", content: "Seeded by the check." }],
        narration: [],
        counters: checkpoint.counters as never,
      },
    });
  }
  return task;
}

const status = async (id: string) => (await prisma.agentTask.findUniqueOrThrow({ where: { id } })).status;
const newest = (taskId: string) => prisma.agentTaskTransition.findFirst({ where: { taskId }, orderBy: [{ at: "desc" }, { id: "desc" }] });

/** A task with a written history, one second between moves so the order is unambiguous. */
async function withHistory(title: string, level: "SIMPLE" | "STANDARD" | "COMPLEX", moves: Array<[AgentTaskStatus | null, AgentTaskStatus, string, string?]>) {
  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title, brief: "Seeded by the check.", status: moves.at(-1)![1], level },
  });
  const start = Date.now() - moves.length * 1000;
  for (const [index, [from, to, actor, reason]] of moves.entries()) {
    await prisma.agentTaskTransition.create({
      data: { taskId: task.id, from, to, actor, reason: reason ?? `${from ?? "new"} to ${to}`, at: new Date(start + index * 1000) },
    });
  }
  return task;
}

const CLAIM: [AgentTaskStatus, AgentTaskStatus, string] = ["QUEUED", "RUNNING", "runner"];
const FIRST_RUN: Array<[AgentTaskStatus | null, AgentTaskStatus, string, string?]> = [
  [null, "QUEUED", "owner"],
  ["QUEUED", "RUNNING", "runner"],
];

async function main() {
  await reset();
  const agent = await prisma.agent.create({
    data: { key: AGENT_KEY, name: "Resume Harness", title: "Harness", tier: "OPERATIONAL", department: "TECHNOLOGY", status: "DRAFT", mission: "Exists so seeded tasks have an owner.", toolkit: [] },
  });

  // --- The verdict, on its own -------------------------------------------------
  console.log("\nDid the dead run get anywhere?");
  check("no checkpoint at all is no progress", abandonedRun(null) === "stuck");
  check("a checkpoint no further than its claim is no progress", abandonedRun({ iteration: 3, counters: { claimIteration: 3 } }) === "stuck");
  check("a checkpoint past its claim is progress", abandonedRun({ iteration: 4, counters: { claimIteration: 3 } }) === "progressed");
  check("a checkpoint from before claims were stamped is no evidence either way", abandonedRun({ iteration: 4, counters: { toolCalls: 2 } }) === "unknown");

  // --- The boot pass -----------------------------------------------------------
  console.log("\nThe boot pass");
  const poison = await stranded("Resume: dies in the same place", 3, { iteration: 2, counters: { claimIteration: 2 } });
  const young = await stranded("Resume: died once", 1, { iteration: 2, counters: { claimIteration: 2 } });
  const moving = await stranded("Resume: dies, but further each time", 3, { iteration: 5, counters: { claimIteration: 2 } });
  const legacy = await stranded("Resume: an older checkpoint", 3, { iteration: 2, counters: { toolCalls: 1 } });
  const never = await stranded("Resume: never saved anything", 3, null);

  await resumeInterruptedTasks();

  check("three deaths in the same place fail it", (await status(poison.id)) === "FAILED", await status(poison.id));
  const poisonMove = await newest(poison.id);
  check("written by the boot pass", poisonMove?.actor === "boot", poisonMove?.actor);
  check("saying why", (poisonMove?.reason ?? "").includes("without getting any further"), poisonMove?.reason);
  check("one death is handed back", (await status(young.id)) === "QUEUED", await status(young.id));
  const movingRow = await prisma.agentTask.findUniqueOrThrow({ where: { id: moving.id } });
  check("a run that got further is handed back however often it died", movingRow.status === "QUEUED", movingRow.status);
  check("with its attempts started again", movingRow.attempts === 0, String(movingRow.attempts));
  check("a checkpoint with no claim stamped on it is handed back, never failed", (await status(legacy.id)) === "QUEUED", await status(legacy.id));
  check("three deaths with nothing ever saved fail it too", (await status(never.id)) === "FAILED", await status(never.id));

  // --- The reaper --------------------------------------------------------------
  console.log("\nThe reaper");
  const quiet = await stranded("Resume: quiet for ten minutes", 3, null, new Date(Date.now() - 10 * 60_000));
  const fresh = await stranded("Resume: beat a minute ago", 3, null, new Date(Date.now() - 60_000));
  // A limit of zero: reap, and start nothing.
  await runDueTasks(new Date(), 0);
  check("quiet for ten minutes and three attempts: failed", (await status(quiet.id)) === "FAILED", await status(quiet.id));
  check("by the reaper", (await newest(quiet.id))?.actor === "reaper", (await newest(quiet.id))?.actor);
  check("a heartbeat a minute old is left alone", (await status(fresh.id)) === "RUNNING", await status(fresh.id));
  await prisma.agentTask.update({ where: { id: fresh.id }, data: { status: "CANCELLED" } });

  // --- Is this claim a retry? ------------------------------------------------------
  console.log("\nIs this claim the retry of a failed run?");
  const route = async (taskId: string, extra: { resuming?: boolean } = {}) => {
    const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    const failure = await lastFailure(taskId);
    const decision = await routeTask({
      agent,
      task,
      toolkit: [],
      likely: [],
      resuming: extra.resuming ?? true,
      previousStatus: failure ? "FAILED" : "QUEUED",
      previousActor: failure?.actor ?? null,
      failuresInARow: failure?.inARow ?? 0,
      mode: "rules",
    });
    return { failure, decision };
  };

  const once = await withHistory("Resume: failed once", "STANDARD", [
    ...FIRST_RUN,
    ["RUNNING", "FAILED", "runner", "[truncated] The reply ran out of room before it finished."],
    ["FAILED", "QUEUED", "owner", "Run again."],
    CLAIM,
  ]);
  const first = await route(once.id);
  check("a failure the runner wrote, requeued by a person, is found", first.failure?.actor === "runner", JSON.stringify(first.failure));
  check("with its class", first.failure?.failureClass === "truncated");
  check("and the tag taken off its reason", first.failure?.reason === "The reply ran out of room before it finished.", first.failure?.reason);
  check("the first retry keeps the level", first.decision.level === "standard" && first.decision.decidedBy === "retry", `${first.decision.level} / ${first.decision.decidedBy}`);
  check("and thinks one step harder", first.decision.effortFloor === "high" && first.decision.effort === "high", `${first.decision.effortFloor}`);

  // What the retry is told. The failed run's own last bad call, and never one
  // from a run before it that has since been put right.
  console.log("\nWhat the retry is told");
  const traced = await withHistory("Resume: a trace", "STANDARD", [
    ...FIRST_RUN,
    ["RUNNING", "FAILED", "runner", "[tool-error] A write did not land."],
    ["FAILED", "QUEUED", "owner"],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "FAILED", "runner", "[truncated] The reply ran out of room before it finished."],
    ["FAILED", "QUEUED", "owner"],
    CLAIM,
  ]);
  const moves = await prisma.agentTaskTransition.findMany({ where: { taskId: traced.id }, orderBy: { at: "asc" } });
  const badCall = (seq: number, message: string, at: Date) =>
    prisma.agentTaskStep.create({ data: { taskId: traced.id, seq, kind: "TOOL_CALL", message, ok: false, createdAt: at } });
  // The first run's bad call lands between its claim and its failure; the
  // second run's, between its own.
  await badCall(1, "audit.website failed — the first run's broken call", new Date(moves[1].at.getTime() + 300));
  const tracedFailure = await lastFailure(traced.id);
  check("the failed run's claim is found", tracedFailure?.runStartedAt?.getTime() === moves[4].at.getTime(), `${tracedFailure?.runStartedAt?.toISOString()} vs ${moves[4].at.toISOString()}`);
  const quietTrace = await failureTrace(traced.id, tracedFailure!);
  check("the trace names how it ended and why", quietTrace.includes("ended FAILED (truncated)") && quietTrace.includes("ran out of room"), quietTrace);
  check("and is not handed a bad call from an earlier run", !quietTrace.includes("first run's broken call"), quietTrace);
  check("it is a few lines, not a log", quietTrace.split("\n").length <= 3 && quietTrace.length < 800, String(quietTrace.length));
  await badCall(2, "email.send failed — the failed run's own broken call", new Date(moves[4].at.getTime() + 300));
  const loudTrace = await failureTrace(traced.id, tracedFailure!);
  check("the failed run's own last bad call is named", loudTrace.includes("the failed run's own broken call") && !loudTrace.includes("first run's"), loudTrace);

  const direct = await withHistory("Resume: Run pressed on a failed task", "STANDARD", [...FIRST_RUN, ["RUNNING", "FAILED", "runner"], ["FAILED", "RUNNING", "runner"]]);
  check("a claim straight out of FAILED counts too", (await route(direct.id)).failure?.actor === "runner");

  const twice = await withHistory("Resume: failed twice", "STANDARD", [
    ...FIRST_RUN,
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "owner"],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "QUEUED", "runner", "Paused for a busy vendor."],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "slack"],
    CLAIM,
  ]);
  const second = await route(twice.id);
  check("two failures in a row are counted as two, a pause between them notwithstanding", second.failure?.inARow === 2, String(second.failure?.inARow));
  check("and the second steps the level up", second.decision.level === "complex" && second.decision.decidedBy === "retry", `${second.decision.level}`);
  check("without raising the effort as well", second.decision.effortFloor === null, String(second.decision.effortFloor));

  const broken = await withHistory("Resume: a block between two failures", "STANDARD", [
    ...FIRST_RUN,
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "owner"],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "BLOCKED", "runner"],
    ["BLOCKED", "QUEUED", "owner"],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "owner"],
    CLAIM,
  ]);
  check("any other ending between two failures starts the count again", (await route(broken.id)).failure?.inARow === 1, String((await route(broken.id)).failure?.inARow));

  const crashing = await withHistory("Resume: a reaper failure between two", "STANDARD", [
    ...FIRST_RUN,
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "owner"],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "FAILED", "reaper"],
    ["FAILED", "QUEUED", "owner"],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "owner"],
    CLAIM,
  ]);
  check("a reaper failure neither adds to the count nor breaks it", (await route(crashing.id)).failure?.inARow === 2, String((await route(crashing.id)).failure?.inARow));

  console.log("\nAnd the claims that are not");
  for (const actor of ["reaper", "boot"]) {
    const t = await withHistory(`Resume: failed by ${actor}`, "STANDARD", [...FIRST_RUN, ["RUNNING", "FAILED", actor], ["FAILED", "QUEUED", "owner"], CLAIM]);
    const r = await route(t.id);
    check(`a failure the ${actor} wrote is found`, r.failure?.actor === actor);
    check(`but buys no rung — dying is not the model's fault (${actor})`, r.decision.decidedBy === "stored" && r.decision.level === "standard" && r.decision.effortFloor === null, `${r.decision.decidedBy} ${r.decision.level} ${r.decision.effortFloor}`);
  }

  const paused = await withHistory("Resume: paused", "STANDARD", [...FIRST_RUN, ["RUNNING", "QUEUED", "runner", "Paused for a busy vendor."], CLAIM]);
  const p = await route(paused.id);
  check("a pause is not a failure", p.failure === null);
  check("and resumes on the stored level, unmoved", p.decision.decidedBy === "stored" && p.decision.level === "standard" && p.decision.effortFloor === null);

  const retryPaused = await withHistory("Resume: paused halfway through a retry", "STANDARD", [
    ...FIRST_RUN,
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "owner"],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "QUEUED", "runner", "Paused for a busy vendor."],
    CLAIM,
  ]);
  check("a pause halfway through a retry is not a second retry", (await lastFailure(retryPaused.id)) === null);
  const keptRung = await routeTask({
    agent,
    task: await prisma.agentTask.findUniqueOrThrow({ where: { id: retryPaused.id } }),
    toolkit: [],
    likely: [],
    resuming: true,
    previousStatus: "QUEUED",
    savedEffortFloor: "high",
    mode: "rules",
  });
  check("but comes back on the rung its checkpoint saved", keptRung.decidedBy === "stored" && keptRung.effortFloor === "high" && keptRung.effort === "high", `${keptRung.effortFloor}`);

  const blocked = await withHistory("Resume: blocked then requeued", "STANDARD", [...FIRST_RUN, ["RUNNING", "BLOCKED", "runner"], ["BLOCKED", "QUEUED", "owner"], CLAIM]);
  const b = await route(blocked.id);
  check("a block answered and requeued is not a failure", b.failure === null);
  check("and does not move the level", b.decision.decidedBy === "stored" && b.decision.level === "standard");

  console.log("\nThe top of the ladder");
  const top = await withHistory("Resume: complex, failed", "COMPLEX", [...FIRST_RUN, ["RUNNING", "FAILED", "runner"], ["FAILED", "QUEUED", "owner"], CLAIM]);
  const t1 = await route(top.id);
  check("a complex task that failed stays complex", t1.decision.level === "complex", t1.decision.level ?? "");
  check("and thinks harder instead", t1.decision.effortFloor === "xhigh", String(t1.decision.effortFloor));
  const topTwice = await withHistory("Resume: complex, failed twice", "COMPLEX", [
    ...FIRST_RUN,
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "owner"],
    ["QUEUED", "RUNNING", "runner"],
    ["RUNNING", "FAILED", "runner"],
    ["FAILED", "QUEUED", "owner"],
    CLAIM,
  ]);
  const t2 = await route(topTwice.id);
  check("is never stepped further, however often it fails", t2.decision.level === "complex", t2.decision.level ?? "");
  check("and its effort stops at max", t2.decision.effortFloor === "max", String(t2.decision.effortFloor));

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
