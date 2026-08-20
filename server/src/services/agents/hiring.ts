import type { AgentDepartment, AgentHireRequest, HireRequestStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { SETTING, getSetting, setSetting } from "../../lib/settings.js";
import { listAllTools } from "../tools/catalogue.js";
import { sendSlackBlocks, slackConfigured, updateSlack } from "../../lib/slack.js";
import { appUrl } from "../emailSender.js";
import { appendToConversation } from "./checkpoint.js";

/**
 * How the workforce grows itself.
 *
 * Three things happen here, in this order, and keeping them separate is the
 * whole design:
 *
 * 1. **A gap is recorded.** An agent hits work outside its own craft, looks
 *    for somebody to hand it to, finds nobody, and says so. That is a demand
 *    signal and nothing more — `AgentGap`.
 * 2. **A hire is proposed.** The Agent Creator reads the gap, checks it is not
 *    already somebody's job, designs the agent, and files it — `AgentHireRequest`.
 * 3. **A hire is decided.** By a person clicking Approve in Slack, or by the
 *    standing policy when it is AUTO. Only this step writes to `Agent`.
 *
 * **No model ever writes to the `Agent` table.** The Agent Creator's tool
 * files a request; `applyHire()` below is the only thing that creates an
 * agent, and it is reached from a signed Slack interaction, an authenticated
 * API call, or the AUTO policy. That separation is not ceremony: an agent that
 * could create agents directly could grant itself any toolkit in the
 * catalogue by hiring a copy of itself with a wider one, and there is no
 * prompt wording that reliably prevents that.
 *
 * **Every hire lands the same way** — SUB_AGENT, autonomy 1, dry run on —
 * however it was approved. AUTO decides *who exists*. It never decides what
 * they may do.
 *
 * (This module and `services/tools/catalogue.ts` import each other. Every
 * reference across that boundary is inside a function body, never at module
 * scope, which is what makes the cycle harmless — keep it that way.)
 */

/** The one agent allowed to propose a hire. */
export const CREATOR_KEY = "people.recruiter";

/** Beyond this the Agent Creator is refused and told to escalate. */
const DEFAULT_MAX_CUSTOM = 25;
/** Rolling-day ceiling on hires, so a runaway loop stops at three not thirty. */
const DEFAULT_MAX_PER_DAY = 3;
/** How many proposals may be waiting at once before it must stop proposing. */
const MAX_PENDING = 5;
/** A card nobody answers is a re-ask, not a refusal. */
const EXPIRES_AFTER_HOURS = 72;

export type HirePolicy = "ASK" | "AUTO";

export class HireRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HireRefused";
  }
}

// --- The policy -------------------------------------------------------------

export async function hirePolicy(): Promise<HirePolicy> {
  const raw = (await getSetting(SETTING.AGENT_HIRE_POLICY))?.trim().toUpperCase();
  return raw === "AUTO" ? "AUTO" : "ASK";
}

/**
 * Changes the standing answer to "may the Agent Creator hire?".
 *
 * `changedBy` is recorded in the log rather than in a table: the setting is one
 * value and its history is the Slack channel it was flipped from, which is
 * where somebody would look anyway.
 */
export async function setHirePolicy(policy: HirePolicy, changedBy: string): Promise<HirePolicy> {
  await setSetting(SETTING.AGENT_HIRE_POLICY, policy);
  console.log(`[hiring] policy set to ${policy} by ${changedBy}`);
  return policy;
}

/**
 * A configured limit, or the shipped one.
 *
 * **Zero is a value, not an absence.** The obvious way to say "stop hiring
 * entirely" is to set the ceiling to zero, and the usual `parsed > 0` guard
 * turns that into the default — so somebody who has just switched hiring off
 * watches an agent get hired. Only a missing, unparseable or negative value
 * falls back.
 */
async function ceiling(key: string, fallback: number): Promise<number> {
  const parsed = Number.parseInt((await getSetting(key)) ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// --- Matching a need against what already exists ----------------------------

/** Words that carry no information about a craft. */
const STOPWORDS = new Set([
  "a", "an", "and", "the", "for", "with", "that", "this", "into", "from", "of", "to", "in", "on", "at", "by", "or",
  "who", "can", "able", "someone", "somebody", "agent", "specialist", "work", "working", "needs", "need", "job",
  "dakyworld", "client", "clients", "our", "their", "it", "is", "are", "be", "do", "does",
  // The second batch, added after a real false positive: a proposed Bookkeeper
  // was reported as overlapping the Forecast Analyst on the words
  // "what/against/month". None of those says anything about a craft.
  "what", "which", "when", "where", "against", "over", "under", "than", "then", "every", "all", "any", "own",
  "out", "off", "per", "has", "have", "was", "were", "been", "will", "would", "should", "must", "not", "but",
  "also", "such", "same", "other", "each", "both", "some", "most", "many", "much", "one", "two", "three",
  "make", "made", "get", "got", "give", "take", "keep", "kept", "say", "says", "said",
]);

/**
 * Cuts a phrase down to the words that mean something, lightly stemmed.
 *
 * Deliberately crude — "edit a video", "video editing" and "editor for videos"
 * have to land on the same tokens, and nothing subtler than trimming a few
 * suffixes is needed to get there. It is used to *warn*, never to refuse: the
 * cost of a false match is a sentence on a card somebody reads, and the cost
 * of a missed one is a duplicate agent somebody notices next week.
 */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
      .map((word) => word.replace(/(ing|ers|er|es|s)$/, ""))
      .filter((word) => word.length > 2),
  );
}

function similarity(a: Set<string>, b: Set<string>): { score: number; shared: string[] } {
  if (a.size === 0 || b.size === 0) return { score: 0, shared: [] };
  const shared = [...a].filter((word) => b.has(word));
  // Against the *smaller* set, not the union: "video" matching a five-skill
  // agent should not be diluted to nothing by the four skills it did not match.
  return { score: shared.length / Math.min(a.size, b.size), shared };
}

export interface Overlap {
  key: string;
  name: string;
  /** 0 to 1. Anything above 0.5 is usually the same job described twice. */
  score: number;
  shared: string[];
}

/**
 * Which existing agents already do some of this.
 *
 * The single most useful sentence on a hiring card. "This is 60% the Web
 * Developer" is what stops a roster becoming forty agents that each do a third
 * of somebody else's job — and it is a question a person can settle in two
 * seconds and a model reliably gets wrong, because a model reading its own
 * proposal is not a neutral judge of whether it was necessary.
 */
export async function findOverlaps(description: string, skills: string[] = []): Promise<Overlap[]> {
  const wanted = tokens([description, ...skills].join(" "));
  const agents = await prisma.agent.findMany({
    where: { status: { not: "RETIRED" } },
    select: { key: true, name: true, title: true, mission: true, skills: true },
  });

  return agents
    .map((agent) => {
      const { score, shared } = similarity(wanted, tokens([agent.title, agent.mission, ...agent.skills].join(" ")));
      return { key: agent.key, name: agent.name, score: Number(score.toFixed(2)), shared };
    })
    // **Both** conditions, and this was tuned against real proposals rather
    // than chosen. At `score >= 0.25` alone a proposed Bookkeeper was reported
    // as 27% the Proposal Writer — one word, "invoice", in common — and a
    // proposed Translator as 29% the Copywriter on "page" and "copy". A
    // warning that fires on coincidences is a warning nobody reads by the
    // third hire, which costs exactly the duplicate agent it exists to
    // prevent. At this threshold a genuine second Cold Lead Writer still
    // scores 85% and a second Video Editor 83%, so the signal survives the cut
    // with a great deal of room to spare. `tmp/overlapCheck.ts` holds both
    // halves of that: the duplicates that must warn and the honest new crafts
    // that must not.
    .filter((overlap) => overlap.shared.length >= 2 && overlap.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

export interface RosterMatch {
  key: string;
  name: string;
  title: string;
  mission: string;
  skills: string[];
  status: string;
  score: number;
  /** True when this agent reports to the one that asked — `delegate` works. */
  reportsToYou: boolean;
}

/**
 * "Who here can edit a video?"
 *
 * The question every agent needed to be able to ask and could not. Without it
 * `handOff` and `consult` are unusable — an agent cannot hand work to a key it
 * has never seen — and `needSkill` is unsafe, because an agent that cannot
 * look would report a gap for a craft that has been on the roster since March.
 *
 * Same tokeniser as the overlap check above, deliberately: the question "does
 * anybody already do this" is asked twice in this system — once by an agent
 * looking for help, once by the Agent Creator checking a hire is necessary —
 * and the two must not be able to disagree.
 */
export async function searchRoster(need: string, askingAgentKey?: string): Promise<RosterMatch[]> {
  const wanted = tokens(need);
  const agents = await prisma.agent.findMany({
    where: { status: { notIn: ["RETIRED"] } },
    select: { key: true, name: true, title: true, mission: true, skills: true, status: true, managerKey: true },
  });

  return agents
    .filter((agent) => agent.key !== askingAgentKey)
    .map((agent) => {
      const { score } = similarity(wanted, tokens([agent.title, agent.mission, ...agent.skills].join(" ")));
      return {
        key: agent.key,
        name: agent.name,
        title: agent.title,
        mission: agent.mission,
        skills: agent.skills,
        status: agent.status,
        score: Number(score.toFixed(2)),
        reportsToYou: Boolean(askingAgentKey && agent.managerKey === askingAgentKey),
      };
    })
    .filter((match) => match.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// --- Gaps -------------------------------------------------------------------

export interface GapInput {
  requestedByKey: string;
  taskId?: string | null;
  skillNeeded: string;
  reason: string;
}

export interface GapOutcome {
  gapId: string;
  /** True when this joined an existing gap rather than opening a new one. */
  joined: boolean;
  timesRequested: number;
  /** The Agent Creator's review task, when there is one to point at. */
  reviewTaskId: string | null;
  /** Set when the Agent Creator does not exist or is not switched on. */
  note: string | null;
}

/**
 * Files "nobody here can do this", or joins an existing one.
 *
 * **Joining rather than duplicating is the point.** One agent wanting a
 * bookkeeper is a bad reason to employ one; three agents on three different
 * jobs wanting one is a good reason, and that fact only exists if the second
 * and third requests land on the same row. `timesRequested` is what the Agent
 * Creator is actually shown, and what its prompt tells it to weigh.
 *
 * The same agent asking twice does not count twice — `requestedByKeys` is the
 * set, and the count is its size.
 */
export async function recordGap(input: GapInput): Promise<GapOutcome> {
  const skillNeeded = input.skillNeeded.trim().slice(0, 120);
  const wanted = tokens(skillNeeded);

  // Small set by construction — anything open is by definition unfilled work
  // somebody is still waiting on — so the match happens here rather than in a
  // query nobody could read.
  const open = await prisma.agentGap.findMany({
    where: { status: { in: ["OPEN", "IN_REVIEW"] } },
    orderBy: { createdAt: "asc" },
  });
  const existing = open.find((gap) => similarity(wanted, tokens(gap.skillNeeded)).score >= 0.5);

  let gap = existing;
  let joined = false;

  if (gap) {
    joined = true;
    const askers = new Set([...gap.requestedByKeys, gap.requestedByKey, input.requestedByKey]);
    gap = await prisma.agentGap.update({
      where: { id: gap.id },
      data: {
        requestedByKeys: [...askers],
        timesRequested: askers.size,
        // Kept as a running account rather than overwritten: the second
        // agent's reason is usually the one that shows it is a real craft
        // rather than one awkward task.
        reason: `${gap.reason}\n\n${input.requestedByKey}: ${input.reason.trim()}`.slice(0, 4000),
      },
    });
  } else {
    gap = await prisma.agentGap.create({
      data: {
        requestedByKey: input.requestedByKey,
        requestedByKeys: [input.requestedByKey],
        taskId: input.taskId ?? null,
        skillNeeded,
        reason: `${input.requestedByKey}: ${input.reason.trim()}`.slice(0, 4000),
      },
    });
  }

  const review = await ensureReviewTask(gap.id);
  return {
    gapId: gap.id,
    joined,
    timesRequested: gap.timesRequested,
    reviewTaskId: review.taskId,
    note: review.note,
  };
}

/**
 * Puts one review on the Agent Creator's queue for this gap, and only one.
 *
 * Deduped on the gap id held in the task's `input`, so a gap asked for three
 * times is one review with a count of three on it rather than three reviews of
 * the same question. A DRAFT Agent Creator still gets the task — it queues and
 * waits, which is exactly what a queue is for, and is how the Owner can see
 * what is waiting before switching the thing on.
 */
async function ensureReviewTask(gapId: string): Promise<{ taskId: string | null; note: string | null }> {
  const creator = await prisma.agent.findUnique({ where: { key: CREATOR_KEY } });
  if (!creator) {
    return { taskId: null, note: "There is no Agent Creator on this deployment, so the gap is recorded and nothing is reviewing it." };
  }
  if (creator.status === "RETIRED") {
    return { taskId: null, note: "The Agent Creator is retired, so the gap is recorded and waiting for a person." };
  }

  const live = await prisma.agentTask.findFirst({
    where: {
      agentKey: CREATOR_KEY,
      status: { in: ["QUEUED", "RUNNING", "BLOCKED", "NEEDS_APPROVAL"] },
      input: { path: ["gapId"], equals: gapId },
    },
    select: { id: true },
  });
  if (live) return { taskId: live.id, note: null };

  const gap = await prisma.agentGap.findUnique({ where: { id: gapId } });
  if (!gap) return { taskId: null, note: null };

  const task = await prisma.agentTask.create({
    data: {
      agentKey: CREATOR_KEY,
      title: `Does Dakyworld need somebody who can ${gap.skillNeeded}?`,
      brief: [
        `${gap.timesRequested} agent(s) have hit work needing this and found nobody on the roster to hand it to.`,
        "",
        `**What was needed:** ${gap.skillNeeded}`,
        `**Asked by:** ${[...new Set([gap.requestedByKey, ...gap.requestedByKeys])].join(", ")}`,
        "",
        "**In their words:**",
        gap.reason,
        "",
        "Decide whether this is a new agent or somebody's existing job. Check the roster first — the answer is often that an agent already exists and the one that asked did not know to look. If it is genuinely a new craft, design the agent and file it with `agent.hire`. If it is not, close the gap with `agent.closeGap` and say who should have taken it.",
      ].join("\n"),
      input: { gapId } as unknown as Prisma.InputJsonValue,
      origin: "EVENT",
      priority: 2,
    },
  });

  await prisma.agentGap.update({ where: { id: gapId }, data: { status: "IN_REVIEW" } });
  return {
    taskId: task.id,
    note: creator.status === "ACTIVE" ? null : `The Agent Creator is a ${creator.status.toLowerCase()}, so this waits until it is set to Active.`,
  };
}

/**
 * Catches gaps whose review was cancelled or deleted.
 *
 * `recordGap` raises the review at the moment the gap is filed, which covers
 * everything except the case where somebody cancels that task — and then the
 * gap sits IN_REVIEW with nothing reviewing it, for ever. Swept on the
 * housekeeping tick.
 */
export async function ensureGapReviews(): Promise<number> {
  const gaps = await prisma.agentGap.findMany({
    where: { status: { in: ["OPEN", "IN_REVIEW"] } },
    select: { id: true },
  });
  let raised = 0;
  for (const gap of gaps) {
    const before = await prisma.agentTask.count({
      where: {
        agentKey: CREATOR_KEY,
        status: { in: ["QUEUED", "RUNNING", "BLOCKED", "NEEDS_APPROVAL"] },
        input: { path: ["gapId"], equals: gap.id },
      },
    });
    if (before > 0) continue;
    const { taskId } = await ensureReviewTask(gap.id);
    if (taskId) raised += 1;
  }
  return raised;
}

/** The Agent Creator's review of this gap, if one is still open. */
async function reviewTaskFor(gapId: string): Promise<string | null> {
  const task = await prisma.agentTask.findFirst({
    where: { agentKey: CREATOR_KEY, input: { path: ["gapId"], equals: gapId } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return task?.id ?? null;
}

/** Closes a gap without hiring — the work was somebody's job all along. */
export async function closeGap(gapId: string, note: string, filledByKey?: string | null): Promise<boolean> {
  const gap = await prisma.agentGap.findUnique({ where: { id: gapId } });
  if (!gap || gap.status === "FILLED") return false;
  await prisma.agentGap.update({
    where: { id: gapId },
    data: { status: "DECLINED", note: note.slice(0, 1000), filledByKey: filledByKey ?? null },
  });
  if (gap.taskId && filledByKey) {
    await nudgeWaitingTask(
      gap.taskId,
      `The craft you said was missing is ${filledByKey}'s job — they already exist. Hand it to them with \`handOff\`, or ask them with \`consult\`.`,
    );
  }
  return true;
}

// --- Proposing a hire -------------------------------------------------------

export interface HireDesign {
  key: string;
  name: string;
  title: string;
  department: AgentDepartment;
  managerKey: string;
  mission: string;
  /** One sentence naming the single finished thing. The one-job test. */
  deliverable: string;
  skills: string[];
  kpis: string[];
  toolkit: string[];
  escalationPolicy: string;
  avatar?: string | null;
  prompt: Record<string, string>;
  rationale: string;
}

export interface ProposeContext {
  proposedByKey: string;
  taskId?: string | null;
  gapId?: string | null;
}

export interface ProposeOutcome {
  requestId: string;
  status: HireRequestStatus;
  policy: HirePolicy;
  /** Set when the policy was AUTO and the agent now exists. */
  createdAgentKey: string | null;
  overlaps: Overlap[];
  droppedTools: string[];
  /** What to tell the agent that proposed it, in plain words. */
  message: string;
}

/**
 * Files a design and lets the policy decide what happens to it.
 *
 * Everything that could make this a bad idea is checked *here* rather than at
 * approval time, so what reaches a person is a proposal that would work if
 * they said yes. The exception is the key collision, which is re-checked on
 * the way in to `applyHire` as well, because approval can happen days later.
 */
export async function proposeHire(design: HireDesign, ctx: ProposeContext): Promise<ProposeOutcome> {
  const key = design.key.trim().toLowerCase();
  if (!/^[a-z][a-z0-9.]{1,46}[a-z0-9]$/.test(key)) {
    throw new HireRefused(`“${design.key}” is not a usable key. Lowercase letters, numbers and dots, three to forty-eight characters — for example design.3d or finance.bookkeeper.`);
  }

  if (await prisma.agent.findUnique({ where: { key } })) {
    throw new HireRefused(`There is already an agent with the key ${key}. Read the roster before designing — this job may already be somebody's.`);
  }
  const clash = await prisma.agentHireRequest.findFirst({ where: { key, status: "PENDING" } });
  if (clash) throw new HireRefused(`${key} has already been proposed and is waiting on the Owner. Do not propose it twice.`);

  const manager = await prisma.agent.findUnique({ where: { key: design.managerKey } });
  if (!manager) throw new HireRefused(`There is no agent called ${design.managerKey} for this one to report to. Pick a manager from the roster.`);
  if (manager.status === "RETIRED") throw new HireRefused(`${manager.name} is retired and cannot take a report. Pick another manager.`);

  const pending = await prisma.agentHireRequest.count({ where: { status: "PENDING" } });
  if (pending >= MAX_PENDING) {
    throw new HireRefused(`${pending} hires are already waiting on the Owner. Nothing more is proposed until those are decided — say so and stop.`);
  }

  const maxCustom = await ceiling(SETTING.AGENT_MAX_CUSTOM, DEFAULT_MAX_CUSTOM);
  const custom = await prisma.agent.count({ where: { custom: true, status: { not: "RETIRED" } } });
  if (custom >= maxCustom) {
    throw new HireRefused(`The roster already holds ${custom} hired agents, which is the ceiling. Escalate rather than proposing another — either the ceiling should move or some of them should be retired.`);
  }

  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const maxPerDay = await ceiling(SETTING.AGENT_MAX_HIRES_PER_DAY, DEFAULT_MAX_PER_DAY);
  const today = await prisma.agentHireRequest.count({ where: { status: "APPROVED", decidedAt: { gte: since } } });
  if (today >= maxPerDay) {
    throw new HireRefused(`${today} agents have been hired in the last day, which is the limit. This one waits until tomorrow — say so and stop.`);
  }

  // A tool key that does not exist would be a silent hole in a new agent's
  // toolkit, so it is dropped here and named, rather than stored and puzzled
  // over on the day the agent cannot do its job.
  const known = new Set((await listAllTools()).map((tool) => tool.key));
  const toolkit = design.toolkit.map((entry) => entry.trim()).filter((entry) => known.has(entry));
  const droppedTools = design.toolkit.filter((entry) => !known.has(entry.trim()));

  const overlaps = await findOverlaps(`${design.title} ${design.mission} ${design.deliverable}`, design.skills);

  const policy = await hirePolicy();

  // Which task this was proposed on. The tool layer does not carry a task id in
  // its context, so rather than store a null that would make the column dead,
  // it is resolved from the gap: `ensureReviewTask` creates exactly one review
  // per gap, so that review *is* the task the proposal was made on. A hire
  // proposed without a gap behind it genuinely has no task, and stays null.
  const taskId = ctx.taskId ?? (ctx.gapId ? await reviewTaskFor(ctx.gapId) : null);

  const request = await prisma.agentHireRequest.create({
    data: {
      gapId: ctx.gapId ?? null,
      proposedByKey: ctx.proposedByKey,
      taskId,
      key,
      name: design.name.trim().slice(0, 80),
      title: design.title.trim().slice(0, 120),
      department: design.department,
      managerKey: design.managerKey,
      mission: design.mission.trim().slice(0, 600),
      deliverable: design.deliverable.trim().slice(0, 300),
      skills: design.skills.map((skill) => skill.slice(0, 80)).slice(0, 24),
      kpis: design.kpis.map((kpi) => kpi.slice(0, 120)).slice(0, 12),
      toolkit,
      escalationPolicy: design.escalationPolicy.trim().slice(0, 600),
      avatar: design.avatar?.slice(0, 4) ?? null,
      prompt: design.prompt as unknown as Prisma.InputJsonValue,
      rationale: design.rationale.trim().slice(0, 2000),
      overlaps: overlaps as unknown as Prisma.InputJsonValue,
      policy,
    },
  });

  if (policy === "AUTO") {
    const applied = await applyHire(request.id, { by: "the standing AUTO hiring policy" });
    return {
      requestId: request.id,
      status: "APPROVED",
      policy,
      createdAgentKey: applied.agentKey,
      overlaps,
      droppedTools,
      message: `Hired. ${request.name} (${applied.agentKey}) is on the roster now, at autonomy 1 with dry run on — it can prepare work and nothing it decides takes effect until a person raises that. The Owner has been told in Slack and can undo it there.`,
    };
  }

  const posted = await postHireCard(request.id);
  return {
    requestId: request.id,
    status: "PENDING",
    policy,
    createdAgentKey: null,
    overlaps,
    droppedTools,
    message: posted
      ? `Proposed. The design is in Slack for the Owner to approve or decline. Nothing exists yet — do not plan around ${request.name} until it is approved.`
      : `Proposed, and recorded in the app under Agents. Slack is not connected, so nobody has been notified — say in your summary that a person needs to look at it.`,
  };
}

// --- Deciding ---------------------------------------------------------------

export interface DecidedBy {
  userId?: string | null;
  slackUserId?: string | null;
  /** A sentence for the log when neither of the above applies. */
  by?: string;
  note?: string | null;
}

export interface ApplyOutcome {
  agentKey: string;
  requestId: string;
  gapId: string | null;
  /** The task that was waiting on this craft, if one was and it was resumed. */
  resumedTaskId: string | null;
}

/**
 * The only thing in this system that creates an agent.
 *
 * **Where it lands, and why it differs from the create route.** A hire made
 * here is ACTIVE at autonomy 1 with dry run on; `POST /agents` lands its
 * agents at DRAFT. That is not an inconsistency. Filling in a form is not by
 * itself a decision to employ somebody — the Owner may be drafting, and DRAFT
 * is where a draft belongs. Clicking Approve on a card that says *hire this*
 * is that decision, and making them then find the agent and switch it on turns
 * one decision into two, the second of which is invisible and gets forgotten.
 *
 * What both routes agree on completely: **autonomy 1, dry run on, always.**
 * Being employed and being handed the company card are different decisions,
 * and nothing in this file can make the second one.
 */
export async function applyHire(requestId: string, decided: DecidedBy & { by?: string }): Promise<ApplyOutcome> {
  const request = await prisma.agentHireRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new HireRefused("No such hire request.");
  if (request.status === "APPROVED" && request.createdAgentKey) {
    return { agentKey: request.createdAgentKey, requestId, gapId: request.gapId, resumedTaskId: null };
  }
  if (request.status !== "PENDING") throw new HireRefused(`That hire was already ${request.status.toLowerCase()}.`);

  // Re-checked rather than trusted from proposal time: approval can be days
  // later, and in between somebody may have created this key by hand.
  if (await prisma.agent.findUnique({ where: { key: request.key } })) {
    await prisma.agentHireRequest.update({
      where: { id: requestId },
      data: { status: "DECLINED", decidedAt: new Date(), decisionNote: `An agent with the key ${request.key} was created in the meantime.` },
    });
    throw new HireRefused(`An agent with the key ${request.key} already exists now, so this was not created.`);
  }

  const known = new Set((await listAllTools()).map((tool) => tool.key));
  const toolkit = request.toolkit.filter((entry) => known.has(entry));

  const agent = await prisma.agent.create({
    data: {
      key: request.key,
      name: request.name,
      title: request.title,
      tier: "SUB_AGENT",
      department: request.department,
      managerKey: request.managerKey,
      status: "ACTIVE",
      autonomyLevel: 1,
      dryRun: true,
      mission: request.mission,
      responsibilities: [],
      skills: request.skills,
      kpis: request.kpis,
      toolkit,
      escalationPolicy: request.escalationPolicy,
      avatar: request.avatar,
      prompt: request.prompt as unknown as Prisma.InputJsonValue,
      custom: true,
    },
  });

  await prisma.agentHireRequest.update({
    where: { id: requestId },
    data: {
      status: "APPROVED",
      decidedAt: new Date(),
      decidedById: decided.userId ?? null,
      decidedBySlackUser: decided.slackUserId ?? null,
      decisionNote: decided.note ?? decided.by ?? null,
      createdAgentKey: agent.key,
    },
  });

  let resumedTaskId: string | null = null;
  if (request.gapId) {
    const gap = await prisma.agentGap.update({
      where: { id: request.gapId },
      data: { status: "FILLED", filledByKey: agent.key, note: `${agent.name} was hired for this.` },
    });
    // The point of the whole loop: the task that stopped because nobody could
    // do this is told that somebody now can, and goes back in the queue. Left
    // out, a filled gap is a new agent nobody thinks to use and a blocked task
    // that stays blocked.
    if (gap.taskId) {
      const nudged = await nudgeWaitingTask(
        gap.taskId,
        `The craft you said was missing now exists. ${agent.name} (\`${agent.key}\`) has just been hired for it — ${agent.mission} Hand the work over with \`handOff\`, or ask them a question with \`consult\`, and carry on with your own part.`,
      );
      if (nudged) resumedTaskId = gap.taskId;
    }
  }

  console.log(`[hiring] ${agent.key} created — approved by ${decided.slackUserId ?? decided.userId ?? decided.by ?? "unknown"}`);
  await settleHireCard(requestId, decided.slackUserId ?? decided.userId ?? decided.by ?? null);
  return { agentKey: agent.key, requestId, gapId: request.gapId, resumedTaskId };
}

/**
 * Tells a task that stopped waiting on a craft that it can carry on.
 *
 * BLOCKED is the state a `needSkill` stop leaves behind, and it keeps its
 * checkpoint on purpose — so this appends to the conversation the agent will
 * rejoin as well as to the brief that stays on the record, exactly as
 * answering an escalation does. Anything not BLOCKED is left alone: a task
 * that failed or was cancelled is not waiting on this news.
 */
async function nudgeWaitingTask(taskId: string, news: string): Promise<boolean> {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { id: true, status: true, brief: true } });
  if (!task || task.status !== "BLOCKED") return false;

  await appendToConversation(taskId, news);
  await prisma.agentTask.update({
    where: { id: taskId },
    data: {
      status: "QUEUED",
      brief: `${task.brief}\n\n--- Since you stopped ---\n${news}`.slice(0, 8000),
      blockedReason: null,
      finishedAt: null,
      startedAt: null,
      runOwner: null,
      interruptRequested: false,
    },
  });
  return true;
}

export async function declineHire(requestId: string, decided: DecidedBy): Promise<AgentHireRequest> {
  const request = await prisma.agentHireRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new HireRefused("No such hire request.");
  if (request.status !== "PENDING") throw new HireRefused(`That hire was already ${request.status.toLowerCase()}.`);

  const updated = await prisma.agentHireRequest.update({
    where: { id: requestId },
    data: {
      status: "DECLINED",
      decidedAt: new Date(),
      decidedById: decided.userId ?? null,
      decidedBySlackUser: decided.slackUserId ?? null,
      decisionNote: decided.note ?? null,
    },
  });

  // The gap goes back to OPEN rather than DECLINED: what was refused is this
  // design, and the work that exposed the gap has not gone anywhere. Declining
  // the *need* is a separate action — `agent.closeGap`.
  if (request.gapId) {
    await prisma.agentGap.updateMany({
      where: { id: request.gapId, status: "IN_REVIEW" },
      data: { status: "OPEN", note: `A proposed ${request.name} was declined.${decided.note ? ` ${decided.note}` : ""}`.slice(0, 1000) },
    });
  }

  await settleHireCard(requestId, decided.slackUserId ?? decided.userId ?? null);
  return updated;
}

/**
 * Undoes an approval — the button that makes AUTO safe to leave switched on.
 *
 * The agent is retired rather than deleted. It may already have taken a task,
 * written a memory or made a tool call, and deleting the row would take the
 * record of that with it; RETIRED stops it working, which is the thing that
 * was actually wanted.
 */
export async function withdrawHire(requestId: string, decided: DecidedBy): Promise<{ retiredKey: string | null }> {
  const request = await prisma.agentHireRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new HireRefused("No such hire request.");
  if (request.status !== "APPROVED" || !request.createdAgentKey) {
    throw new HireRefused("That hire was never approved, so there is nothing to undo.");
  }

  await prisma.agent.updateMany({ where: { key: request.createdAgentKey }, data: { status: "RETIRED" } });
  await prisma.agentHireRequest.update({
    where: { id: requestId },
    data: {
      status: "WITHDRAWN",
      decidedAt: new Date(),
      decidedBySlackUser: decided.slackUserId ?? null,
      decidedById: decided.userId ?? null,
      decisionNote: decided.note ?? "Undone after being approved.",
    },
  });
  if (request.gapId) {
    await prisma.agentGap.updateMany({ where: { id: request.gapId }, data: { status: "OPEN", filledByKey: null } });
  }

  await settleHireCard(requestId, decided.slackUserId ?? decided.userId ?? null);
  return { retiredKey: request.createdAgentKey };
}

/**
 * A card nobody answered is a re-ask, not a refusal.
 *
 * Expiring rather than leaving it PENDING for ever matters because PENDING is
 * counted: five forgotten proposals would stop the Agent Creator proposing
 * anything at all, and the reason would be invisible.
 */
export async function expireStaleHireRequests(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EXPIRES_AFTER_HOURS * 60 * 60_000);
  const stale = await prisma.agentHireRequest.findMany({
    where: { status: "PENDING", createdAt: { lt: cutoff } },
    select: { id: true, gapId: true },
  });
  for (const request of stale) {
    await prisma.agentHireRequest.update({
      where: { id: request.id },
      data: { status: "EXPIRED", decidedAt: now, decisionNote: `Nobody answered within ${EXPIRES_AFTER_HOURS} hours.` },
    });
    if (request.gapId) {
      await prisma.agentGap.updateMany({ where: { id: request.gapId, status: "IN_REVIEW" }, data: { status: "OPEN" } });
    }
    await settleHireCard(request.id, null);
  }
  return stale.length;
}

// --- The Slack card ---------------------------------------------------------

const ACTION = {
  approve: "hire_approve",
  decline: "hire_decline",
  undo: "hire_undo",
  policyAuto: "hiring_policy_auto",
  policyAsk: "hiring_policy_ask",
} as const;

export const HIRE_ACTIONS = ACTION;

function button(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return {
    type: "button",
    text: { type: "plain_text", text, emoji: true },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

/**
 * The card, in whichever of its states it is in.
 *
 * One builder for all of them so an approved hire's message becomes a record
 * of what was decided rather than a live Approve button under a settled
 * question — which is the failure mode of every "post an alert with buttons"
 * integration that never learns to edit what it posted.
 */
async function hireBlocks(request: AgentHireRequest, decidedBy: string | null): Promise<{ text: string; blocks: unknown[] }> {
  const overlaps = (request.overlaps ?? []) as unknown as Overlap[];
  const base = await appUrl();
  const spendingTools = await spendingIn(request.toolkit);

  const headline =
    request.status === "PENDING"
      ? request.policy === "AUTO"
        ? `New agent hired — ${request.name}`
        : `New agent proposed — ${request.name}`
      : request.status === "APPROVED"
        ? `Hired — ${request.name}`
        : request.status === "WITHDRAWN"
          ? `Undone — ${request.name} retired`
          : request.status === "EXPIRED"
            ? `Expired — ${request.name}`
            : `Declined — ${request.name}`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: headline.slice(0, 150), emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${request.title}* · \`${request.key}\`\n${request.mission}\n\n*Produces:* ${request.deliverable}`.slice(0, 3000),
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Department*\n${request.department}` },
        { type: "mrkdwn", text: `*Reports to*\n\`${request.managerKey}\`` },
        { type: "mrkdwn", text: `*Skills*\n${request.skills.slice(0, 6).join(", ") || "—"}` },
        { type: "mrkdwn", text: `*Tools*\n${request.toolkit.length ? request.toolkit.join(", ") : "none"}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*Why a new agent rather than existing work*\n${request.rationale}`.slice(0, 3000) } },
  ];

  if (overlaps.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *This overlaps agents you already have*\n${overlaps
          .map((overlap) => `• ${overlap.name} (\`${overlap.key}\`) — ${Math.round(overlap.score * 100)}% on ${overlap.shared.slice(0, 4).join(", ")}`)
          .join("\n")}`,
      },
    });
  }

  if (spendingTools.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:coin: *Asks for tools that cost money or leave the building:* ${spendingTools.join(", ")}. It lands in dry run, so none of them act until you raise its autonomy.` },
    });
  }

  if (request.status === "PENDING" && request.policy === "ASK") {
    blocks.push({
      type: "actions",
      elements: [
        button("Approve", ACTION.approve, request.id, "primary"),
        button("Decline", ACTION.decline, request.id, "danger"),
        button("Approve these automatically from now on", ACTION.policyAuto, request.id),
      ],
    });
  } else if (request.status === "APPROVED") {
    blocks.push({
      type: "actions",
      elements: [
        button("Undo — retire it", ACTION.undo, request.id, "danger"),
        ...(request.policy === "AUTO" ? [button("Ask me first from now on", ACTION.policyAsk, request.id)] : []),
      ],
    });
  }

  const settled =
    request.status === "PENDING"
      ? request.policy === "AUTO"
        ? "Hired automatically · autonomy 1, dry run on — nothing it decides takes effect"
        : "Lands at autonomy 1 with dry run on — approving employs it, it does not hand it the card"
      : `${request.status.toLowerCase()}${decidedBy ? ` by ${decidedBy}` : ""}${request.decisionNote ? ` — ${request.decisionNote}` : ""}`;

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Proposed by \`${request.proposedByKey}\` · ${settled} · <${base}/agents|Open the roster>` }],
  });

  return { text: `${headline} — ${request.mission}`.slice(0, 300), blocks };
}

/** Which of these tools spend money or are visible outside the company. */
async function spendingIn(toolkit: string[]): Promise<string[]> {
  if (toolkit.length === 0) return [];
  const catalogue = await listAllTools();
  return catalogue.filter((tool) => toolkit.includes(tool.key) && (tool.spends || tool.outward)).map((tool) => tool.key);
}

/** Posts the card and remembers where, so the same message can be settled later. */
async function postHireCard(requestId: string): Promise<boolean> {
  const request = await prisma.agentHireRequest.findUnique({ where: { id: requestId } });
  if (!request) return false;
  if (!(await slackConfigured())) return false;

  try {
    const { text, blocks } = await hireBlocks(request, null);
    const result = await sendSlackBlocks({ text, blocks });
    if (result.delivered && result.ts && result.channel) {
      await prisma.agentHireRequest.update({ where: { id: requestId }, data: { slackChannel: result.channel, slackTs: result.ts } });
    }
    return result.delivered;
  } catch (err) {
    // A card that could not be posted must not stop the request existing — it
    // is in the app either way, and "Slack is down" is not "no hire was
    // proposed".
    console.error("[hiring] could not post the hire card:", (err as Error).message);
    return false;
  }
}

/**
 * Rewrites a decided card so nobody clicks Approve on a settled question.
 *
 * On a webhook-only Slack there is nothing to rewrite — a webhook cannot edit
 * what it posted — so the outcome is posted as a fresh message instead. Both
 * paths are best-effort: the decision has already been recorded, and Slack
 * failing afterwards must not undo it.
 */
async function settleHireCard(requestId: string, decidedBy: string | null): Promise<void> {
  const request = await prisma.agentHireRequest.findUnique({ where: { id: requestId } });
  if (!request) return;
  if (!(await slackConfigured())) return;

  try {
    const { text, blocks } = await hireBlocks(request, decidedBy);
    if (request.slackChannel && request.slackTs && (await updateSlack(request.slackChannel, request.slackTs, { text, blocks }))) return;
    await sendSlackBlocks({ text, blocks });
  } catch (err) {
    console.error("[hiring] could not update the hire card:", (err as Error).message);
  }
}

// --- Reading ----------------------------------------------------------------

export async function openGaps() {
  return prisma.agentGap.findMany({
    where: { status: { in: ["OPEN", "IN_REVIEW"] } },
    orderBy: [{ timesRequested: "desc" }, { createdAt: "asc" }],
    take: 50,
  });
}

export async function listHireRequests(status?: HireRequestStatus) {
  return prisma.agentHireRequest.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}
