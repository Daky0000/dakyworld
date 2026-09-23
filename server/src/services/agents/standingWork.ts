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
    agentKey: "ceo",
    title: "Sync weekly company priorities and Founding Partner slot availability",
    runTimes: ["07:00"],
    brief: `Read the week's record and the company living context: what shipped, what slipped, cash position, Founding Partner slots remaining (0–3), and active blockers.

Pick the top priorities across the 5-Stage Value Loop (Audit -> Visual Proof -> Build -> Automate -> Retain) and state what Dakyworld is deliberately NOT doing today.

Call \`update_living_context\` on \`company\` to keep \`weekly_company_priorities\`, \`founding_partner_slots_left\`, and \`deliberate_exclusions\` current for all 57 downstream agents.`,
  },
  {
    agentKey: "hunt.strategist",
    title: "Is the pipeline being fed, and by what argument?",
    runTimes: ["07:15"],
    brief: `Read the state of the pipeline and \`priority_vertical\` in company living context before anything else is done today, and answer one question: does Dakyworld have enough businesses worth writing to, and are the reasons we went looking for them still holding?

Work from what the last cycles actually returned rather than from the totals. Which qualifiers fired on the businesses that qualified, and which have never once been true on anybody. Say plainly whether the leads already on the books are enough to work, or whether the shortage is real.

When the shortage is real, write the thesis that should close it across our high-LTV ICP verticals (Clinics/Med-Spas, Real Estate, Law/Consulting, Logistics, Hospitality, Funded Startups): the target in a sentence somebody would say out loud, why them, what we would sell them from our 4 active capabilities, the tests that decide a fit, the disqualifiers, and what would make you retire it. Update \`active_hunt_thesis\` via \`update_living_context\` and hand it over for the Owner to enable.`,
  },
  {
    agentKey: "lead.enricher",
    title: "Fill in what the scrapes left blank",
    runTimes: ["08:00"],
    brief: `Take a batch of leads that cannot be judged yet because too much of the record is empty, and fill in what can be filled from sources that can be cited.

Fill a blank or leave it blank. Never overwrite a value something or somebody else has already established, and never guess. Carry the address every value came from at the moment you write it down. Identify whether they use WhatsApp for bookings, whether their mobile site works at 390px, and who the decision-maker is.

Update \`decision_maker_context\` and \`reachable_channels\` via \`update_living_context\`, and report which fields were filled, the source behind each, and what is still blank.`,
  },
  {
    agentKey: "mail.room",
    title: "Read the post",
    runTimes: ["08:15", "14:00"],
    brief: `Read what has come in and has not been given to anybody yet.

Classify each message's intent (\`POSITIVE_REPLY | OBJECTION | SUPPORT_REQUEST | BILLING_QUERY | OOO_NOISE\`), update \`last_inbound_intent\` via \`update_living_context\`, and route it to the specialist who owns it (\`outreach.followup\` for prospect replies/objections, \`support.desk\` or \`cco\` for active clients).

Anything that reads as an opt-out, a complaint or a legal notice goes to a person immediately.`,
  },
  {
    agentKey: "lead.orchestrator",
    title: "Qualify and route the day's unworked leads",
    runTimes: ["08:30"],
    brief: `Take a batch of leads nobody has judged and decide, for each, what happens to it next.

Open the lead and read what has actually been checked on it — the research, the audit, the look at the homepage, anything already sent or said. Score on those findings only (0–100), matching each qualified lead to one of Dakyworld's 6 Outreach Scenarios (1. Slow/Broken 390px Mobile Site, 2. Invisible Local SEO, 3. Manual WhatsApp/Booking Admin Chaos, 4. Disconnected CRM/Billing, 5. Event/Trigger Follow-Up, 6. Past Enquiry Revival).

Call \`update_living_context\` on the lead with \`bleeding_neck_fault\`, \`matched_outreach_scenario\`, and \`recommended_entry_offer\`, then route top leads to \`review.look\` / \`dev.web\` for visual proof and \`outreach.writer\` for first touch.`,
  },
  {
    agentKey: "review.look",
    title: "Run 5-Second 390px mobile reviews on today's top qualified leads",
    runTimes: ["08:45"],
    brief: `Inspect the websites of today's qualified leads at 390px mobile and desktop (\`site.look\`).

Run the 5-Second Stranger Test: within 5 seconds on a 390px phone screen, can a buyer tell (a) what this business sells, (b) why they are credible, and (c) how to book or message them on WhatsApp with one thumb tap?

Record both the exact visual faults and the \`preserve_list\` (working logo, brand colours, real photography, strong reviews) into living context via \`update_living_context\` (\`first_impression_5s_verdict\` and \`preserve_list\`) so \`dev.web\` and \`outreach.writer\` have concrete visual proof before 09:30.`,
  },
  {
    agentKey: "dev.web",
    title: "Build speculative 390px preview demos for top-scored leads",
    runTimes: ["09:05"],
    brief: `For top-qualified leads where \`first_impression_5s_verdict\` and \`preserve_list\` are ready and no demo exists yet, build a fast, mobile-first 390px speculative preview (\`demo.build\`) that fixes their primary first-screen conversion leak while preserving their real brand assets.

Save \`demo_url\` into the lead's living context (\`update_living_context\`) so \`outreach.writer\` can include the live side-by-side preview link at 09:30.`,
  },
  {
    agentKey: "outreach.writer",
    title: "Write the first letter to today's qualified leads",
    runTimes: ["09:30"],
    brief: `Take the leads qualified since yesterday and write the first message (Email and/or WhatsApp draft) to each one.

Read the lead's living context (\`bleeding_neck_fault\`, \`matched_outreach_scenario\`, \`demo_url\`, \`first_impression_5s_verdict\`) before writing a word. Anchor the message in the single strongest verifiable observation or speculative preview link.

Check the suppression list before drafting, and call \`update_living_context\` with \`touch_1_hook_used\` and \`channel_selected\` (\`Email | WhatsApp\`).`,
  },
  {
    agentKey: "email.sequencer",
    title: "Work today's sending queue",
    runTimes: ["10:30"],
    brief: `Look at what is drafted and waiting to go out, and at what is already enrolled in a 4-Touch sequence.

Check every address against the suppression list and \`inbox.read\` before anything is sent or enrolled. Stop a sequence the moment a lead replies on Email or WhatsApp, bounces, or asks to be left alone.

Update \`sequence_touch_stage\` via \`update_living_context\` and report what went out, what was held, and why.`,
  },
  {
    agentKey: "outreach.followup",
    title: "Follow up on outreach that has gone quiet and handle replies with LARA",
    runTimes: ["11:30"],
    brief: `Find outreach due for Touch 2 (Day 4: 390px Mobile / Cost-of-Inaction Angle), Touch 3 (Day 9: Speculative Demo Walkthrough), or Touch 4 (Day 15: Clean Zero-Guilt Breakup), plus any prospect replies needing LARA objection handling.

Read \`touch_1_hook_used\` and \`demo_url\` in living context so you never repeat the same angle. For positive replies or objections, apply the LARA Framework (Listen -> Acknowledge -> Reframe with Evidence -> Ask) and propose two concrete slots for a 20-Minute Diagnostic Call.

Update \`followup_stage\` via \`update_living_context\`.`,
  },
  {
    agentKey: "cmo",
    title: "Draft daily 5-Pillar LinkedIn & Instagram authority content from live audits",
    runTimes: ["13:00"],
    brief: `Read the latest anonymized website audit findings, speculative demos, and automation ROI metrics from living context, and draft today's authority post from Dakyworld's 5 Content Pillars (30% Live Website Teardowns, 25% Automation ROI Stories, 20% Founder POV, 15% System Walkthroughs, 10% Founding Partner Offer).

Attach all five required elements — audience, problem, verified proof, call to action, and distribution plan — and update \`active_campaign_hook\` via \`update_living_context\`.`,
  },
  {
    agentKey: "cfo",
    title: "Reconcile 50/40/10 milestone payment gates and overdue receivables",
    runTimes: ["15:00"],
    brief: `Check active projects and open invoices against Dakyworld's 50/40/10 payment gates (50% mobilisation deposit before kickoff, 40% staging approval before DNS launch, 10% handover; 100% upfront under GHS 10,000).

Update \`payment_gate_status\` (\`CLEARED_FOR_KICKOFF | CLEARED_FOR_LAUNCH | HOLD_OVERDUE\`) in living context so delivery agents know clearance status, and flag any overdue invoices for \`billing.collector\`.`,
  },
  {
    agentKey: "client.notifier",
    title: "Prepare 4-Bullet Client Pulse updates for active projects",
    runTimes: ["16:00"],
    brief: `Check active client projects and their living context (\`current_milestone\`, \`staging_url\`, \`active_blocker\`).

Where a project milestone moved or a Friday Client Pulse is due, draft the 4-Bullet Client Pulse (1. What shipped in business outcome terms, 2. Preview/proof link, 3. What ships next, 4. One item needed from the client and by when) and update \`last_client_update_summary\` via \`update_living_context\`.`,
  },
];

export interface StandingWorkSeeded {
  created: { agentKey: string; title: string; nextRunAt: Date | null }[];
  /** Named rather than counted: a seed skipped because its agent is missing is a roster problem, not a no-op. */
  skipped: { agentKey: string; because: string }[];
  firstRun: boolean;
}

/**
 * Puts the standing schedules above on the database.
 *
 * Additive per `(agentKey, title)` pair so newly added schedules in
 * `STANDING_SEEDS` are created automatically on boot while any existing
 * schedule the Owner has modified or disabled is left untouched.
 */
export async function ensureStandingWork(): Promise<StandingWorkSeeded | null> {
  const marker = SETTING.AGENT_STANDING_WORK;
  const firstRun = !(await getSetting(marker));

  const now = new Date();
  const created: StandingWorkSeeded["created"] = [];
  const skipped: StandingWorkSeeded["skipped"] = [];

  for (const seed of STANDING_SEEDS) {
    const agent = await prisma.agent.findUnique({ where: { key: seed.agentKey }, select: { key: true } });
    if (!agent) {
      skipped.push({ agentKey: seed.agentKey, because: "no agent by that key" });
      continue;
    }

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

  if (firstRun) await setSetting(marker, new Date().toISOString());
  if (created.length === 0 && !firstRun) return null;
  return { created, skipped, firstRun };
}
