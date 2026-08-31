import { prisma } from "../../lib/prisma.js";
import { recordCreated } from "./state.js";
import { nextRunFor } from "./standingWork.js";
import { runDueTasks } from "./runner.js";
import { hunt } from "../hunt/run.js";

/**
 * "The time to act is up — go and do your day."
 *
 * Everything in this system is on a clock. Standing work comes round at 08:00,
 * a hunt at 07:30 and 15:30, the queue is worked one tick at a time. That is
 * the right way for it to run and the wrong way to *watch* it run: somebody who
 * has just set an agent live, or just written a thesis, wants to see what
 * happens, and telling them to come back at half past seven is not an answer.
 *
 * So this is the clock, brought forward, deliberately and by a person. It does
 * exactly what the scheduler would have done at the next slot — the same
 * functions, the same guards — and nothing the scheduler would not:
 *
 * - **Every ceiling still applies.** The per-schedule `maxOpenTasks`, the
 *   one-task-per-agent lock, the process concurrency limit, the spending
 *   budgets and the pace ceilings are all in `runDueTasks` and `raiseStandingWork`
 *   and none of them is bypassed here. This moves the *time*, not the rules.
 * - **A draft or paused agent stays asleep.** Pressing this is not a way to
 *   start an agent somebody deliberately switched off.
 * - **`nextRunAt` is advanced**, exactly as a real firing would, so bringing a
 *   slot forward spends it rather than adding one. Press it at 07:29 and the
 *   07:30 run does not also happen.
 * - **Paused tasks are woken.** A task waiting five minutes on a rate limit is
 *   waiting on a clock too, and "act now" means that clock as well. The wait
 *   budget is reset, because the person pressing this is the one deciding to
 *   try again.
 *
 * Hunts are **opt-in** on this button rather than included by default. Standing
 * work costs model tokens; a hunt starts an Apify capture and audits five
 * businesses, which is real money on somebody's card, and "start the day"
 * should not quietly mean that.
 */

export interface StartTheDayResult {
  /** Standing-work tasks raised because their slot was brought forward. */
  raised: number;
  /** Tasks that were paused on a vendor and have been woken. */
  woken: number;
  /** Runs actually started this instant. The rest begin on the ticks that follow. */
  started: number;
  /** Hunts set going, when hunts were asked for. */
  hunts: number;
  /** Schedules that came round but belong to an agent that is not ACTIVE. */
  asleep: string[];
  /** What happened, in one sentence for a person. */
  summary: string;
}

export async function startTheDay(options: { includeHunts?: boolean } = {}): Promise<StartTheDayResult> {
  const now = new Date();

  // 1. Every standing schedule, as though its slot had just come round.
  //
  // Deliberately not `raiseStandingWork(now)`: that only fires schedules whose
  // `nextRunAt` has already passed, which on a normal morning is none of them —
  // pressing the button would raise nothing and look broken. This brings the
  // slot forward and then keeps every one of that function's guards.
  const schedules = await prisma.agentSchedule.findMany({
    where: { enabled: true },
    include: { agent: { select: { key: true, name: true, status: true } } },
  });

  let raised = 0;
  const asleep: string[] = [];

  for (const schedule of schedules) {
    // Spent whatever happens next, like a real firing. Without this, pressing
    // the button at 07:29 raises the task and the 07:30 tick raises it again.
    await prisma.agentSchedule.update({
      where: { id: schedule.id },
      data: { nextRunAt: nextRunFor(schedule, now), lastRunAt: now },
    });

    if (schedule.agent.status !== "ACTIVE") {
      asleep.push(`${schedule.agent.name} (${schedule.agent.status.toLowerCase()})`);
      continue;
    }

    const open = await prisma.agentTask.count({
      where: {
        agentKey: schedule.agentKey,
        origin: "SCHEDULE",
        title: schedule.title,
        status: { in: ["QUEUED", "RUNNING", "BLOCKED", "NEEDS_APPROVAL"] },
      },
    });
    if (open >= schedule.maxOpenTasks) continue;

    const task = await prisma.agentTask.create({
      data: { agentKey: schedule.agentKey, title: schedule.title, brief: schedule.brief, origin: "SCHEDULE" },
      select: { id: true, traceId: true, status: true },
    });
    await recordCreated(task.id, task.traceId, task.status, {
      reason: `Standing work: "${schedule.title}", brought forward by hand.`,
      actor: "owner",
    });
    raised += 1;
  }

  // 2. Anything already queued for later, and anything paused on a vendor.
  //
  // A task with a future `scheduledFor` is waiting on a clock, and this is the
  // clock being moved. `retryCount` goes back to zero with it: the person
  // pressing this is deciding to try again, so the backoff starts afresh
  // rather than jumping to the forty-minute rung.
  const woken = (
    await prisma.agentTask.updateMany({
      where: { status: "QUEUED", scheduledFor: { gt: now } },
      data: { scheduledFor: null, retryCount: 0, retryReason: null },
    })
  ).count;

  // 3. Work the queue now rather than on the next tick.
  //
  // `runDueTasks` starts as many as the concurrency ceiling allows and returns;
  // the rest are picked up by the ticks that follow, one agent at a time, which
  // is the same behaviour as any other morning.
  const started = await runDueTasks(now);

  // 4. The hunts, only when asked. This one spends at Apify.
  let hunts = 0;
  if (options.includeHunts) {
    const running = await prisma.leadThesis.findMany({
      where: { enabled: true, sourceId: { not: null } },
      select: { id: true, name: true },
    });
    for (const thesis of running) {
      // Not awaited: a cycle is a capture plus five audits, which is minutes.
      void hunt(thesis.id, "MANUAL").catch((err) => console.error(`[start] "${thesis.name}" failed:`, (err as Error).message));
      hunts += 1;
    }
  }

  const parts = [
    raised > 0 ? `${raised} standing job${raised === 1 ? "" : "s"} raised` : null,
    woken > 0 ? `${woken} paused task${woken === 1 ? "" : "s"} woken` : null,
    `${started} started now`,
    hunts > 0 ? `${hunts} hunt${hunts === 1 ? "" : "s"} going` : null,
  ].filter(Boolean);

  const summary =
    (parts.length > 0 ? `${parts.join(", ")}.` : "Nothing to start.") +
    (asleep.length > 0 ? ` Left asleep because they are not Active: ${asleep.join(", ")}.` : "") +
    (started === 0 && raised === 0 && woken === 0
      ? " Nothing was waiting — either every agent is a draft, or their standing work is already open."
      : " The rest begin over the next few minutes, one task per agent.");

  return { raised, woken, started, hunts, asleep, summary };
}
