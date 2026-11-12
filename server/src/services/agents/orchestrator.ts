import type { Agent, AgentTask, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { SETTING, getSetting, setSetting } from "../../lib/settings.js";
import { callModel } from "../../lib/models/call.js";
import { providerConfigured } from "../../lib/models/registry.js";
import { listAllTools } from "../tools/catalogue.js";
import { similarity, tokens } from "./hiring.js";

/**
 * One agent, many skills.
 *
 * Until Nov 2026 the workforce was a roster: fifty-seven agents, each with one
 * job, its own memory and its own card. The Owner asked for the opposite shape
 * — **one orchestrator that holds every skill** — for a reason the roster could
 * not answer: fifty-seven agents are fifty-seven partial views of the company.
 * What the Cold Lead Writer concluded about a lead was invisible to the
 * Proposal Writer working the same lead a week later, and "who do I give this
 * to" was a question the person giving the task had to answer before anything
 * started.
 *
 * In orchestrator mode there is one agent, `orchestrator`, and every other row
 * in the `Agent` table is one of **its skills**: an instruction (the ten
 * layers, still editable on the same screen), a set of tools, and the words a
 * task is matched on. Four things change, and each has one home:
 *
 * 1. **A task given to the orchestrator is matched to a skill before it
 *    runs** — `dispatchOrchestratorTasks()`, on the same tick that starts work.
 *    Rules first (free), a free model only when the rules cannot separate two
 *    skills, and no skill at all is an answer: the orchestrator then works the
 *    task itself and raises sub-tasks under the skills it needs.
 * 2. **Every run speaks as the orchestrator** — `orchestratorIdentity()` goes
 *    in front of the skill's instruction, so the model reads one agent using a
 *    skill rather than a specialist that happens to share a database.
 * 3. **One memory.** What any skill concluded about a lead, a client or a
 *    project is recalled by every other skill working that record (`recall()`
 *    with `everySkill`). Only `self` — a lesson about one craft's own way of
 *    working — stays with the skill that learnt it, because twenty crafts'
 *    habits competing for twenty-four places helps none of them.
 * 4. **Any skill may raise a sub-task under any other.** The org chart existed
 *    to stop agents routing around each other; one agent has nobody to route
 *    around.
 *
 * **What deliberately does not change is the gate.** A tool call is still
 * permitted or held against the *skill's* own card — its toolkit, its
 * boundaries, its autonomy level and its dry run — so switching modes cannot
 * widen what anything may do. The orchestrator's own row is a master switch on
 * top: paused or retired, nothing starts.
 *
 * `agents.mode = roster` (or `AGENTS_MODE=roster`) is the rollback, with no
 * deploy. Nothing is migrated in either direction, because nothing was moved:
 * tasks still carry the key of the skill that works them.
 */

export const ORCHESTRATOR_KEY = "orchestrator";

/** What a dispatch step is filed under, so a task is only ever matched once. */
export const DISPATCH_TOOL = "orchestrator.dispatch";

export type AgentMode = "orchestrator" | "roster";

/** Unset is `orchestrator`. Only the word `roster` switches it back. */
export async function agentMode(): Promise<AgentMode> {
  const raw = (await getSetting(SETTING.AGENT_MODE))?.trim().toLowerCase();
  return raw === "roster" ? "roster" : "orchestrator";
}

export async function orchestratorOn(): Promise<boolean> {
  return (await agentMode()) === "orchestrator";
}

// --- Choosing the skill ------------------------------------------------------

export interface SkillCandidate {
  key: string;
  name: string;
  title: string;
  mission: string;
  skills: string[];
  status: string;
  tier?: string;
}

export interface RankedSkill {
  key: string;
  name: string;
  score: number;
  /** The words or phrases that matched, for the sentence on the timeline. */
  matched: string[];
}

/**
 * How well each skill fits a task, on its words alone. Pure.
 *
 * Three signals, weighted in the order they are trustworthy:
 *
 * - **A skill phrase** ("edit a video", "chase a late invoice") is what the
 *   Owner wrote down as *what this is relied on for*, so a task that says it
 *   is the strongest evidence there is. A whole phrase counts 1; most of one
 *   counts half.
 * - **The title and name** ("Proposal Writer") — a task that names the craft.
 * - **The mission**, lightly: it is a sentence of prose and shares ordinary
 *   words with every brief ever written.
 *
 * It ranks; it never refuses. A wrong first place costs a sub-task raised
 * under the right skill, which the orchestrator can always do.
 */
export function rankSkills(text: string, skills: SkillCandidate[]): RankedSkill[] {
  const wanted = words(text);
  if (wanted.size === 0) return [];

  return skills
    .map((skill) => {
      const matched: string[] = [];
      let score = 0;

      for (const phrase of skill.skills) {
        const inPhrase = words(phrase);
        if (inPhrase.size === 0) continue;
        const hit = [...inPhrase].filter((word) => wanted.has(word)).length / inPhrase.size;
        if (hit >= 0.99) {
          // A one-word phrase is a weaker claim than a whole one: "design"
          // is in half the briefs anybody writes.
          score += inPhrase.size >= 2 ? 1 : 0.6;
          matched.push(phrase);
        } else if (hit >= 0.6) {
          score += 0.5 * hit;
          matched.push(phrase);
        }
      }

      // The name alone ("Proposal Writer"), not the title: a title is a line
      // of description and shares ordinary words with everything.
      const named = words(skill.name);
      const nameHit = named.size > 0 ? [...named].filter((word) => wanted.has(word)) : [];
      if (nameHit.length > 0) {
        score += nameHit.length / named.size + (nameHit.length === named.size && named.size >= 2 ? 0.5 : 0);
        matched.push(...nameHit);
      }

      const about = similarity(wanted, words(`${skill.title} ${skill.mission}`));
      score += Math.min(0.6, about.shared.length * 0.15);

      return { key: skill.key, name: skill.name, score: Number(score.toFixed(2)), matched: [...new Set(matched)].slice(0, 4) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * The words of a phrase, with the one product name that reads as a verb kept
 * whole. "Care plan" is something DakyXTech sells; left as two words, every
 * task that says "plan next quarter" matched the three care-plan skills.
 * `complexity.ts` carries the same exception for the same reason.
 */
function words(text: string): Set<string> {
  return tokens(text.replace(/care[\s-]+plans?/gi, "careplan"));
}

/** Clear enough that the rules decide alone: a real match, well ahead of the next. */
export function isClearWinner(ranked: RankedSkill[]): boolean {
  const [first, second] = ranked;
  if (!first || first.score < 1) return false;
  return !second || first.score >= second.score * 1.3;
}

export interface SkillChoice {
  /** Null when no skill fits and the orchestrator keeps the task itself. */
  key: string | null;
  name: string | null;
  decidedBy: "rules" | "model" | "none";
  sentence: string;
  shortlist: RankedSkill[];
}

const CHOOSING_SYSTEM = `You are the dispatcher inside a company's single AI agent. The agent holds many skills; a task has arrived and you choose the ONE skill that should do it.

You are given the task and a shortlist of skills, each with a key. Answer with the key of the skill whose finished output is what the task asks for. If the task spans several skills, or none of the shortlist is the right craft, answer "none" — the agent will then split the work itself. Never invent a key.`;

const CHOOSING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skill", "reason"],
  properties: {
    skill: { type: "string", description: "The key of the chosen skill, exactly as listed, or the word none." },
    reason: { type: "string", description: "One sentence, under 25 words." },
  },
} as const;

const CHOOSE_TIMEOUT_MS = 15_000;

/**
 * One free model's pick among a shortlist the rules could not separate.
 *
 * The same contract as the sizing look in `complexity.ts`: NVIDIA named rather
 * than routed to, so it can never turn into a paid call; null for anything but
 * a usable answer, and the caller keeps the rules' answer then.
 */
async function askForSkill(
  task: Pick<AgentTask, "title" | "brief">,
  shortlist: (RankedSkill & { mission: string })[],
): Promise<{ key: string | null; reason: string } | null> {
  if (!(await providerConfigured("nvidia").catch(() => false))) return null;
  const asking = callModel<{ skill: string; reason: string }>({
    purpose: "routing.skill",
    job: "routing",
    provider: "nvidia",
    system: CHOOSING_SYSTEM,
    prompt: () =>
      [
        `TASK: ${task.title}`,
        "",
        task.brief.slice(0, 2000),
        "",
        "SKILLS:",
        ...shortlist.map((skill) => `- ${skill.key} — ${skill.name}: ${skill.mission.slice(0, 200)}`),
      ].join("\n"),
    schema: CHOOSING_SCHEMA as unknown as Record<string, unknown>,
    effort: "low",
    maxTokens: 300,
  });
  asking.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CHOOSE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([asking, timeout]);
    if (!result) return null;
    const answer = String(result.data.skill ?? "").trim();
    const reason = String(result.data.reason ?? "").trim().slice(0, 300);
    if (answer.toLowerCase() === "none") return { key: null, reason };
    return shortlist.some((skill) => skill.key === answer) ? { key: answer, reason } : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Which skill a task belongs to.
 *
 * Only skills that can actually start are considered — a draft, paused or
 * retired skill would hold the task in the queue for ever, which reads as the
 * orchestrator doing nothing. `ask` is injectable so a check can drive the
 * boundary without a model.
 */
export async function chooseSkill(
  task: Pick<AgentTask, "title" | "brief">,
  options: { candidates?: SkillCandidate[]; ask?: typeof askForSkill | null } = {},
): Promise<SkillChoice> {
  const candidates =
    options.candidates ??
    (await prisma.agent.findMany({
      where: { status: "ACTIVE", key: { not: ORCHESTRATOR_KEY } },
      select: { key: true, name: true, title: true, mission: true, skills: true, status: true, tier: true },
    }));

  const ranked = rankSkills(`${task.title} ${task.brief}`, candidates);
  const shortlist = ranked.slice(0, 6);

  if (shortlist.length === 0) {
    return {
      key: null,
      name: null,
      decidedBy: "none",
      sentence: "No single skill matches the wording of this task, so the orchestrator is working it directly and will raise a sub-task under any skill it needs.",
      shortlist,
    };
  }

  if (isClearWinner(shortlist)) {
    const [first] = shortlist;
    return {
      key: first.key,
      name: first.name,
      decidedBy: "rules",
      sentence: `Skill chosen: ${first.name}${first.matched.length ? ` — the task matches ${first.matched.map((word) => `“${word}”`).join(", ")}` : ""}.`,
      shortlist,
    };
  }

  const ask = options.ask === undefined ? askForSkill : options.ask;
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const looked = ask
    ? await ask(
        task,
        shortlist.map((skill) => ({ ...skill, mission: byKey.get(skill.key)?.mission ?? "" })),
      ).catch(() => null)
    : null;

  if (looked?.key) {
    const chosen = shortlist.find((skill) => skill.key === looked.key)!;
    return {
      key: chosen.key,
      name: chosen.name,
      decidedBy: "model",
      sentence: `Skill chosen: ${chosen.name}. The wording fitted ${shortlist.length} skills about equally, so a free model was asked: “${looked.reason || "no reason given"}”.`,
      shortlist,
    };
  }
  if (looked && looked.key === null) {
    return {
      key: null,
      name: null,
      decidedBy: "model",
      sentence: `This spans more than one skill (“${looked.reason || "no reason given"}”), so the orchestrator is working it directly and will raise a sub-task under each skill it needs.`,
      shortlist,
    };
  }

  // Nobody to ask, and the rules could not separate them. A faint first place
  // is how a letter ends up written by the wrong craft — "design a logo"
  // ranks the UI designer above the graphic designer on one shared word — so
  // the orchestrator keeps the task and raises it under the skill it finds,
  // which costs one turn and is never wrong in public.
  return {
    key: null,
    name: null,
    decidedBy: "none",
    sentence: `No skill fits this task clearly enough to hand it over (closest: ${shortlist
      .slice(0, 3)
      .map((skill) => skill.name)
      .join(", ")}), so the orchestrator is working it directly and will raise a sub-task under the skill it needs.`,
    shortlist,
  };
}

/**
 * Matches every waiting task addressed to the orchestrator to a skill.
 *
 * Runs at the top of the tick that starts work. A task is matched **once**:
 * the step it writes is filed under `DISPATCH_TOOL`, and a task that already
 * has one is left alone — so a task the orchestrator kept for itself is not
 * re-argued every minute, and a resumed task is never moved to another skill
 * half-way through a conversation.
 *
 * The move is a conditional update on the task still being the orchestrator's
 * and still queued, so two processes on the same tick cannot both move it.
 */
export async function dispatchOrchestratorTasks(
  writeStep: (taskId: string, kind: "ROUTED", message: string, extra: { tool: string; data: Record<string, unknown> }) => Promise<void>,
  limit = 12,
): Promise<number> {
  if (!(await orchestratorOn())) return 0;
  const waiting = await prisma.agentTask.findMany({
    where: {
      agentKey: ORCHESTRATOR_KEY,
      status: "QUEUED",
      checkpoint: { is: null },
      steps: { none: { tool: DISPATCH_TOOL } },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true, title: true, brief: true },
  });
  if (waiting.length === 0) return 0;

  let moved = 0;
  for (const task of waiting) {
    const choice = await chooseSkill(task).catch(
      (): SkillChoice => ({
        key: null,
        name: null,
        decidedBy: "none",
        sentence: "The skill could not be chosen just now, so the orchestrator is working this directly.",
        shortlist: [],
      }),
    );
    if (choice.key) {
      const claimed = await prisma.agentTask.updateMany({
        where: { id: task.id, agentKey: ORCHESTRATOR_KEY, status: "QUEUED" },
        data: { agentKey: choice.key },
      });
      if (claimed.count === 0) continue;
      moved += 1;
    }
    await writeStep(task.id, "ROUTED", choice.sentence, {
      tool: DISPATCH_TOOL,
      data: { skill: choice.key, decidedBy: choice.decidedBy, shortlist: choice.shortlist.map((skill) => ({ key: skill.key, score: skill.score })) },
    });
  }
  return moved;
}

// --- Speaking as one agent ---------------------------------------------------

/**
 * What goes in front of a skill's instruction.
 *
 * Short on purpose: it is on every turn of every task, and `checks/
 * agentToolBudget.ts` holds the per-turn weight. It says the three things the
 * model cannot infer — that it is one agent, that the section below is a skill
 * rather than an identity, and that what it knows about a record is everything
 * any skill learnt about it.
 */
export function orchestratorIdentity(skill: Pick<Agent, "key" | "name">): string {
  if (skill.key === ORCHESTRATOR_KEY) {
    return "You are the DakyXTech Orchestrator — the one AI agent that runs this company's operations. You hold every skill the company has. No single skill was matched to this task, so work out which skills it needs, do the reading and the thinking yourself, and raise a sub-task under each skill whose finished work the task calls for.";
  }
  return `You are the DakyXTech Orchestrator — the one AI agent that runs this company's operations. You hold every skill the company has, and for this task you are using one of them: **${skill.name}** (\`${skill.key}\`). The instructions below are that skill. Follow them as your own craft for this task; where they say "you are the …", read it as the skill you are using. What you know about this lead, client or project is everything you learnt about it under any skill.`;
}

/** The closing paragraph of the working region, in place of "you are not working alone". */
export function skillsParagraph(count: number): string {
  return `You are the only agent here, and you hold ${count} skills. The difference between a good outcome and a mediocre one is usually whether the right skill did each part. **When part of the work needs a different skill from the one you are using, do not attempt it under this one.** Work through it in this order, and stop at the first step that answers:`;
}

/**
 * Why nothing may start, or null.
 *
 * The orchestrator's own row is the master switch: in orchestrator mode a
 * paused or retired orchestrator stops every skill. A missing row is not a
 * stop — a database that has not booted the seed yet must still work.
 */
export async function orchestratorHalted(): Promise<string | null> {
  if (!(await orchestratorOn())) return null;
  const row = await prisma.agent.findUnique({ where: { key: ORCHESTRATOR_KEY }, select: { status: true, name: true } });
  if (!row) return null;
  if (row.status === "PAUSED" || row.status === "RETIRED") return `${row.name} is ${row.status.toLowerCase()}, so no skill starts work.`;
  return null;
}

// --- The row -----------------------------------------------------------------

const ORCHESTRATOR_PROMPT = {
  role: "You are the DakyXTech Orchestrator: the single AI agent that runs DakyXTech's operations — leads, outreach, proposals, delivery, billing, care plans, reporting and the company's own decisions — by using the skills it holds.",
  mission: "Take any task, understand what finished looks like, and get it done by the right skill with the right tools — yourself where it is reading and judgement, and under a named skill where it is a craft.",
  scope: "Everything the company's skills cover. You do not produce a specialist deliverable (a letter, a proposal, an audit, a page, an invoice) under no skill: you raise it under the skill that owns it.",
  dataRules:
    "Use only verified records supplied in context. Separate what is observed from what is inferred, and say which is which. Never invent a client, a number, a date or a technical fact.",
  tools: "Use only the tools granted to you, within the permissions granted.",
  policy: "Anything that leaves the company, spends money or changes a live system is done under the skill that owns it, and is held for a person's approval wherever that skill's card says so. You never work around a held action.",
  process: `1. Read the task and the record it is about before deciding anything — the lead, client or project, its history and its living context.
2. Say what finished looks like in one sentence, then list the pieces of work it needs.
3. For each piece, use \`findAgent\` to find the skill that owns it. Reading, comparing and summarising are yours; a deliverable belongs to a skill.
4. Raise each deliverable with \`delegate\` under that skill: a brief written for somebody who was not here, the record it is about, and up to four checks that say it is done. Raise them in the order the work depends on.
5. Where one judgement inside a skill would change your plan, \`consult\` that skill first.
6. Write down what you decided and why with \`remember\`, and update the living context where a fact later work depends on has changed.
7. Finish with what was raised under which skill, what you concluded yourself, and what a person should look at.`,
  escalateWhen: "The task is ambiguous in a way that changes which skills it needs, two records contradict each other, no skill covers a piece the task cannot be finished without, or the work touches money, scope, security or a public claim that nobody has approved.",
  output: "A short account: what finished looks like, the pieces and the skill each went to, what you concluded yourself and on what evidence, and what is waiting on a person.",
  memory:
    "Retain decisions, their reasons and their outcomes with `remember`. Update living context in place with `update_living_context` whenever your work changes a fact later work depends on. Never retain secrets, tokens, passwords or personal data beyond what the task needs.",
};

/**
 * Creates the orchestrator's row, once, and keeps its reading tools current.
 *
 * Deliberately not in `AGENT_SEEDS`: those are the skills, and every roster
 * check counts them. It arrives **ACTIVE at autonomy 2 with dry run off** — the
 * commissioned card — because it is the master switch, and a master switch
 * that ships off is a workforce that silently does nothing after a deploy.
 * Its own toolkit is read-only, so that card cannot send, charge or spend:
 * everything that can is a skill's, and stays behind that skill's own gate.
 *
 * After creation only the toolkit is touched, and only additively — a reading
 * tool added to the catalogue later is granted once. Wording, status, autonomy
 * and dry run are the Owner's from the first boot onwards.
 */
export async function ensureOrchestrator(): Promise<"created" | "granted" | "unchanged"> {
  const catalogue = await listAllTools();
  const reads = catalogue
    .filter((tool) => tool.scope === "read" && !tool.spends && !tool.outward && tool.group !== "Connected")
    .map((tool) => tool.key);

  const existing = await prisma.agent.findUnique({ where: { key: ORCHESTRATOR_KEY }, select: { toolkit: true } });
  if (!existing) {
    await prisma.agent.create({
      data: {
        key: ORCHESTRATOR_KEY,
        name: "Orchestrator",
        title: "The one agent — every skill, one context",
        tier: "EXECUTIVE",
        department: "EXECUTIVE",
        managerKey: null,
        status: "ACTIVE",
        autonomyLevel: 2,
        dryRun: false,
        mission: "Take any task, choose the skill it needs, and get it done with the right tools and the whole company's context.",
        responsibilities: ["Match every task to a skill", "Split work that spans skills", "Keep one memory of every lead, client and project"],
        kpis: ["Tasks finished without a person re-routing them", "Sub-tasks raised under the right skill first time"],
        toolkit: reads,
        skills: [],
        escalationPolicy: "Stops and asks whenever no skill covers the work, or the work touches money, scope, security or a public claim nobody approved.",
        prompt: ORCHESTRATOR_PROMPT as unknown as Prisma.InputJsonValue,
      },
    });
    await setSetting(SETTING.AGENT_ORCHESTRATOR_OFFERED, reads.join(","));
    return "created";
  }

  const offeredRaw = await getSetting(SETTING.AGENT_ORCHESTRATOR_OFFERED);
  const offered = new Set((offeredRaw ?? "").split(",").filter(Boolean));
  const fresh = reads.filter((key) => !offered.has(key) && !existing.toolkit.includes(key));
  if (fresh.length > 0) {
    await prisma.agent.update({ where: { key: ORCHESTRATOR_KEY }, data: { toolkit: [...existing.toolkit, ...fresh] } });
  }
  const ledger = [...new Set([...offered, ...reads])];
  if (ledger.length !== offered.size) await setSetting(SETTING.AGENT_ORCHESTRATOR_OFFERED, ledger.join(","));
  return fresh.length > 0 ? "granted" : "unchanged";
}
