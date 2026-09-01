import type { AgentSchedule } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { SETTING, getSetting, setSetting } from "../../lib/settings.js";
import { parseScheduleTime, safeZone, zonedDateParts, zonedTimeToUtc } from "../../lib/timezone.js";
import { recordCreated } from "./state.js";

/**
 * What an agent does without being asked.
 *
 * `AgentTaskOrigin.SCHEDULE` has existed since the runtime shipped and nothing
 * has ever written it. Every task so far has come from a person opening the
 * Agents screen, or from one agent handing work to another — which makes fifty
 * agents that can work and have no reason to start. This is the reason to
 * start.
 *
 * **The time maths is `lib/timezone`'s**, which is where the scrapers get
 * theirs. `parseScheduleTime` moved there when this arrived, because the
 * scheduler importing standing work while standing work imported the scheduler
 * is a module cycle — the kind that surfaces as an undefined export at boot
 * rather than as a type error.
 *
 * **Three ceilings, because a loop that raises work faster than an agent
 * finishes it would queue for ever and the first sign of it would be the
 * bill:**
 *
 * 1. `maxOpenTasks` per schedule — by default one, so a daily brief that is
 *    still unfinished tomorrow does not become two.
 * 2. The per-agent lock in the runner's claim: one agent, one running task.
 * 3. `MAX_CATCHUP_MS`, so a slot missed during an outage is skipped rather
 *    than stampeded through on boot.
 */

/** A slot older than this was missed during an outage. Do it next time, not six times now. */
const MAX_CATCHUP_MS = 6 * 60 * 60_000;

/** The soonest slot strictly after `from`, ignoring the weekday rule. */
function soonestSlot(runTimes: string[], timezone: string, from: Date): Date | null {
  const zone = safeZone(timezone);
  const [year, month, day] = zonedDateParts(from, zone);

  let earliest: Date | null = null;
  // Today and tomorrow is enough for a daily schedule; the extra day covers
  // slots that have already passed in the schedule's own timezone.
  for (const dayOffset of [0, 1]) {
    for (const raw of runTimes) {
      const time = parseScheduleTime(raw);
      if (!time) continue;
      const candidate = zonedTimeToUtc(year, month, day + dayOffset, time.hour, time.minute, zone);
      if (candidate.getTime() > from.getTime() && (!earliest || candidate < earliest)) earliest = candidate;
    }
  }
  return earliest;
}

/**
 * The next time this schedule should raise a task.
 *
 * Walks forward over weekends where the schedule asks for weekdays only. The
 * walk is bounded rather than trusted to terminate: a schedule saved with the
 * times field empty would otherwise spin, and that is the easiest one to save
 * by accident.
 */
export function nextRunFor(schedule: Pick<AgentSchedule, "enabled" | "runTimes" | "timezone" | "weekdaysOnly">, from = new Date()): Date | null {
  if (!schedule.enabled || schedule.runTimes.length === 0) return null;
  let cursor = from;

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const next = soonestSlot(schedule.runTimes, schedule.timezone, cursor);
    if (!next) return null;
    if (!schedule.weekdaysOnly) return next;

    // Judged in the schedule's own zone, not the server's: 08:00 Monday in
    // Accra is Sunday evening in a good many of them.
    const zone = safeZone(schedule.timezone);
    const [year, month, day] = zonedDateParts(next, zone);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return next;

    cursor = next;
  }
  return null;
}

/** Recomputes and stores `nextRunAt`. Call after any change to a schedule. */
export async function syncStandingWork(id: string): Promise<Date | null> {
  const schedule = await prisma.agentSchedule.findUnique({ where: { id } });
  if (!schedule) return null;
  const nextRunAt = schedule.enabled ? nextRunFor(schedule) : null;
  await prisma.agentSchedule.update({ where: { id }, data: { nextRunAt } });
  return nextRunAt;
}

/**
 * Raises the tasks that are due.
 *
 * Joins the six jobs on the minute tick. Like the scraper tick it **advances
 * the schedule before doing the work**, so a failure cannot be retried in a
 * loop and a restart cannot fire the same slot twice.
 */
export async function raiseStandingWork(now = new Date()): Promise<number> {
  // Schedules enabled before this ever ran, or saved with no next time worked
  // out. Same backfill the scrapers do.
  const unscheduled = await prisma.agentSchedule.findMany({ where: { enabled: true, nextRunAt: null } });
  for (const schedule of unscheduled) {
    await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: nextRunFor(schedule, now) } });
  }

  const due = await prisma.agentSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    include: { agent: { select: { key: true, name: true, status: true } } },
  });
  if (due.length === 0) return 0;

  let raised = 0;
  for (const schedule of due) {
    const slot = schedule.nextRunAt;
    // Spent whatever happens next.
    await prisma.agentSchedule.update({
      where: { id: schedule.id },
      data: { nextRunAt: nextRunFor(schedule, now), lastRunAt: now },
    });

    if (slot && now.getTime() - slot.getTime() > MAX_CATCHUP_MS) {
      console.warn(`[standing] skipping "${schedule.title}" — its ${slot.toISOString()} slot is more than six hours stale.`);
      continue;
    }

    // A draft or paused agent is not refused loudly: the Owner pausing an agent
    // is exactly how they stop its standing work, and a warning every minute
    // about a deliberate decision is noise.
    if (schedule.agent.status !== "ACTIVE") continue;

    const open = await prisma.agentTask.count({
      where: { agentKey: schedule.agentKey, origin: "SCHEDULE", title: schedule.title, status: { in: ["QUEUED", "RUNNING", "BLOCKED", "NEEDS_APPROVAL"] } },
    });
    if (open >= schedule.maxOpenTasks) {
      console.warn(`[standing] "${schedule.title}" already has ${open} open — not raising another.`);
      continue;
    }

    const raisedTask = await prisma.agentTask.create({
      data: {
        agentKey: schedule.agentKey,
        title: schedule.title,
        brief: schedule.brief,
        origin: "SCHEDULE",
      },
      select: { id: true, traceId: true, status: true },
    });
    await recordCreated(raisedTask.id, raisedTask.traceId, raisedTask.status, {
      reason: `Standing work: "${schedule.title}" came round on its schedule.`,
      actor: "schedule",
    });
    raised += 1;
    console.log(`[standing] raised "${schedule.title}" for ${schedule.agent.name}`);
  }

  return raised;
}

// --- The shipped shift ------------------------------------------------------

/**
 * The standing work the lead chain does without being asked.
 *
 * `AgentSchedule` is the only thing that writes `AgentTaskOrigin.SCHEDULE`,
 * and until now nothing ever wrote an `AgentSchedule`. The consequence was not
 * an error anywhere: it was a live database holding fifty-six willing agents
 * and tens of thousands of captured businesses, with no reason for any agent
 * to begin. "Run agents now" looped over an empty table and honestly reported
 * that nothing was waiting.
 *
 * These seven are one chain, in the order a lead travels through it, and they
 * are deliberately not one per agent. Standing work costs model tokens every
 * morning whether or not there was anything to do, so an agent gets a slot
 * here when there is a question worth asking daily — not because it exists.
 *
 * The first is the Hunt Strategist's, and it is the one that answers "are
 * there enough businesses worth writing to". It writes a thesis and hands it
 * over; it does not enable one, because enabling a hunt starts an Apify
 * capture twice a day and that is the Owner's money.
 */
interface StandingSeed {
  agentKey: string;
  title: string;
  runTimes: string[];
  brief: string;
}

const STANDING_SEEDS: StandingSeed[] = [
  {
    agentKey: "hunt.strategist",
    title: "Is the pipeline being fed, and by what argument?",
    runTimes: ["07:15"],
    brief: `Read the state of the pipeline before anything else is done today, and answer one question: does Dakyworld have enough businesses worth writing to, and are the reasons we went looking for them still holding?

Work from what the last cycles actually returned rather than from the totals. Which qualifiers fired on the businesses that qualified, and which have never once been true on anybody. Say plainly whether the leads already on the books are enough to work, or whether the shortage is real.

When the shortage is real, write the thesis that should close it: the target in a sentence somebody would say out loud, why them, what we would sell them, the tests that decide a fit, the disqualifiers, and what would make you retire it. Hand it over for the Owner to enable. You do not enable it and you do not start a hunt — that spends money twice a day and it is not your decision.

When the shortage is not real, say so, and say what the actual bottleneck is instead. Recommending a hunt while thousands of captured businesses sit unjudged is the expensive wrong answer.`,
  },
  {
    agentKey: "lead.enricher",
    title: "Fill in what the scrapes left blank",
    runTimes: ["08:00"],
    brief: `Take a batch of leads that cannot be judged yet because too much of the record is empty, and fill in what can be filled from sources that can be cited.

Fill a blank or leave it blank. Never overwrite a value something or somebody else has already established, and never guess. Carry the address every value came from at the moment you write it down. Prefer what a business says about itself on its own site to what a search inferred about it, and where two sources disagree, say so and fill nothing.

Report which fields were filled, the source behind each, what is still blank, and anything that needs a person's eye before it is used.`,
  },
  {
    agentKey: "mail.room",
    title: "Read the post",
    runTimes: ["08:15", "14:00"],
    brief: `Read what has come in and has not been given to anybody yet.

Most of the post is already sorted by the time it reaches you, so what arrives here is what did not fit — which means the useful answer is nearly always "this belongs to X", not "here is a reply".

Anything that reads as an opt-out, a complaint or a legal notice goes to a person immediately, whatever else it also says.

Report what arrived, who each one belongs to, and what is still unassigned and why.`,
  },
  {
    agentKey: "lead.orchestrator",
    title: "Qualify and route the day's unworked leads",
    runTimes: ["08:30"],
    brief: `Take a batch of leads nobody has judged and decide, for each, what happens to it next.

Open the lead and read what has actually been checked on it — the research, the audit, the look at the homepage, anything already sent or said. Not the trade, not the name, not what businesses like this usually need. Score on those findings only, and say which fact moved the score and in which direction.

Where the record is thin, the next step is "look at them first" — never a lower score. A low score on an unexamined lead is a decision dressed up as a measurement, and it takes that business out of every list from then on.

Finish with the score, the one or two facts that decided it, the next step, and who takes it. Low confidence or contradictory evidence goes to a person.`,
  },
  {
    agentKey: "outreach.writer",
    title: "Write the first letter to today's qualified leads",
    runTimes: ["09:30"],
    brief: `Take the leads qualified since yesterday and write the first message to each one.

Prepare the lead before writing a word: what they do, what was actually found on their setup, and what is worth saying about it. The letter is argued from that evidence and from nothing else — never from what businesses of that trade usually need.

Check the address is not suppressed before drafting. Where there is no email but there is a number, say which channel this one should be reached on instead.

Finish with the message, the evidence each claim rests on, and anything you could not verify.`,
  },
  {
    agentKey: "email.sequencer",
    title: "Work today's sending queue",
    runTimes: ["10:30"],
    brief: `Look at what is drafted and waiting to go out, and at what is already enrolled in a sequence.

Check every address against the suppression list before anything is sent or enrolled. Stop a sequence where the lead has replied, bounced or asked to be left alone — a follow-up after a reply is the fastest way to lose both the lead and the sending reputation.

Report what went out, what was held and why, and anything about the sending pattern a person should look at.`,
  },
  {
    agentKey: "outreach.followup",
    title: "Follow up on outreach that has gone quiet",
    runTimes: ["11:30"],
    brief: `Find the outreach that was sent, was not answered, and is now due a second or third touch.

A follow-up is a new reason to reply, not a reminder that you wrote. Read what the first message argued and what has been found or has changed since, and lead with that. Where there is nothing new to say, say the thread should be closed rather than padded.

Stop entirely on anyone who replied, bounced, or asked to be left alone.

Report what was written, what was closed, and why in each case.`,
  },
];

export interface StandingWorkSeeded {
  created: { agentKey: string; title: string; nextRunAt: Date | null }[];
  /** Named rather than counted: a seed skipped because its agent is missing is a roster problem, not a no-op. */
  skipped: { agentKey: string; because: string }[];
  firstRun: boolean;
}

/**
 * Puts the seven schedules above on the database.
 *
 * Additive and marked, on the same contract `AGENT_SEEDS` and the lead theses
 * keep: a schedule that already exists is left exactly as it is, including
 * `enabled` — and unlike a hunt, these are seeded **on**, because standing work
 * spends model tokens rather than somebody's Apify balance, and an agent with
 * no reason to start is the whole problem this closes.
 *
 * The marker means a schedule the Owner later disables or deletes stays gone.
 * Without it every deploy would put back the one thing they had just switched
 * off, which is the failure that makes a switch not a switch.
 */
export async function ensureStandingWork(): Promise<StandingWorkSeeded | null> {
  const marker = SETTING.AGENT_STANDING_WORK;
  if (await getSetting(marker)) return null;

  const now = new Date();
  const created: StandingWorkSeeded["created"] = [];
  const skipped: StandingWorkSeeded["skipped"] = [];

  for (const seed of STANDING_SEEDS) {
    const agent = await prisma.agent.findUnique({ where: { key: seed.agentKey }, select: { key: true } });
    if (!agent) {
      skipped.push({ agentKey: seed.agentKey, because: "no agent by that key" });
      continue;
    }

    // Adopt rather than duplicate. Somebody who has already written this
    // schedule by hand should not get a second copy raising a second task
    // every morning.
    const existing = await prisma.agentSchedule.findFirst({
      where: { agentKey: seed.agentKey, title: seed.title },
      select: { id: true },
    });
    if (existing) {
      skipped.push({ agentKey: seed.agentKey, because: "already has this schedule" });
      continue;
    }

    const shape = { enabled: true, runTimes: seed.runTimes, timezone: "Africa/Accra", weekdaysOnly: true };
    const schedule = await prisma.agentSchedule.create({
      data: { agentKey: seed.agentKey, title: seed.title, brief: seed.brief, maxOpenTasks: 1, ...shape, nextRunAt: nextRunFor(shape, now) },
      select: { agentKey: true, title: true, nextRunAt: true },
    });
    created.push(schedule);
  }

  await setSetting(marker, new Date().toISOString());
  return { created, skipped, firstRun: true };
}
