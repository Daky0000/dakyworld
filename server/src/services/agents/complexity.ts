import type { Agent, AgentTask, AgentTaskStatus } from "@prisma/client";
import type { Effort } from "../../lib/claude.js";
import { callModel } from "../../lib/models/call.js";
import { TASK_LEVELS, effortForLevel, isTaskLevel, providerConfigured, type TaskLevel } from "../../lib/models/registry.js";
import { prisma } from "../../lib/prisma.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { check, scopesForAgent } from "../budgets.js";
import type { ToolScope } from "../tools/types.js";
import type { FailureClass } from "./runner.js";

/**
 * How demanding a task is, decided between the task and the agent.
 *
 * The agent loop picks its paid model from a level — simple, standard or
 * complex — and this file is what decides it. It used to be decided by **who
 * the agent was**: the board, the executives and anybody writing to a stranger
 * got Claude's headline model, everyone else the economy one, whatever the
 * task. So a director filing a one-line reminder paid the top rate and a
 * sub-agent handed a genuinely hard investigation got the middle one.
 *
 * The answer is reached in four stages, and the first that answers wins:
 *
 * 0. **Fixed answers.** The Owner's own call on this task; the level a resumed
 *    conversation already had (one conversation is not split across two
 *    judgements, and a model change costs a cache miss); and the retry ladder
 *    after a run that failed outright — the same model thinking harder first,
 *    a stronger model only when that has failed too.
 * 1. **The rules.** `scoreTask` — free, instant, and a pure function so a check
 *    can hold it still.
 * 2. **A quick look**, only for a task that scores on a boundary. One call on a
 *    small free model, clamped to within one level of what the rules said, and
 *    ignored entirely if it fails or is slow. Sizing a task must never be the
 *    reason it did not run.
 * 3. **The budget.** A spend ceiling in its downgrade band holds the level at
 *    standard, as it used to hold the effort at medium.
 *
 * **Free models still serve first.** The level decides which paid model takes
 * over when three free ones could not, and how hard every model thinks.
 */

/** How the level is decided. See `SETTING.AGENT_ROUTING`. */
export type RoutingMode = "off" | "rules" | "full";

export const ROUTING_MODES: RoutingMode[] = ["off", "rules", "full"];

/**
 * Unset is `full`, which is the founder's call (9 Oct 2026): the rules first,
 * and a free model for the tasks they cannot place. Anything unreadable is also
 * `full` rather than `off`, because a typo in a settings row is not a decision
 * to go back to paying the top rate for everything.
 */
export async function routingMode(): Promise<RoutingMode> {
  const raw = (await getSetting(SETTING.AGENT_ROUTING))?.trim().toLowerCase();
  return raw === "off" || raw === "rules" ? raw : "full";
}

// --- The old answer, kept for `off` -----------------------------------------

/**
 * The agents whose entire output is a piece of writing somebody outside the
 * company reads.
 *
 * This list used to be a **floor**: everything these agents did ran on the top
 * model, because drafts written at the cheaper setting read alike and a
 * stranger judges the company by them. On 9 Oct 2026 the founder chose to let
 * the level decide instead — a forty-word follow-up can be a simple task — so
 * the list is now one signal among several in `scoreTask`. If outreach starts
 * reading generic again, `OUTSIDE_WRITING_FLOOR` puts the floor back in one line.
 */
export const WRITES_FOR_OUTSIDE = new Set([
  "outreach.writer",
  "outreach.followup",
  "proposal.writer",
  "content.writer",
  "content.casestudy",
  "careplan.reporter",
  "client.notifier",
  "billing.collector",
  "delivery.handover",
  "review.look",
  "design.ux",
  "ads.designer",
]);

/**
 * The lowest level writing for outside may run at. `null` is no floor.
 *
 * Shipped as `null` on the founder's instruction. `"standard"` is the setting
 * to reach for if cold email and proposals start reading generic again.
 */
export const OUTSIDE_WRITING_FLOOR: TaskLevel | null = null;

/**
 * The effort an agent got before levels existed: high for a judgement (the
 * management tiers) and for writing that leaves the building, medium for
 * everything else. What `off` runs on, so switching sizing off puts every
 * model back exactly where it was.
 */
export function legacyEffort(agent: Pick<Agent, "tier" | "key">): "low" | "medium" | "high" {
  if (agent.tier === "BOARD" || agent.tier === "EXECUTIVE") return "high";
  return WRITES_FOR_OUTSIDE.has(agent.key) ? "high" : "medium";
}

/**
 * Whether the spend ceilings this agent sits under want the work done more
 * cheaply. True in the downgrade and approve bands — the same two that used to
 * talk `high` down to `medium`.
 */
async function budgetWantsCheaper(agentKey: string): Promise<boolean> {
  const budget = await check(scopesForAgent(agentKey));
  return budget.action === "downgrade" || budget.action === "approve";
}

// --- The rules ---------------------------------------------------------------

/**
 * Tools whose use is a piece of judgement or a build, rather than a lookup or
 * a status change. A task that looks like it needs one is rarely simple.
 */
const HEAVY_TOOLS = new Set([
  "proposal.draft",
  "design.brief",
  "web.page",
  "demo.build",
  "audit.website",
  "company.audit",
  "code.propose",
  "code.merge",
  "repo.create",
  "agent.hire",
  "video.plan",
  "ad.concept",
  "security.scan",
]);

/**
 * Words that mean a task is open-ended, weighed or long.
 *
 * `plan` is matched only where it is not "care plan", which is a product here
 * and turns up in plenty of briefs that are a status check.
 */
const HARDER_WORDS: Array<{ pattern: RegExp; word: string }> = [
  { pattern: /\banaly[sz](?:e|is|ing)\b/i, word: "analyse" },
  { pattern: /\bstrateg(?:y|ic|ies)\b/i, word: "strategy" },
  { pattern: /(?<!care\s)\bplan(?:s|ning)?\b/i, word: "plan" },
  { pattern: /\baudit(?:s|ing)?\b/i, word: "audit" },
  { pattern: /\bcompar(?:e|ing|ison)\b/i, word: "compare" },
  { pattern: /\b(?:decide|decision)\b/i, word: "decide" },
  { pattern: /\binvestigat(?:e|ion|ing)\b/i, word: "investigate" },
  { pattern: /\bredesign\b/i, word: "redesign" },
  { pattern: /\bnegotiat(?:e|ion|ing)\b/i, word: "negotiate" },
  { pattern: /\bwhy\b/i, word: "why" },
  { pattern: /\b(?:evaluate|assess(?:ment)?)\b/i, word: "assess" },
  { pattern: /\bdiagnos(?:e|is)\b/i, word: "diagnose" },
  { pattern: /\bprioriti[sz]e\b/i, word: "prioritise" },
];

/** Words that mean a task is routine: one step, a short answer, a record moved. */
const EASIER_WORDS: Array<{ pattern: RegExp; word: string }> = [
  { pattern: /\bsummari[sz](?:e|ing)\b/i, word: "summarise" },
  { pattern: /\bclassif(?:y|ication)\b/i, word: "classify" },
  { pattern: /\btag(?:s|ging)?\b/i, word: "tag" },
  { pattern: /\bcheck(?:s|ing)?\b/i, word: "check" },
  { pattern: /\bupdate\b/i, word: "update" },
  { pattern: /\bremind(?:er)?\b/i, word: "remind" },
  { pattern: /\blist\b/i, word: "list" },
  { pattern: /\blook\s?up\b/i, word: "look up" },
  { pattern: /\b(?:notify|forward|confirm)\b/i, word: "notify" },
  { pattern: /\bmark\s+(?:as|it)\b/i, word: "mark as" },
];

/** Everything the rules read. Plain data, so a check can build one by hand. */
export interface TaskFacts {
  title: string;
  brief: string;
  /** Characters of supplied context beyond the brief — `AgentTask.input` as JSON. */
  inputChars: number;
  origin: AgentTask["origin"];
  agentKey: string;
  agentTier: Agent["tier"];
  /** The catalogue tools this agent holds. */
  toolkit: Array<{ key: string; scope: ToolScope | string }>;
  /** The tools the brief's own words point at — `likelyTools` in the runner. */
  likely: string[];
  linked: { lead: boolean; client: boolean; project: boolean; proposal: boolean; invoice: boolean };
  /**
   * One orchestrator with skills, rather than a roster of agents. Changes what
   * the rules read — see `scoreTask`. Absent is the roster, so a caller that
   * knows nothing about modes scores exactly as it always did.
   */
  oneAgent?: boolean;
  /** How many earlier pieces of work this task waited for and was handed the results of. */
  builtOn?: number;
}

export interface Score {
  score: number;
  /** Each signal that moved the score, in words. */
  reasons: string[];
}

const TIER_WEIGHT: Record<Agent["tier"], number> = {
  BOARD: 3,
  EXECUTIVE: 3,
  FUNCTIONAL: 1,
  OPERATIONAL: 0,
  SUB_AGENT: -1,
};

/**
 * What a skill's kind is worth under one orchestrator.
 *
 * The roster's weights above grade **rank**: three points for being an
 * executive, which is the difference between low strength and high, awarded
 * before a word of the task is read. A status check given to the Chief
 * Executive ran on the top model, and a proposal written by a specialist
 * started a point down. The sizing prompt has always said "judge the task, not
 * the agent's seniority"; the rules did the opposite.
 *
 * With one agent there is no seniority to grade. What is left, and is real, is
 * the *kind of output*: a board or executive skill produces a decision, where
 * being wrong is expensive and nothing checks it; a risk or people skill
 * produces a review. Those keep a smaller weight. A specialist's deliverable
 * starts level — its difficulty is in the brief and the tools, which the rest
 * of the rules read.
 */
const KIND_WEIGHT: Record<Agent["tier"], { points: number; why: string }> = {
  BOARD: { points: 2, why: "its output is a decision" },
  EXECUTIVE: { points: 2, why: "its output is a decision" },
  FUNCTIONAL: { points: 1, why: "its output is a review" },
  OPERATIONAL: { points: 0, why: "" },
  SUB_AGENT: { points: 0, why: "" },
};

/** The hand-over block `waiting.ts` adds to a brief. Ours, not the task's: not counted as steps of the work. */
const HANDED_OVER = "EARLIER WORK THIS TASK WAITED FOR";

/**
 * How many pieces of work a brief asks for, in order.
 *
 * A numbered or bulleted list of what to do, or the words a person uses to
 * string steps together. One sentence asking for one thing is one. Counted
 * because a task with four ordered steps fails differently from a task with
 * one: the model has to hold the plan across turns, and a small model drops
 * step three.
 */
export function partsIn(text: string): number {
  const own = text.split(HANDED_OVER)[0] ?? text;
  const listed = (own.match(/^[ \t]*(?:\d{1,2}[.)]|[-*•])[ \t]+\S/gm) ?? []).length;
  const strung = (own.match(/\b(?:and then|then|after that|afterwards|once (?:that|this|it) is done|finally|lastly)\b/gi) ?? []).length;
  return Math.max(listed, strung > 0 ? strung + 1 : 1);
}

/**
 * The rules' score for one task. Higher is harder.
 *
 * Every weight is here and nowhere else, so tuning the router is editing this
 * function and re-running `checks/taskRouting.ts`. Calibrated against the
 * shapes the workforce actually produces: a sub-agent's delegated lookup lands
 * well below zero, an owner's request to a specialist around two, and an
 * executive weighing a strategy above four.
 */
export function scoreTask(facts: TaskFacts): Score {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, why: string) => {
    if (points === 0) return;
    score += points;
    reasons.push(`${why} (${points > 0 ? "+" : ""}${points})`);
  };

  const oneAgent = facts.oneAgent === true;
  if (oneAgent) {
    const kind = KIND_WEIGHT[facts.agentTier];
    if (kind) add(kind.points, kind.why);
  } else {
    add(TIER_WEIGHT[facts.agentTier] ?? 0, `a ${facts.agentTier.toLowerCase().replace("_", "-")} agent`);
  }

  if (facts.origin === "SCHEDULE") add(-1, "routine standing work");
  // On the roster a delegated task was a manager handing down a slice. Under
  // one orchestrator a sub-task is where the deliverable is actually made —
  // the letter, the proposal, the audit — and a point off for being one sent
  // exactly that work to the small model.
  if (facts.origin === "AGENT" && !oneAgent) add(-1, "a slice of a colleague's task");

  const scopes = new Map(facts.toolkit.map((tool) => [tool.key, tool.scope]));
  const heavy = facts.likely.find((key) => HEAVY_TOOLS.has(key));
  if (heavy) {
    add(2, `looks like it needs ${heavy}`);
  } else if (facts.likely.length > 0 && facts.likely.every((key) => scopes.get(key) === "read")) {
    add(-1, "looks like reading only");
  }
  if (facts.toolkit.length > 12) add(1, "a wide toolkit");

  const words = `${facts.title}\n${facts.brief}`;
  const size = words.length + facts.inputChars;
  if (size < 400) add(-1, "a short brief");
  else if (size > 6000) add(2, "a very long brief");
  else if (size > 2500) add(1, "a long brief");

  const harder = HARDER_WORDS.filter((entry) => entry.pattern.test(words)).map((entry) => entry.word);
  if (harder.length > 0) add(Math.min(2, harder.length), `asks to ${harder.slice(0, 3).join(", ")}`);
  const easier = EASIER_WORDS.filter((entry) => entry.pattern.test(words)).map((entry) => entry.word);
  if (easier.length > 0) add(-Math.min(2, easier.length), `asks to ${easier.slice(0, 3).join(", ")}`);

  if (WRITES_FOR_OUTSIDE.has(facts.agentKey)) add(1, "writes for someone outside the company");

  const linkedCount = Object.values(facts.linked).filter(Boolean).length;
  if (facts.linked.proposal || facts.linked.project || linkedCount >= 2) add(1, "tied to a proposal, a project or several records");

  // Three things about the work itself, read only under one orchestrator so
  // the roster's scores are exactly what they were.
  if (oneAgent) {
    const parts = partsIn(words);
    if (parts >= 3) add(1, `${parts} steps in order`);

    if ((facts.builtOn ?? 0) > 0) add(1, `builds on ${facts.builtOn} earlier piece${facts.builtOn === 1 ? "" : "s"} of work`);

    // What it would cost to get wrong. A call that sends or charges cannot be
    // taken back, whichever skill makes it; the roster knew this only as a
    // list of agents' names (`WRITES_FOR_OUTSIDE`, counted above).
    const irreversible = facts.likely.find((key) => scopes.get(key) === "send" || scopes.get(key) === "charge");
    if (irreversible && !WRITES_FOR_OUTSIDE.has(facts.agentKey)) add(1, `looks like it needs ${irreversible}, which sends or charges`);
  }

  return { score, reasons };
}

/**
 * Score to level: below zero is simple, four and above is complex.
 *
 * **A task with nothing to say about it is standard**, not simple — the same
 * call `JOBS` makes about a job with no tier: work nobody has thought about
 * should cost a little too much rather than quietly be done badly. A task has
 * to look easy, not merely fail to look hard, to reach the small model.
 */
export function levelForScore(score: number): TaskLevel {
  if (score < 0) return "simple";
  if (score >= 4) return "complex";
  return "standard";
}

/**
 * True for a score one step either side of a boundary — the tasks the rules
 * cannot place with confidence, and the only ones worth a model's opinion.
 */
export function isUnclear(score: number): boolean {
  return score === -1 || score === 0 || score === 3 || score === 4;
}

/** One level up, stopping at complex. */
export function stepUp(level: TaskLevel): TaskLevel {
  return TASK_LEVELS[Math.min(TASK_LEVELS.indexOf(level) + 1, TASK_LEVELS.length - 1)];
}

/** Every effort the loop can ask for, least first. */
export const EFFORT_LADDER: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** `steps` rungs up the effort ladder, stopping at max. */
export function raiseEffort(effort: Effort, steps = 1): Effort {
  const at = Math.max(0, EFFORT_LADDER.indexOf(effort));
  return EFFORT_LADDER[Math.min(at + Math.max(0, steps), EFFORT_LADDER.length - 1)];
}

/**
 * Who can fail a task without it being the model's fault.
 *
 * The reaper and the boot pass fail a task that kept dying without getting
 * any further — a crash loop, a deploy storm, a process killed for memory.
 * None of that is evidence the model was not up to the work, so none of it
 * buys a harder-thinking or a dearer retry.
 */
export const NOT_THE_MODELS_FAULT: ReadonlySet<string> = new Set(["reaper", "boot"]);

/** `level`, held to within one step of `around`. */
export function clampLevel(level: TaskLevel, around: TaskLevel): TaskLevel {
  const at = TASK_LEVELS.indexOf(around);
  const wanted = TASK_LEVELS.indexOf(level);
  return TASK_LEVELS[Math.max(at - 1, Math.min(at + 1, wanted))];
}

function atMost(level: TaskLevel, ceiling: TaskLevel): TaskLevel {
  return TASK_LEVELS.indexOf(level) > TASK_LEVELS.indexOf(ceiling) ? ceiling : level;
}

function atLeast(level: TaskLevel, floor: TaskLevel): TaskLevel {
  return TASK_LEVELS.indexOf(level) < TASK_LEVELS.indexOf(floor) ? floor : level;
}

// --- The database's spelling ------------------------------------------------

export type StoredLevel = "SIMPLE" | "STANDARD" | "COMPLEX";

export function toStored(level: TaskLevel): StoredLevel {
  return level.toUpperCase() as StoredLevel;
}

export function fromStored(value: string | null | undefined): TaskLevel | null {
  const lower = value?.toLowerCase();
  return isTaskLevel(lower) ? lower : null;
}

// --- The quick look ----------------------------------------------------------

/** Longer than this and the rules' answer stands. A person's task is waiting. */
export const LOOK_TIMEOUT_MS = 15_000;

const SIZING_SYSTEM = `You size work for a company's AI workforce before it starts, so it is done on a model worth what it costs.

Answer with one of three levels:
- simple: routine and short. A lookup, a status change, a reminder, a short note, filing or tagging something, a summary of something already in front of the agent. One or two steps.
- standard: an ordinary piece of work. Several steps, a normal letter or report, a judgement with clear inputs.
- complex: open-ended or high-stakes. Strategy, weighing conflicting evidence, a long careful document, a build, a decision that is expensive to get wrong, many steps where the order matters.

Judge the task, not the agent's seniority. When in doubt between two levels, choose the lower one only if a mistake would be cheap to fix.`;

const SIZING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["level", "reason"],
  properties: {
    level: { type: "string", enum: ["simple", "standard", "complex"], description: "How demanding the task is." },
    reason: { type: "string", description: "One sentence, under 25 words, naming what about the task decided it." },
  },
} as const;

/**
 * One free model's opinion of a task the rules could not place.
 *
 * Null for anything other than a usable answer — a slow model, a failed call,
 * a reply outside the three levels. The caller keeps the rules' answer then,
 * which is the whole safety story: this can make the level better and can
 * never stop a task.
 *
 * **Free models only.** NVIDIA is named rather than routed to, and a named
 * vendor is never routed around — so a busy free tier ends here with the rules'
 * answer instead of quietly paying Claude to decide how much to pay Claude.
 * With no NVIDIA key it is not asked at all.
 */
export async function lookAtTask(
  agent: Pick<Agent, "key" | "name" | "title">,
  facts: TaskFacts,
  timeoutMs = LOOK_TIMEOUT_MS,
): Promise<{ level: TaskLevel; reason: string } | null> {
  if (!(await providerConfigured("nvidia").catch(() => false))) return null;
  const asking = callModel<{ level: string; reason: string }>({
    purpose: `routing.${agent.key}`,
    job: "routing",
    provider: "nvidia",
    system: SIZING_SYSTEM,
    prompt: () =>
      [
        `AGENT: ${agent.name}, ${agent.title}.`,
        facts.likely.length > 0 ? `TOOLS THE BRIEF POINTS AT: ${facts.likely.join(", ")}.` : "",
        `TASK: ${facts.title}`,
        "",
        facts.brief.slice(0, 2000),
        facts.inputChars > 0 ? `\n(Plus ${facts.inputChars} characters of supplied context.)` : "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    schema: SIZING_SCHEMA as unknown as Record<string, unknown>,
    effort: "low",
    maxTokens: 300,
  });
  // The call is left to finish on its own when it is slow — it is already paid
  // for, and the ledger should still see it — but nothing waits on it.
  asking.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const result = await Promise.race([asking, timeout]);
    if (!result) return null;
    const level = result.data.level?.toLowerCase();
    if (!isTaskLevel(level)) return null;
    return { level, reason: String(result.data.reason ?? "").trim().slice(0, 300) };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- The decision ------------------------------------------------------------

/**
 * Failure classes a retry buys nothing for: a vendor that could not be reached
 * and the task's own spending ceiling. `truncated` has its own branch, because
 * what it buys is a sentence about why it did not climb.
 */
const BUYS_NOTHING: ReadonlySet<FailureClass> = new Set<FailureClass>(["vendor-unavailable", "budget"]);

export type DecidedBy = "owner" | "stored" | "retry" | "rules" | "model" | "legacy";

export interface LevelDecision {
  /** Null when sizing is off: the run keeps the old effort-only answer. */
  level: TaskLevel | null;
  /** The effort for the run — from the level, or the old answer when off. */
  effort: Effort;
  /**
   * Set only on the first retry after a failed run: the same level, and so the
   * same model, thinking one step harder than the level would. Handed to the
   * loop as `effortFloor`. Null everywhere else.
   */
  effortFloor: Effort | null;
  decidedBy: DecidedBy;
  /** The rules' score, when the rules were asked. */
  score: number | null;
  reasons: string[];
  /** True when a spend ceiling held the level lower than it would have been. */
  cappedByBudget: boolean;
  /** The line for the task's timeline. Null when there is nothing new to say. */
  sentence: string | null;
}

export interface RouteRequest {
  agent: Agent;
  task: AgentTask;
  /** The catalogue tools this agent holds, with their scope. */
  toolkit: Array<{ key: string; scope: ToolScope | string }>;
  /** What the brief's own words point at. */
  likely: string[];
  /** True when the run continues a saved conversation. */
  resuming: boolean;
  /**
   * Where the task was before this run claimed it — or `FAILED` when the runner
   * found, in the task's transitions, that this claim follows a failed run it
   * was requeued out of. See `lastFailure` in the runner: the claim alone says
   * QUEUED whenever a person, Slack or the API role requeued first.
   */
  previousStatus: AgentTaskStatus | null;
  /** Who failed it — `runner`, or `reaper`/`boot` for a run that kept dying. */
  previousActor?: string | null;
  /**
   * How many runs in a row the runner itself ended FAILED, the last one
   * included. One is the first retry; absent is read as one.
   */
  failuresInARow?: number;
  /**
   * Why the failed run stopped — the class off its FAILED transition
   * (`FAILURE_CLASSES` in the runner). Only a failure the model could have
   * avoided climbs the ladder; absent or null is read as one that could, which
   * is how every failure was read before the class was passed.
   */
  failureClass?: FailureClass | null;
  /**
   * The effort a retry was raised to, read back off the checkpoint it saved.
   * Honoured only on a plain resume, so a pause in the middle of a retry
   * comes back on the same rung rather than quietly thinking less.
   */
  savedEffortFloor?: Effort | null;
  /** Sizing on/off, read once by the caller. Read here when absent. */
  mode?: RoutingMode;
  /** Replaces the free-model look. For a check; nothing else passes it. */
  look?: typeof lookAtTask;
  /** One orchestrator or the roster. Read from `agents.mode` when absent. */
  oneAgent?: boolean;
  /** How many earlier pieces of work this task waited for. The runner knows; nothing on the row does once they are handed over. */
  builtOn?: number;
  /** Replaces the read of how this skill's recent tasks ended. For a check. */
  outcomes?: typeof recentOutcomes;
}

// --- What the last gradings came to ------------------------------------------

/**
 * How a skill's recent tasks at one strength ended.
 *
 * The router graded every task and never looked at what became of its
 * gradings. A skill whose low-strength tasks keep running out of turns, or
 * keep failing on their own tool calls, is a skill being under-graded — and
 * the retry ladder only ever fixed that one task at a time, after it had
 * already failed once, every time.
 */
export interface Outcomes {
  /** Tasks counted: the newest few that reached an ending. */
  of: number;
  /** Of those, how many ended short in a way a stronger model could have avoided. */
  short: number;
}

/** How far back, how many it takes to mean anything, and how many shorts tip it. */
export const OUTCOME_WINDOW = 8;
export const OUTCOME_MIN = 6;
export const OUTCOME_SHORT = 3;
const OUTCOME_DAYS = 30;

/**
 * Endings that say the model was not up to the work: it used every turn, or
 * it failed on its own calls or for a reason nobody tagged. Not a refusal (a
 * stronger model declines the same content), not a truncation (thinking
 * harder spends more of the same reply), not a vendor being down, not the
 * task's own spending ceiling — and never a failure the reaper or a restart
 * wrote, which is about the process.
 */
function endedShortOfIt(status: AgentTaskStatus, reason: string | null | undefined, actor: string | null | undefined): boolean {
  if (actor && NOT_THE_MODELS_FAULT.has(actor)) return false;
  const tag = /^\[([a-z-]+)\]/.exec(reason ?? "")?.[1] ?? null;
  if (status === "BLOCKED") return tag === "iteration-cap";
  if (status === "FAILED") return tag === null || tag === "tool-error" || tag === "other";
  return false;
}

export async function recentOutcomes(agentKey: string, level: TaskLevel, exceptTaskId?: string): Promise<Outcomes> {
  const rows = await prisma.agentTask.findMany({
    where: {
      agentKey,
      level: toStored(level),
      // A rehearsal is not the work, and its endings are not evidence about it.
      rehearsal: false,
      status: { in: ["DONE", "NEEDS_APPROVAL", "FAILED", "BLOCKED"] },
      createdAt: { gte: new Date(Date.now() - OUTCOME_DAYS * 24 * 60 * 60_000) },
      ...(exceptTaskId ? { id: { not: exceptTaskId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: OUTCOME_WINDOW,
    select: {
      status: true,
      transitions: {
        where: { to: { in: ["FAILED", "BLOCKED"] } },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: 1,
        select: { reason: true, actor: true },
      },
    },
  });
  // A BLOCKED task with no class asked a person something: an ending, and not a short one.
  const short = rows.filter((row) => endedShortOfIt(row.status, row.transitions[0]?.reason, row.transitions[0]?.actor)).length;
  return { of: rows.length, short };
}

/** Enough evidence, and enough of it bad, to grade this skill's next task a step up. */
export function outcomesSayHarder(seen: Outcomes): boolean {
  return seen.of >= OUTCOME_MIN && seen.short >= OUTCOME_SHORT;
}

/** Everything the rules read, taken off the rows the runner already has. */
export function factsFor(request: Pick<RouteRequest, "agent" | "task" | "toolkit" | "likely" | "oneAgent" | "builtOn">): TaskFacts {
  const { agent, task } = request;
  return {
    ...(request.oneAgent ? { oneAgent: true } : {}),
    ...(request.builtOn ? { builtOn: request.builtOn } : {}),
    title: task.title,
    brief: task.brief,
    inputChars: task.input == null ? 0 : JSON.stringify(task.input).length,
    origin: task.origin,
    agentKey: agent.key,
    agentTier: agent.tier,
    toolkit: request.toolkit,
    likely: request.likely,
    linked: {
      lead: Boolean(task.leadId),
      client: Boolean(task.clientId),
      project: Boolean(task.projectId),
      proposal: Boolean(task.proposalId),
      invoice: Boolean(task.invoiceId),
    },
  };
}

const MODEL_WORDS: Record<TaskLevel, string> = {
  simple: "the small paid model",
  standard: "the mid paid model",
  complex: "the top paid model",
};

/**
 * The level for this run, and the sentence that explains it.
 *
 * Never throws for a reason that is not a bug: a failed look keeps the rules'
 * answer, and a budget that cannot be read leaves the level where it was.
 */
/**
 * The three levels in the words the Owner uses for them: a task's *strength*
 * is low, medium or high. The stored values and every setting keep the
 * original spelling (simple, standard, complex) — only what a person reads
 * changes, so nothing saved needs migrating.
 */
export const STRENGTH: Record<TaskLevel, "low" | "medium" | "high"> = { simple: "low", standard: "medium", complex: "high" };

export async function routeTask(request: RouteRequest): Promise<LevelDecision> {
  const { agent, task } = request;
  const mode = request.mode ?? (await routingMode());

  if (mode === "off") {
    let effort = legacyEffort(agent);
    if (effort === "high" && (await budgetWantsCheaper(agent.key).catch(() => false))) effort = "medium";
    return { level: null, effort, effortFloor: null, decidedBy: "legacy", score: null, reasons: [], cappedByBudget: false, sentence: null };
  }

  const stored = fromStored(task.level);
  const override = fromStored(task.levelOverride);

  let level: TaskLevel;
  let decidedBy: DecidedBy;
  let score: number | null = null;
  let reasons: string[] = [];
  let sentence: string | null;
  let effortFloor: Effort | null = null;

  if (override) {
    level = override;
    decidedBy = "owner";
    sentence = `Graded ${STRENGTH[level]} strength because that was chosen for it.`;
  } else if (stored && request.previousStatus === "FAILED" && !NOT_THE_MODELS_FAULT.has(request.previousActor ?? "") && request.failureClass === "truncated") {
    // A reply that ran out of room. Every Claude turn goes out with the same
    // fixed `max_tokens`, and thinking is counted inside it, so a rung up the
    // ladder spends more of a budget that was already too small — another
    // truncation, then a dearer model, at a higher price each time. The level
    // stays and so does its own effort, which is a step down for a retry that
    // was already thinking harder. The ceiling is not raised here: above it
    // the SDK refuses a call that is not streamed.
    level = stored;
    decidedBy = "retry";
    sentence =
      `Its last run ran out of room before it finished, and thinking harder spends more of the same reply budget, ` +
      `so this one stays ${STRENGTH[stored]} at ${effortForLevel(stored)} effort rather than climbing.`;
  } else if (stored && request.previousStatus === "FAILED" && !NOT_THE_MODELS_FAULT.has(request.previousActor ?? "") && request.failureClass != null && BUYS_NOTHING.has(request.failureClass)) {
    // The far end, or the task's own spending ceiling: nothing about the task
    // or how hard the model thinks would have changed either, and the second
    // costs more for the same refusal.
    level = stored;
    decidedBy = "retry";
    sentence =
      request.failureClass === "budget"
        ? `Its last run stopped at its own spending ceiling, and thinking harder costs more, so a retry buys nothing: this one stays ${STRENGTH[stored]} at ${effortForLevel(stored)} effort.`
        : `Its last run failed because no model could be reached, which nothing about the task causes, so a retry buys nothing: this one stays ${STRENGTH[stored]} at ${effortForLevel(stored)} effort.`;
  } else if (stored && request.previousStatus === "FAILED" && !NOT_THE_MODELS_FAULT.has(request.previousActor ?? "")) {
    // **Effort before model** — the Owner's rule. The first retry keeps the
    // level, and so the model and its warm cache, and only thinks harder: a
    // mid-tier model given room to think often does what a dearer one at low
    // effort would, at a fraction of the price. A second failure in a row is
    // the evidence that thinking was not enough, and only then does a dearer
    // model take it. Complex has nowhere further to go, so it keeps thinking
    // harder each time instead, up to max.
    const failures = Math.max(1, request.failuresInARow ?? 1);
    decidedBy = "retry";
    if (stored === "complex") {
      level = stored;
      effortFloor = raiseEffort(effortForLevel(stored), failures);
      sentence =
        `Its last ${failures === 1 ? "run" : `${failures} runs`} failed at high strength, and there is no stronger model to hand it to, ` +
        `so this one thinks harder — ${effortFloor} effort rather than ${effortForLevel(stored)}.`;
    } else if (failures === 1) {
      level = stored;
      effortFloor = raiseEffort(effortForLevel(stored), 1);
      sentence = `Its last run failed as a ${STRENGTH[stored]} task, so this one stays ${STRENGTH[stored]} and thinks harder — ${effortFloor} effort rather than ${effortForLevel(stored)} — before a stronger model is tried.`;
    } else {
      level = stepUp(stored);
      sentence = `Its last ${failures} runs in a row failed, and thinking harder was tried first, so this one runs as ${STRENGTH[level]} rather than ${STRENGTH[stored]}.`;
    }
  } else if (stored && request.resuming) {
    level = stored;
    effortFloor = request.savedEffortFloor ?? null;
    decidedBy = "stored";
    // Nothing new to say. A task paused for a rate limit resumes every few
    // minutes, and a line each time would bury the timeline.
    sentence = null;
  } else {
    // Unset is one orchestrator, as everywhere else that reads `agents.mode`.
    const oneAgent = request.oneAgent ?? (await getSetting(SETTING.AGENT_MODE).catch(() => null))?.trim().toLowerCase() !== "roster";
    const facts = factsFor({ ...request, oneAgent });
    const scored = scoreTask(facts);
    score = scored.score;
    reasons = scored.reasons;
    const fromRules = levelForScore(scored.score);
    level = fromRules;
    decidedBy = "rules";
    const because = reasons.length > 0 ? reasons.join("; ") : "nothing in it stood out";
    sentence = `Graded ${STRENGTH[level]} strength (score ${score}): ${because}.`;

    if (mode === "full" && isUnclear(scored.score)) {
      const look = await (request.look ?? lookAtTask)(agent, facts).catch(() => null);
      if (look) {
        const clamped = clampLevel(look.level, fromRules);
        level = clamped;
        decidedBy = "model";
        const held = clamped !== look.level ? ` (it said ${STRENGTH[look.level]}; held to one step from the rules)` : "";
        sentence =
          `Graded ${STRENGTH[level]} strength. The rules scored it ${score}, on the line between two levels — ${because} — ` +
          `so a free model was asked${held}: “${look.reason || "no reason given"}”.`;
      }
    }

    if (OUTSIDE_WRITING_FLOOR && WRITES_FOR_OUTSIDE.has(agent.key) && atLeast(level, OUTSIDE_WRITING_FLOOR) !== level) {
      level = OUTSIDE_WRITING_FLOOR;
      sentence = `${sentence} Raised to ${STRENGTH[level]}, the floor for writing that leaves the company.`;
    }

    // What became of the last gradings. Only ever upward, and only on real
    // evidence: a skill whose recent tasks at this strength keep ending short
    // is being under-graded, and the next one starts a step up instead of
    // failing first and being retried. Never downward — a task finishing at
    // medium is not evidence it would have finished at low. A read that fails
    // changes nothing.
    if (level !== "complex") {
      const seen = await (request.outcomes ?? recentOutcomes)(agent.key, level, task.id).catch(() => null);
      if (seen && outcomesSayHarder(seen)) {
        const graded = level;
        level = stepUp(level);
        const learned = `${seen.short} of this skill's last ${seen.of} ${STRENGTH[graded]}-strength tasks ended short`;
        reasons = [...reasons, `${learned} (one step up)`];
        sentence = `${sentence} Raised to ${STRENGTH[level]}: ${learned} of finishing, so this one starts a step up rather than failing first.`;
      }
    }
  }

  // Last, and over everything including the Owner's call: a ceiling in its
  // downgrade band is also the Owner's call, made about money.
  let cappedByBudget = false;
  if (level === "complex" && (await budgetWantsCheaper(agent.key).catch(() => false))) {
    level = atMost(level, "standard");
    cappedByBudget = true;
    // The harder thinking goes with it. Effort is spend as surely as the model
    // is, and the ceiling's answer outranks the retry's.
    effortFloor = null;
    const held = "Held at medium strength because spending is in its downgrade band.";
    sentence = sentence ? `${sentence} ${held}` : held;
  }

  if (sentence && decidedBy !== "stored") {
    sentence = `${sentence} Free models first; if they cannot finish it, ${MODEL_WORDS[level]} takes over.`;
  }

  // A floor only ever raises: one at or under the level's own effort is no floor.
  if (effortFloor && EFFORT_LADDER.indexOf(effortFloor) <= EFFORT_LADDER.indexOf(effortForLevel(level))) effortFloor = null;
  return { level, effort: effortFloor ?? effortForLevel(level), effortFloor, decidedBy, score, reasons, cappedByBudget, sentence };
}
