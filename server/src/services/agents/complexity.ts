import type { Agent, AgentTask, AgentTaskStatus } from "@prisma/client";
import type { Effort } from "../../lib/claude.js";
import { callModel } from "../../lib/models/call.js";
import { TASK_LEVELS, effortForLevel, isTaskLevel, providerConfigured, type TaskLevel } from "../../lib/models/registry.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { check, scopesForAgent } from "../budgets.js";
import type { ToolScope } from "../tools/types.js";

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
 *    judgements, and a model change costs a cache miss); and one level up
 *    after a run that failed outright at a lower level.
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

  add(TIER_WEIGHT[facts.agentTier] ?? 0, `a ${facts.agentTier.toLowerCase().replace("_", "-")} agent`);

  if (facts.origin === "SCHEDULE") add(-1, "routine standing work");
  if (facts.origin === "AGENT") add(-1, "a slice of a colleague's task");

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

export type DecidedBy = "owner" | "stored" | "retry" | "rules" | "model" | "legacy";

export interface LevelDecision {
  /** Null when sizing is off: the run keeps the old effort-only answer. */
  level: TaskLevel | null;
  /** The effort for the run — from the level, or the old answer when off. */
  effort: Effort;
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
  /** Where the task was before this run claimed it. */
  previousStatus: AgentTaskStatus | null;
  /** Sizing on/off, read once by the caller. Read here when absent. */
  mode?: RoutingMode;
  /** Replaces the free-model look. For a check; nothing else passes it. */
  look?: typeof lookAtTask;
}

/** Everything the rules read, taken off the rows the runner already has. */
export function factsFor(request: Pick<RouteRequest, "agent" | "task" | "toolkit" | "likely">): TaskFacts {
  const { agent, task } = request;
  return {
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
export async function routeTask(request: RouteRequest): Promise<LevelDecision> {
  const { agent, task } = request;
  const mode = request.mode ?? (await routingMode());

  if (mode === "off") {
    let effort = legacyEffort(agent);
    if (effort === "high" && (await budgetWantsCheaper(agent.key).catch(() => false))) effort = "medium";
    return { level: null, effort, decidedBy: "legacy", score: null, reasons: [], cappedByBudget: false, sentence: null };
  }

  const stored = fromStored(task.level);
  const override = fromStored(task.levelOverride);

  let level: TaskLevel;
  let decidedBy: DecidedBy;
  let score: number | null = null;
  let reasons: string[] = [];
  let sentence: string | null;

  if (override) {
    level = override;
    decidedBy = "owner";
    sentence = `Sized as a ${level} task because that was chosen for it.`;
  } else if (stored && request.previousStatus === "FAILED" && stored !== "complex") {
    level = stepUp(stored);
    decidedBy = "retry";
    sentence = `Its last run failed as a ${stored} task, so this one runs as ${level}.`;
  } else if (stored && request.resuming) {
    level = stored;
    decidedBy = "stored";
    // Nothing new to say. A task paused for a rate limit resumes every few
    // minutes, and a line each time would bury the timeline.
    sentence = null;
  } else {
    const facts = factsFor(request);
    const scored = scoreTask(facts);
    score = scored.score;
    reasons = scored.reasons;
    const fromRules = levelForScore(scored.score);
    level = fromRules;
    decidedBy = "rules";
    const because = reasons.length > 0 ? reasons.join("; ") : "nothing in it stood out";
    sentence = `Sized as a ${level} task (score ${score}): ${because}.`;

    if (mode === "full" && isUnclear(scored.score)) {
      const look = await (request.look ?? lookAtTask)(agent, facts).catch(() => null);
      if (look) {
        const clamped = clampLevel(look.level, fromRules);
        level = clamped;
        decidedBy = "model";
        const held = clamped !== look.level ? ` (it said ${look.level}; held to one step from the rules)` : "";
        sentence =
          `Sized as a ${level} task. The rules scored it ${score}, on the line between two levels — ${because} — ` +
          `so a free model was asked${held}: “${look.reason || "no reason given"}”.`;
      }
    }

    if (OUTSIDE_WRITING_FLOOR && WRITES_FOR_OUTSIDE.has(agent.key) && atLeast(level, OUTSIDE_WRITING_FLOOR) !== level) {
      level = OUTSIDE_WRITING_FLOOR;
      sentence = `${sentence} Raised to ${level}, the floor for writing that leaves the company.`;
    }
  }

  // Last, and over everything including the Owner's call: a ceiling in its
  // downgrade band is also the Owner's call, made about money.
  let cappedByBudget = false;
  if (level === "complex" && (await budgetWantsCheaper(agent.key).catch(() => false))) {
    level = atMost(level, "standard");
    cappedByBudget = true;
    const held = "Held at standard because spending is in its downgrade band.";
    sentence = sentence ? `${sentence} ${held}` : held;
  }

  if (sentence && decidedBy !== "stored") {
    sentence = `${sentence} Free models first; if they cannot finish it, ${MODEL_WORDS[level]} takes over.`;
  }

  return { level, effort: effortForLevel(level), decidedBy, score, reasons, cappedByBudget, sentence };
}
