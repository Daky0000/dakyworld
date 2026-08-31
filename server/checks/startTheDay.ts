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
 * Database only. No key, no network: every agent here is a draft or has its
 * own ceiling, so nothing reaches a model.
 */
import { startTheDay } from "../src/services/agents/startTheDay.js";
import { isPaused } from "../src/services/agents/retry.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.startday.agent";
const DRAFT_KEY = "check.startday.draft";

async function reset() {
  await prisma.agentSchedule.deleteMany({ where: { agentKey: { in: [AGENT_KEY, DRAFT_KEY] } } });
  await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: { in: [AGENT_KEY, DRAFT_KEY] } } } });
  await prisma.agentTaskStep.deleteMany({ where: { task: { agentKey: { in: [AGENT_KEY, DRAFT_KEY] } } } });
  await prisma.agentTask.deleteMany({ where: { agentKey: { in: [AGENT_KEY, DRAFT_KEY] } } });
  await prisma.agent.deleteMany({ where: { key: { in: [AGENT_KEY, DRAFT_KEY] } } });
}

await reset();
for (const [key, name, status] of [
  [AGENT_KEY, "Start The Day Check", "ACTIVE"],
  [DRAFT_KEY, "Still A Draft", "DRAFT"],
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

await reset();
await prisma.$disconnect();

console.log(bad === 0 ? "\nAll good.\n" : `\n${bad} problem(s).\n`);
process.exit(bad === 0 ? 0 : 1);
