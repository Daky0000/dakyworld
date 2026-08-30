import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Agent, AgentTask, AgentStepKind } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { clipToolResult, runAgentLoop, type AgentTool, type AgentToolOutcome } from "../../lib/claudeAgent.js";
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { AnalystError } from "../../lib/claude.js";
import { listAllTools } from "../tools/catalogue.js";
import type { ToolDefinition } from "../tools/types.js";
import { invokeTool } from "../tools/invoke.js";
import { companyProfile, contactBlock } from "../systemProfile.js";
import { BRAND, VOICE } from "../dakyworld.js";
import { MemoryRefused, recall, remember, subjectOf, type Recalled } from "./memory.js";
import { authoredInstruction } from "./authored.js";
import { describeTask, taskSubjects } from "./context.js";
import { appendNote, renderDossier } from "../context/dossier.js";
import { recordGap, searchRoster, similarity, tokens } from "./hiring.js";
import { callModel } from "../../lib/models/call.js";
import { withRunContext } from "../../lib/runContext.js";
import { recordCreated, transition } from "./state.js";
import { heldByRehearsal } from "../rehearsals/policy.js";
import { wakeOne } from "../rehearsals/wake.js";
import { check, scopesForAgent, type BudgetState } from "../budgets.js";

/**
 * What actually runs an agent.
 *
 * Everything before this was potential: a roster of jobs, a catalogue of
 * permissioned tools, and an audit trail waiting for something to audit. This
 * is the part that turns a task into work — it claims the task, tells the
 * agent who it is and what it already knows, hands it the tools it has been
 * granted, and turns the loop until the job is done or the agent stops and
 * asks.
 *
 * **The gate is unchanged and unmoved.** Every tool call still goes through
 * `invokeTool`, which still checks readiness, the grant, the autonomy level
 * and the schema, and still writes a `ToolCall` row for every call including
 * every refusal. Nothing here can act outside what the Agents screen allows;
 * what it adds is a reason for the call to be made at all.
 *
 * **A refusal is information, not a failure.** When the gate downgrades a call
 * to a preview because the agent is in dry run, the model is told exactly
 * that, in words — and the useful thing then happens, which is that it carries
 * on and prepares the rest of the work instead of stopping. A task whose calls
 * were all previews finishes at `NEEDS_APPROVAL` with the whole thing ready to
 * approve, which is what autonomy level 1 is *for*.
 */

/** Concurrency across the whole process. One service, one loop, one ceiling. */
const MAX_CONCURRENT = 2;
const running = new Set<string>();

/**
 * Who this process is, from the database's point of view.
 *
 * Stamped on every task this process claims and checked on every checkpoint
 * write. Two processes can hold the same task id in mind — the one that
 * stalled long enough to be reaped, and the one that took over — and only the
 * one whose token is on the row may write. Without it the slow process would
 * eventually wake up and overwrite the newer run's conversation with its own
 * older one, which is the single way this design could corrupt work rather
 * than merely waste it.
 */
const PROCESS_ID = `${process.pid}-${Date.now().toString(36)}`;
let claimCounter = 0;

/**
 * Set when the process has been told to stop — a Railway deploy, a Ctrl-C.
 *
 * Every run in flight reads this between steps and puts itself down properly:
 * checkpoint written, task back to QUEUED, agent freed. The alternative is
 * what used to happen, which is that the container vanished mid-sentence and
 * the task sat RUNNING — blocking its agent — until the reaper noticed.
 */
let shuttingDown = false;

/**
 * Asks every run in flight to stop at its next safe point.
 *
 * Returns once they have, or after `graceMs`, whichever is first. Called from
 * the process's own SIGTERM handler: the platform gives a container a few
 * seconds to die politely and this is what spends them well.
 */
export async function drainRunningTasks(graceMs = 8_000): Promise<number> {
  shuttingDown = true;
  if (running.size === 0) return 0;
  const waiting = running.size;
  console.log(`[agent] shutting down — asking ${waiting} run(s) to stop and keep their place`);
  const until = Date.now() + graceMs;
  while (running.size > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (running.size > 0) {
    console.warn(`[agent] ${running.size} run(s) did not stop in time — they will be picked up from their last checkpoint`);
  }
  return waiting;
}

/**
 * **One agent, one task at a time.**
 *
 * The process ceiling above says how much work the service does at once; this
 * says how much of it any one agent may be doing, and the answer is one. Two
 * reasons, and the second is the one that matters:
 *
 * 1. An agent is a job, not a thread pool. "The Proposal Writer is working on
 *    the Adom Clinic proposal" is a sentence somebody can act on; "the
 *    Proposal Writer is working on four things" is not, and neither is a
 *    roster where every card says `running`.
 * 2. **Memory.** An agent writes what it concluded as it goes and reads it
 *    back on the next task about the same subject. Two tasks about the same
 *    lead running side by side interleave those writes, so each one recalls
 *    half of what the other was in the middle of deciding — and the result is
 *    an agent contradicting itself inside one conversation, with no way to see
 *    from the timeline that it happened.
 *
 * Held in two places on purpose. The set is the fast answer within this
 * process; the claim below is a conditional update the database arbitrates, so
 * two processes reaching for the same agent still cannot both win.
 */
const busyAgents = new Set<string>();

/** Cheap enough to be wrong about, expensive enough to be worth capping. */
const MAX_ATTEMPTS = 3;

/**
 * How many colleagues one task may ask, and how many pieces it may hand away.
 *
 * Both are cheap individually and pathological in bulk. Three consults is a
 * hard question being worked properly; ten is an agent canvassing the building
 * instead of deciding, at a model call each. Two hand-offs is a task with two
 * craft pieces in it; five is a task that was somebody else's from the start,
 * and the right answer to that is an escalation about the brief.
 *
 * `MAX_CONSULTS` is now the fallback for a task whose priority is not in
 * `CONSULT_LIMITS` below, rather than the limit itself.
 */
const MAX_CONSULTS = 3;
const MAX_HANDOFFS = 2;

/**
 * The consult ceiling, by how urgent the task is.
 *
 * One number for every task was the wrong shape in one direction only: three
 * is right for the ordinary case and too few for the rare task where getting
 * it wrong is expensive, which is exactly the task somebody marked urgent.
 * `AgentTask.priority` already exists and already drives the order the runner
 * picks in, so this needs no new field and no new vocabulary.
 *
 * The count itself stays a single `consulted` on `Counters`. Splitting it per
 * priority would change the checkpoint's shape for nothing — a task has one
 * priority, so only the ceiling varies.
 */
const CONSULT_LIMITS: Record<number, number> = { 1: 5, 2: 3, 3: 2 };

/**
 * Exported for `checks/agentBriefing.ts`. Zero being a real limit rather than
 * an unset value is the kind of thing that is only ever wrong once, in
 * production, for the person who typed it deliberately.
 */
export async function consultLimitFor(task: Pick<AgentTask, "priority">): Promise<number> {
  const raw = (await getSetting(SETTING.CONSULT_PRIORITY_LIMITS))?.trim();
  let limits = CONSULT_LIMITS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const read: Record<number, number> = { ...CONSULT_LIMITS };
      for (const [priority, value] of Object.entries(parsed)) {
        // `>= 0`, not `> 0`. Zero means no consults on tasks of this priority
        // and is a thing somebody may deliberately want; the usual guard would
        // hand them the default back without saying so.
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) read[Number(priority)] = value;
      }
      limits = read;
    } catch {
      // A hand-edited setting must not stop the workforce consulting. An
      // unreadable value is treated as no value.
      limits = CONSULT_LIMITS;
    }
  }
  return limits[task.priority] ?? MAX_CONSULTS;
}

/**
 * The agents whose entire output is a piece of writing somebody outside the
 * company reads.
 *
 * Effort used to be decided by tier alone — high for the board and the
 * executives, medium for everybody else — on the reasoning that a manager's
 * output is a judgement and a specialist's steps are mostly obvious. Half of
 * that is right and half of it produced the complaint that the drafts read the
 * same. The *steps* of writing a cold email are obvious; the writing is not,
 * and it is the part a stranger judges the company by. A proposal, a first
 * email, a case study and a client report are each one piece of prose that has
 * to be good, and they were all being written at the cheaper setting while a
 * weekly internal brief nobody outside sees got the expensive one.
 *
 * Deliberately a list rather than a flag on the seed: it is a statement about
 * which work is worth paying more for, and that belongs in one place where it
 * can be read and argued with.
 */
const WRITES_FOR_OUTSIDE = new Set([
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
 * How hard the model works on this agent's task.
 *
 * High for a judgement (the management tiers) and high for a piece of writing
 * that leaves the building. Medium for everything else, which is genuinely
 * most of it: reading a record, filing a task, checking a list.
 */
function effortFor(agent: Agent): "low" | "medium" | "high" {
  if (agent.tier === "BOARD" || agent.tier === "EXECUTIVE") return "high";
  return WRITES_FOR_OUTSIDE.has(agent.key) ? "high" : "medium";
}

/**
 * The same answer, with a spend ceiling allowed to talk it down.
 *
 * At three quarters of a budget the work carries on and pays the economy rate
 * for it, which is the whole reason `downgrade` is a separate action from
 * `pause`: falling off a cliff at the end of the month is worse for this
 * business than a fortnight of slightly cheaper drafting.
 *
 * **Down to `medium`, never to `low`.** `low` is the mail room's setting for
 * classifying a message that has arrived, and giving it to an agent writing to
 * a stranger would be a different and worse kind of saving. `medium` is where
 * the model changes and the thinking budget is still reasonable — which is the
 * point at which the saving is real and the quality cost is not.
 */
async function effortUnderBudget(agent: Agent): Promise<"low" | "medium" | "high"> {
  const wanted = effortFor(agent);
  if (wanted !== "high") return wanted;
  const budget = await check(scopesForAgent(agent.key));
  return budget.action === "downgrade" || budget.action === "approve" ? "medium" : wanted;
}

// --- The timeline -----------------------------------------------------------

/**
 * Writes one step. Never throws: a task must not fail because its own progress
 * log did, and a run with a gap in its timeline is still a run that happened.
 */
/**
 * Appends one entry to a task's timeline.
 *
 * Exported because the approval queue writes to the same timeline: a task that
 * ended at `NEEDS_APPROVAL` and was later approved has to show what became of
 * it, or it reads for ever as work that stopped. The sequence number is worked
 * out here and must not be worked out anywhere else — two places computing it
 * is two places that can produce a duplicate.
 */
export async function step(
  taskId: string,
  kind: AgentStepKind,
  message: string,
  extra: { tool?: string; toolCallId?: string; ok?: boolean; dryRun?: boolean; data?: unknown } = {},
) {
  try {
    const last = await prisma.agentTaskStep.findFirst({ where: { taskId }, orderBy: { seq: "desc" }, select: { seq: true } });
    await prisma.agentTaskStep.create({
      data: {
        taskId,
        seq: (last?.seq ?? 0) + 1,
        kind,
        message: message.slice(0, 2000),
        tool: extra.tool ?? null,
        toolCallId: extra.toolCallId ?? null,
        ok: extra.ok ?? null,
        dryRun: extra.dryRun ?? null,
        data: trim(extra.data) as never,
      },
    });
  } catch (err) {
    console.error(`[agent] could not write a step for ${taskId}:`, (err as Error).message);
  }
}

/**
 * Removes the THOUGHT step that turned out to be the summary.
 *
 * `onText` writes every text block the model produces, which is what makes an
 * agent's reasoning visible while it is still working. The final block is a
 * different thing — it is the account of the finished job — and it gets its
 * own FINISHED step a line later. Without this the last two rows of every
 * timeline are the same paragraph twice.
 *
 * Matched on the exact text rather than on being last, so a task whose closing
 * words genuinely differ from its final thought keeps both.
 */
async function dropTrailingThought(taskId: string, summary: string) {
  try {
    const last = await prisma.agentTaskStep.findFirst({
      where: { taskId },
      orderBy: { seq: "desc" },
      select: { id: true, kind: true, message: true },
    });
    if (last?.kind === "THOUGHT" && last.message === summary.slice(0, 2000)) {
      await prisma.agentTaskStep.delete({ where: { id: last.id } });
    }
  } catch (err) {
    // A tidy-up, not a step of the work. Never worth failing a finished task.
    console.error(`[agent] could not tidy the closing thought on ${taskId}:`, (err as Error).message);
  }
}

/** Keeps one enormous tool result from filling the database. */
function trim(value: unknown): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json.length <= 4000 ? JSON.parse(json) : { truncated: true, preview: json.slice(0, 1500) };
}

// --- The tools the agent is handed ------------------------------------------

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

/**
 * True for the calls somebody may have to approve.
 *
 * Reaching outside the company or spending money — the same two flags the gate
 * in `tools/invoke.ts` reads, deliberately, so the tools that get held back are
 * exactly the tools that arrive with a case attached. A `read` tool asked to
 * justify itself would be three fields of ceremony on every lookup.
 */
function needsCase(tool: { outward: boolean; spends: boolean }): boolean {
  return tool.outward || tool.spends;
}

/**
 * Adds `why`, `gain` and `risk` to a tool's schema.
 *
 * The Owner has to decide these one at a time, and "send this email" is not a
 * question anybody can answer. What makes it answerable is the agent's own
 * account of why it wants to, what it gets, and what could go wrong — and the
 * reliable way to get that is to make it part of the call rather than a
 * paragraph in a prompt that competes with everything else in the prompt. A
 * model cannot forget a required field.
 *
 * They are stripped again before the tool runs. Nothing downstream knows about
 * them except the approval queue.
 */
function withCase(schema: JsonSchema, tool: { outward: boolean; spends: boolean }): Record<string, unknown> {
  if (!needsCase(tool)) return schema;
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      why: {
        type: "string",
        description: "Why this, for this company, now. Point at the evidence in front of you rather than restating your job.",
      },
      gain: { type: "string", description: "What Dakyworld gets if it works." },
      risk: {
        type: "string",
        description: "What could go wrong, or what you are unsure of. 'Nothing' is almost never the honest answer — say what would make this the wrong move.",
      },
    },
    required: [...(schema.required ?? []), "why", "gain", "risk"],
  };
}

/**
 * What makes a repeat of this exact call the same call.
 *
 * Task, tool and a hash of the arguments. Scoped to the task on purpose: within
 * one run, asking twice for the same send is always a replay — a resumed
 * half-finished turn, a retried claim — and across runs it may well be a second
 * letter somebody meant to send.
 *
 * The keys are sorted before hashing, because a model does not emit its object
 * properties in a stable order and two spellings of one payload must not read
 * as two different calls.
 */
function outwardKey(taskId: string, toolKey: string, input: unknown): string {
  const canonical = JSON.stringify(input, (_k, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  const digest = createHash("sha256").update(canonical ?? "null").digest("hex").slice(0, 32);
  return `${taskId}:${toolKey}:${digest}`;
}

/**
 * The catalogue, narrowed to what this agent has been granted, plus the three
 * tools every agent has because they are how it participates in the workflow
 * rather than things it does to the business.
 */
/**
 * The sentence a hand-off owes the agent making it when the target is a draft.
 *
 * `runDueTasks()` only starts tasks for an ACTIVE agent, so a child task
 * queued against a DRAFT one is real work that will never begin. Three of the
 * four task origins already say so — the Owner route returns a note, the mail
 * room refuses a draft as a destination outright, and standing work skips it
 * on purpose. Delegation and hand-off were the pair that said nothing, which
 * made this the one way work could disappear without anybody being told.
 *
 * Deliberately still queued rather than refused: lining work up before its
 * agent is switched on is exactly what a DRAFT queue is for. The defect was
 * only ever the silence.
 */
function draftWarning(target: { name: string; status: string }, rehearsal: boolean): string {
  if (rehearsal || target.status !== "DRAFT") return "";
  return ` Note: ${target.name} is still a draft, so nothing will start on this until somebody activates them — say so in your summary.`;
}

interface GrantedTools {
  tools: AgentTool[];
  /**
   * The granted tools whose purpose overlaps this task's own words, best
   * first. Named in the brief; never used to filter or reorder `tools`.
   */
  likely: { key: string; name: string; purpose: string }[];
}

/**
 * Which of the granted tools this particular task is probably about.
 *
 * An agent is handed everything its toolkit grants with a catalogue
 * description each and no indication of which of them this brief calls for —
 * eighteen for the Cold Lead Writer, and the model works out the shortlist
 * from scratch on every task, at the top of a context it is paying to re-send.
 *
 * **Scored, never filtered.** A tool the model cannot see is a tool it cannot
 * use, so a bad ranking would be a silent loss of capability rather than a
 * worse suggestion. The whole effect is a sentence in the brief.
 *
 * Uses the tokeniser from `agents/hiring.ts`, which already answers "how much
 * do these two descriptions have in common" for the roster search and the
 * overlap check. A third copy of that rule is a third thing to keep in step.
 */
function likelyTools(granted: ToolDefinition[], task: AgentTask): GrantedTools["likely"] {
  const wanted = tokens(`${task.title} ${task.brief}`);
  if (wanted.size === 0) return [];

  return granted
    .map((tool) => ({
      tool,
      score: similarity(wanted, tokens(`${tool.name} ${tool.purpose} ${tool.group}`)).score,
    }))
    // Zero overlap is not a recommendation. Three tools the task never
    // mentioned, presented as the likely ones, is worse than saying nothing —
    // it is a wrong answer where there was previously an honest absence.
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => ({ key: entry.tool.key, name: entry.tool.name, purpose: entry.tool.purpose }));
}

/**
 * The sentence that goes on the brief, or nothing.
 *
 * Deliberately on the **brief** rather than the system prompt. The system
 * prompt carries a cache breakpoint and is the same for every task this agent
 * runs; per-task text in there would write a new cache entry each time and
 * read none, which is the expensive half of caching with none of the saving.
 */
export function likelyToolsLine(likely: GrantedTools["likely"]): string {
  if (likely.length === 0) return "";
  return [
    "LIKELY USEFUL HERE, on the words of this brief alone:",
    ...likely.map((tool) => `- \`${tool.key}\` — ${tool.purpose}`),
    "This is a guess from the wording and nothing more. Your whole toolkit is available; if the right tool is not in this list, use it anyway.",
  ].join("\n");
}

/**
 * Exported so a check can assert the thing that actually matters here: that
 * ranking the tools never costs the agent one. A test of `likelyTools()` alone
 * would go on passing after somebody made the ranking filter.
 */
export async function toolsFor(agent: Agent, task: AgentTask, counters: Counters): Promise<GrantedTools> {
  const catalogue = await listAllTools();
  const granted = catalogue.filter((tool) => agent.toolkit.includes(tool.key));

  const tools: AgentTool[] = granted.map((tool) => ({
    // Anthropic tool names allow [a-zA-Z0-9_-] only; catalogue keys use dots.
    name: tool.key.replace(/\./g, "__"),
    description: `${tool.purpose}${tool.spends ? " Costs money." : ""}${tool.outward ? " Visible outside the company." : ""}${
      needsCase(tool) ? " Before this runs, you must say why, what it gains and what the risk is — a person may have to approve it." : ""
    }`,
    inputSchema: withCase(zodToJsonSchema(tool.input, { target: "jsonSchema7", $refStrategy: "none" }) as JsonSchema, tool),
    run: async (input) => {
      // Taken out before the tool sees them: they are the agent's case for
      // acting, not an argument to the action. A handler receiving an
      // unexpected `why` would fail its own schema check.
      const { why, gain, risk, ...toolInput } = (input ?? {}) as Record<string, unknown>;
      const rationale = needsCase(tool)
        ? { why: String(why ?? ""), gain: String(gain ?? ""), risk: String(risk ?? "") }
        : undefined;

      const result = await invokeTool(tool.key, toolInput, {
        agentKey: agent.key,
        userId: null,
        // The rehearsal guarantee. `permissionFor` treats the caller's flag as
        // a floor rather than a default, so an outward call in a rehearsal
        // stops at a preview no matter what autonomy its agent is on — and
        // because `delegate` and `handOff` copy `rehearsal` onto the tasks they
        // create, it holds across a run that fans out to nine agents.
        //
        // Narrowed to the outward calls rather than applied to everything, and
        // `services/rehearsals/policy.ts` is where that line is argued: a
        // blanket dry run refuses every read (a read has no preview) and
        // previews away every artefact, which would make a rehearsal a test of
        // nothing.
        dryRun: task.rehearsal && heldByRehearsal(tool),
        // Marks what the preview leaves behind, and nothing else. A rehearsal
        // still calls exactly the same tools with exactly the same inputs —
        // what changes is that the prepared actions it files are specimens for
        // the rehearsal screen rather than live proposals in the Owner's queue.
        rehearsal: task.rehearsal,
        taskId: task.id,
        rationale,
        // What makes a repeat of this call the same call. Only the runner can
        // say: a resumed run replaying a half-finished turn is a retry, while
        // the same payload raised by a different task next month is a second
        // deliberate send. `invokeTool` only acts on it for outward tools.
        idempotencyKey: outwardKey(task.id, tool.key, toolInput),
      });
      counters.toolCalls += 1;

      // Order matters here, and getting it wrong is silent. A dry run also
      // carries a `refusedReason` — the sentence explaining *why* it was
      // downgraded — so checking the refusal first files prepared work as
      // refused, leaves dryRunCalls at zero, and finishes the task DONE.
      // The Owner then reads "done" about work that never happened.
      if (result.dryRun) {
        counters.dryRun += 1;
        await step(task.id, "PREPARED", result.wouldDo ?? `${tool.name} — prepared, not carried out.`, {
          tool: tool.key,
          toolCallId: result.callId,
          ok: true,
          dryRun: true,
          data: { input },
        });
        return {
          content: [
            `PREPARED, NOT DONE — ${result.wouldDo}`,
            "",
            result.actionRequestId
              ? "This is what would have happened. It has not happened. It is now waiting for a person to approve, and it will be carried out exactly as prepared when they do — so do not prepare it a second time, and do not describe it as done."
              : "This is what would have happened. It has not happened. Carry on and prepare the rest of the work; a person will approve it.",
          ].join("\n"),
        };
      }

      if (result.refusedReason) {
        counters.refused += 1;
        await step(task.id, "REFUSED", `${tool.name} — ${result.refusedReason}`, {
          tool: tool.key,
          toolCallId: result.callId,
          ok: false,
          data: { input },
        });
        // Told plainly, because what it should do next depends on which of the
        // three refusals this was.
        return {
          content: `That was not carried out. ${result.refusedReason}\n\nDo not try it again. Either work around it, or use the escalate tool to hand this to a person.`,
          isError: true,
        };
      }

      if (!result.ok) {
        await step(task.id, "TOOL_CALL", `${tool.name} failed — ${result.error}`, {
          tool: tool.key,
          toolCallId: result.callId,
          ok: false,
          data: { input },
        });
        return { content: `That call failed: ${result.error}`, isError: true };
      }

      await step(task.id, "TOOL_CALL", result.replayed ? `${tool.name} — already done, not repeated` : tool.name, {
        tool: tool.key,
        toolCallId: result.callId,
        ok: true,
        dryRun: false,
        data: { input, output: result.output, replayed: result.replayed },
      });
      return { content: clipToolResult(JSON.stringify(result.output ?? null)) };
    },
  }));

  // A rehearsal reusing a lead that already has research skips site.look and
  // reports that research instead, rather than scraping the same site twice.
  if (task.skipLook && task.leadId) {
    const siteLookTool = tools.find((t) => t.name === "site__look");
    if (siteLookTool) {
      const leadId = task.leadId;
      const runSiteLook = siteLookTool.run;
      siteLookTool.run = async (input) => {
        const existingResearch = await prisma.leadResearch.findUnique({ where: { leadId } });
        if (existingResearch) {
          const summary = existingResearch.facts.length > 0 ? existingResearch.facts.join("\n") : "No facts were recorded on that run.";
          return {
            content: `Using research already on file from ${new Date(existingResearch.ranAt).toLocaleDateString()} rather than looking again.\n\n${summary}`,
          };
        }
        return runSiteLook(input);
      };
    }
  }

  return {
    tools: [...tools, ...workflowTools(agent, task, counters)],
    // Ranked over the catalogue entries rather than the wrapped `tools`: the
    // wrapper renames every key for the API (`lead.read` becomes `lead__read`)
    // and folds the purpose into a longer description, and scoring that text
    // would be scoring our own boilerplate as much as the tool.
    likely: (await relevanceOn()) ? likelyTools(granted, task) : [],
  };
}

/** Default on. Off removes a sentence from the brief and changes nothing else. */
async function relevanceOn(): Promise<boolean> {
  return (await getSetting(SETTING.ENABLE_TOOL_RELEVANCE)) !== "false";
}

export interface Counters {
  toolCalls: number;
  dryRun: number;
  refused: number;
  escalated: string | null;
  delegated: number;
  /** Questions asked of colleagues. Capped by priority — see `CONSULT_LIMITS`. */
  consulted: number;
  /** Work handed sideways to an agent that is not a report. */
  handedOff: number;
  /** Gaps raised: "nobody here can do this". */
  gapsRaised: number;
}

/**
 * The tallies as a checkpoint holds them.
 *
 * They decide how the task *ends* — a run that prepared three things finishes
 * at NEEDS_APPROVAL, one that escalated finishes BLOCKED — so losing them on a
 * resume would mean a task that prepared work in its first half and none in its
 * second reporting DONE about work nobody has approved.
 */
function restoreCounters(stored: Record<string, unknown> | undefined): Counters {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  // Unknown keys in `stored` are ignored rather than rejected, which is what
  // lets a checkpoint written by an older deploy resume here — `parallelGroups`
  // was one, and any counter retired later will be another.
  return {
    toolCalls: number(stored?.toolCalls),
    dryRun: number(stored?.dryRun),
    refused: number(stored?.refused),
    escalated: typeof stored?.escalated === "string" ? stored.escalated : null,
    delegated: number(stored?.delegated),
    consulted: number(stored?.consulted),
    handedOff: number(stored?.handedOff),
    gapsRaised: number(stored?.gapsRaised),
  };
}

/**
 * The three tools an agent has regardless of its toolkit.
 *
 * These are not capabilities over the business — they are how an agent takes
 * part in this system at all: how it stops and asks, how it keeps what it
 * learnt, and how a manager hands work down. Granting them per-agent would
 * mean an agent could be configured unable to escalate, which is not a
 * configuration anybody should be able to make.
 *
 * Exported for `checks/rehearsal.ts`, which drives `delegate` and `handOff`
 * directly. Nothing about them needs a model, and asserting that a delegated
 * child inherits its parent's rehearsal flag by *writing that shape in the
 * harness* would be a check that goes on passing after this function stops
 * doing it.
 */
export function workflowTools(agent: Agent, task: AgentTask, counters: Counters): AgentTool[] {
  const escalate: AgentTool = {
    name: "escalate",
    description:
      "Stop and hand this to a person. Use it when the brief is ambiguous, the evidence contradicts itself, or the work would change money, scope, security, a live system or a public claim. Stopping is always the right answer when you are unsure.",
    inputSchema: zodToJsonSchema(
      z.object({
        reason: z.string().min(10).max(600).describe("What you need decided, in one or two sentences. Be specific about what you would do if told to proceed."),
        options: z.array(z.string().max(200)).max(4).optional().describe("The choices as you see them, if there is more than one."),
      }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      const reason = String(input.reason ?? "").slice(0, 600);
      counters.escalated = reason;
      await step(task.id, "BLOCKED", reason, { data: { options: input.options } });
      return { content: "Recorded. This task is now waiting on a person — stop here.", stop: true };
    },
  };

  const rememberTool: AgentTool = {
    name: "remember",
    description:
      "Keep something for next time: a decision and why you made it, what came of it, a fact about this client, or a lesson about your own way of working. You will be shown these the next time you work on the same subject. Never write down a password, a token, an API key or anything else secret.",
    inputSchema: zodToJsonSchema(
      z.object({
        kind: z.enum(["DECISION", "OUTCOME", "FACT", "LESSON", "PREFERENCE"]),
        content: z.string().min(8).max(600).describe("The thing itself, in one or two sentences. Write the conclusion, not the working."),
        about: z
          .enum(["this task", "myself", "the whole company"])
          .default("this task")
          .describe(
            "'this task' files it against the record this task is about. 'myself' files it as a standing lesson only you will be shown. 'the whole company' shares it with every agent — use that only for something that is true of how Dakyworld works, never for an opinion of your own.",
          ),
        importance: z.number().int().min(1).max(5).default(3).describe("5 only for something that should always outrank other memories."),
      }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      const subjects = taskSubjects(task);
      const shared = input.about === "the whole company";
      // A shared memory about no particular record is about the company; a
      // shared memory formed while working on a lead stays filed against that
      // lead, so widening who sees it never widens when it comes up.
      const about = shared
        ? (subjects[0] ?? subjectOf.company())
        : input.about === "myself" || subjects.length === 0
          ? subjectOf.self()
          : subjects[0];
      try {
        await remember({
          agentKey: agent.key,
          kind: input.kind as never,
          subject: about,
          content: String(input.content ?? ""),
          importance: Number(input.importance ?? 3),
          sourceTaskId: task.id,
          shared,
        });
      } catch (err) {
        if (err instanceof MemoryRefused) return { content: err.message, isError: true };
        throw err;
      }
      await step(task.id, "REMEMBERED", String(input.content ?? "").slice(0, 300), {
        data: { subject: about, kind: input.kind, shared },
      });
      return {
        content: shared
          ? `Kept for the whole company, against ${about}. Every agent will be shown this.`
          : `Kept, against ${about}.`,
      };
    },
  };

  // --- The company's history, as opposed to this agent's opinion of it ------
  //
  // `remember` and these two look similar and are not. A memory is what *this
  // agent* worked out, shown back to it as its own conclusion, which the record
  // in front of it can overrule. A note is what *happened* — a call, a
  // decision, an outcome — and every agent that opens this company afterwards
  // is shown it as evidence. Writing "they seem price-sensitive" as a note
  // launders an opinion into a fact, and the tool descriptions say so, because
  // this is the distinction a model is most likely to blur.

  const noteTool: AgentTool = {
    name: "addToHistory",
    description:
      "Record something that HAPPENED with this company, so every agent that works on them next can see it. A call and what was agreed, a decision and why, what came of something you did. This is shared and permanent — it is the company's record, not your notes. For what *you* concluded or want to do differently next time, use `remember` instead. Never write down a password, a key or a card number.",
    inputSchema: zodToJsonSchema(
      z.object({
        kind: z
          .enum(["NOTE", "CALL", "MEETING", "REPLY", "DECISION", "OUTCOME", "RISK"])
          .default("NOTE")
          .describe("What sort of thing this is. CALL and MEETING for something that took place, REPLY when they got in touch, DECISION and OUTCOME for a choice and what came of it, RISK for something to be careful of here."),
        summary: z.string().min(4).max(300).describe("One line, as it will appear on the timeline."),
        body: z.string().max(4000).optional().describe("The detail, where there is more worth keeping. Markdown."),
        pinned: z
          .boolean()
          .default(false)
          .describe("Put it at the top for every agent that opens this company, above the timeline. For the two or three facts that change how anyone should approach them — not for ordinary events."),
      }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      const [subject] = taskSubjects(task);
      if (!subject) {
        return {
          content: "This task isn't about a particular lead, client or project, so there is no company history to add to. Use `remember` for a general lesson instead.",
          isError: true,
        };
      }
      try {
        await appendNote({
          subject,
          kind: (input.kind as never) ?? "NOTE",
          summary: String(input.summary ?? ""),
          body: input.body ? String(input.body) : null,
          authorKey: agent.key,
          pinned: Boolean(input.pinned),
          sourceTaskId: task.id,
        });
      } catch (err) {
        if (err instanceof MemoryRefused) return { content: err.message, isError: true };
        throw err;
      }
      await step(task.id, "NOTED", String(input.summary ?? "").slice(0, 300), { data: { subject, kind: input.kind } });
      return { content: `Added to the history for ${subject}. Every agent that works on them will see it.` };
    },
  };

  const historyTool: AgentTool = {
    name: "readHistory",
    description:
      "Read the full history of this company — every review, letter, call, proposal, invoice and note, in order. The task brief already carries the headlines; use this when you need the detail, the wording of what was sent, or anything older than the last few entries.",
    inputSchema: zodToJsonSchema(
      z.object({
        limit: z.number().int().min(5).max(100).default(40).describe("How many entries back to go."),
      }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      const [subject] = taskSubjects(task);
      if (!subject) return { content: "This task isn't about a particular company, so there is no history to read.", isError: true };
      const limit = typeof input.limit === "number" ? input.limit : 40;
      const markdown = await renderDossier(subject, { limit });
      return { content: markdown };
    },
  };

  const delegate: AgentTool = {
    name: "delegate",
    description:
      "Hand a piece of this work to one of the agents that reports to you. Use it when the work is somebody else's craft rather than yours. The task is queued for them; you do not wait for it.",
    inputSchema: zodToJsonSchema(
      z.object({
        agentKey: z.string().max(64).describe("The key of the agent to hand it to. It must report to you."),
        title: z.string().min(3).max(120),
        brief: z.string().min(20).max(2000).describe("Everything they need. They cannot see your conversation — write it as if to somebody who was not here."),
      }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      const target = await prisma.agent.findUnique({ where: { key: String(input.agentKey ?? "") } });
      if (!target) return { content: `There is no agent with the key ${input.agentKey}.`, isError: true };
      // Down the chart only. An agent handing work sideways or upward is an
      // agent routing around the person who owns that lane.
      if (target.managerKey !== agent.key) {
        return { content: `${target.name} does not report to you. You may only delegate to your own reports.`, isError: true };
      }
      if (target.status === "RETIRED" || target.status === "PAUSED") {
        return { content: `${target.name} is ${target.status.toLowerCase()} and cannot take work.`, isError: true };
      }
      // In a rehearsal, a report that was never switched on is woken rather
      // than left holding a task that will never start, and put back when the
      // run ends. Without it the most interesting thing a rehearsal can show —
      // a manager deciding this is somebody else's job — becomes a queued task
      // and a silent screen. Outside a rehearsal this does nothing at all, and
      // a draft goes on queueing exactly as it did before.
      if (task.rehearsal && target.status === "DRAFT") await wakeOne(task.id, target.key);

      const child = await prisma.agentTask.create({
        data: {
          agentKey: target.key,
          title: String(input.title ?? "").slice(0, 120),
          brief: String(input.brief ?? "").slice(0, 2000),
          origin: "AGENT",
          parentId: task.id,
          priority: task.priority,
          leadId: task.leadId,
          clientId: task.clientId,
          projectId: task.projectId,
          proposalId: task.proposalId,
          invoiceId: task.invoiceId,
          // Inherited, always. A rehearsal that could only hold its first agent
          // would be a rehearsal whose second agent sends the letter.
          rehearsal: task.rehearsal,
        },
      });
      counters.delegated += 1;
      await recordCreated(child.id, child.traceId, child.status, {
        reason: `${agent.name} delegated this to ${target.name}.`,
        actor: "agent",
      });
      await step(task.id, "DELEGATED", `To ${target.name}: ${child.title}`, { data: { agentKey: target.key, taskId: child.id } });
      return { content: `Queued for ${target.name}. You are not waiting on it — carry on with your own part.${draftWarning(target, task.rehearsal)}` };
    },
  };

  // --- Working with the rest of the workforce -------------------------------
  //
  // Before these three, an agent had exactly two ways out of work it could not
  // do: hand it *down* to a report, or stop and ask a person. Neither is what
  // a colleague would do. The Cold Lead Writer that wants to know whether an
  // SEO finding is worth leading on had to guess, because the SEO Specialist
  // was unreachable — one rung across the chart and no road between them.

  const findAgentTool: AgentTool = {
    name: "findAgent",
    description:
      "Search the roster for a colleague who does a particular kind of work. Use it whenever the task needs a craft that is not yours — before attempting it yourself, and before deciding nobody can do it. Say what you need in ordinary words: 'edit a video', 'reconcile a bank statement'.",
    inputSchema: zodToJsonSchema(
      z.object({ need: z.string().min(3).max(200).describe("The craft you are looking for, in plain words rather than in tool keys.") }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      const need = String(input.need ?? "");
      const matches = await searchRoster(need, agent.key);
      if (matches.length === 0) {
        return {
          content: `Nobody on the roster matches “${need}”. If this work genuinely has to be done and it is not your craft, use \`needSkill\` to record that — do not attempt it badly, and do not assume somebody will pick it up.`,
        };
      }
      return {
        content: matches
          .map(
            (match) =>
              `${match.name} (\`${match.key}\`) — ${match.title}. ${match.mission}${match.skills.length ? ` Good at: ${match.skills.slice(0, 5).join(", ")}.` : ""}${
                match.status === "ACTIVE" ? "" : ` [${match.status.toLowerCase()} — cannot take work right now]`
              }${match.reportsToYou ? " [reports to you — you may `delegate`]" : ""}`,
          )
          .join("\n"),
      };
    },
  };

  const consult: AgentTool = {
    name: "consult",
    description:
      "Ask a colleague a question and get their answer back now, without handing the work over. Use it for a judgement inside their craft that would change what you do — 'is this finding worth leading an email on', 'would this scope need a designer'. They answer from their own instructions and their own memory of this client. You keep the work.",
    inputSchema: zodToJsonSchema(
      z.object({
        agentKey: z.string().max(64).describe("Who to ask. Find one with findAgent first."),
        question: z.string().min(10).max(1200).describe("One specific question. They cannot see your conversation, so give them the facts they need to answer it."),
      }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      const limit = await consultLimitFor(task);
      if (counters.consulted >= limit) {
        return {
          content:
            limit === 0
              ? `Consulting is switched off for tasks at this priority. Decide with what you have, or escalate.`
              : `You have already asked ${limit} colleague(s) on this task, which is the limit at this priority. Decide with what you have, or escalate — one more opinion is a sign the brief is unclear rather than that the answer is close.`,
          isError: true,
        };
      }
      const key = String(input.agentKey ?? "");
      if (key === agent.key) return { content: "You cannot consult yourself.", isError: true };

      const colleague = await prisma.agent.findUnique({ where: { key } });
      if (!colleague) return { content: `There is no agent with the key ${key}. Use findAgent to see who exists.`, isError: true };
      if (colleague.status === "RETIRED") return { content: `${colleague.name} is retired and no longer answers.`, isError: true };

      const question = String(input.question ?? "").slice(0, 1200);
      const answer = await askColleague(colleague, agent, task, question);
      counters.consulted += 1;
      const left = limit - counters.consulted;
      await step(task.id, "CONSULTED", `Asked ${colleague.name}: ${question.slice(0, 200)}`, {
        ok: true,
        data: { agentKey: colleague.key, question, answer: answer.text, answeredBy: answer.provider },
      });
      return {
        content:
          `${colleague.name} says:\n\n${answer.text}\n\n` +
          `(That is their opinion from their own instructions, not a fact you have checked. The work is still yours. ` +
          `If they contradict the record in front of you, the record wins and you should say so. ` +
          // Said here rather than discovered by being refused: an agent that
          // knows it has one question left spends it on the one that matters.
          `${left > 0 ? `You may ask ${left} more colleague(s) on this task.` : `That was your last consult on this task.`})`,
      };
    },
  };

  const handOff: AgentTool = {
    name: "handOff",
    description:
      "Give the remaining work to an agent that does not report to you, because it is their craft rather than yours. Unlike `delegate` this goes sideways across the chart, so it needs a reason a person would accept. They get a task of their own; you do not wait for it, and you say in your summary that you handed it over.",
    inputSchema: zodToJsonSchema(
      z.object({
        agentKey: z.string().max(64).describe("Who takes it. Find one with findAgent first."),
        title: z.string().min(3).max(120),
        brief: z.string().min(20).max(2000).describe("Everything they need. They cannot see your conversation — write it as if to somebody who was not here."),
        why: z.string().min(10).max(400).describe("Why this is their craft and not yours. One sentence, and it goes on the record."),
      }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      if (counters.handedOff >= MAX_HANDOFFS) {
        return { content: `You have already handed off ${MAX_HANDOFFS} pieces of this task. Anything more and the brief belongs to somebody else entirely — escalate instead.`, isError: true };
      }
      const target = await prisma.agent.findUnique({ where: { key: String(input.agentKey ?? "") } });
      if (!target) return { content: `There is no agent with the key ${input.agentKey}. Use findAgent to see who exists.`, isError: true };
      if (target.key === agent.key) return { content: "You cannot hand work to yourself.", isError: true };
      if (target.status === "RETIRED" || target.status === "PAUSED") {
        return { content: `${target.name} is ${target.status.toLowerCase()} and cannot take work. Try findAgent again, or use needSkill if nobody else can.`, isError: true };
      }
      // Same as `delegate`, and this is the one that needs it most: a hand-off
      // goes sideways to anybody on the roster, so it is far likelier than a
      // delegation to land on a specialist nobody has switched on yet.
      if (task.rehearsal && target.status === "DRAFT") await wakeOne(task.id, target.key);

      const child = await prisma.agentTask.create({
        data: {
          agentKey: target.key,
          title: String(input.title ?? "").slice(0, 120),
          brief: `${String(input.brief ?? "").slice(0, 2000)}\n\n--- Handed over by ${agent.name} ---\n${String(input.why ?? "")}`,
          origin: "AGENT",
          parentId: task.id,
          priority: task.priority,
          leadId: task.leadId,
          clientId: task.clientId,
          projectId: task.projectId,
          proposalId: task.proposalId,
          invoiceId: task.invoiceId,
          // Same reason as `delegate`. Handing work sideways must not be a way
          // out of a rehearsal.
          rehearsal: task.rehearsal,
        },
      });
      counters.handedOff += 1;
      await recordCreated(child.id, child.traceId, child.status, {
        reason: `${agent.name} handed this to ${target.name}: ${String(input.why ?? "no reason given")}`,
        actor: "agent",
      });
      await step(task.id, "HANDED_OFF", `To ${target.name}: ${child.title} — ${String(input.why ?? "")}`, {
        data: { agentKey: target.key, taskId: child.id, why: input.why },
      });
      return { content: `Queued for ${target.name}. You are not waiting on it — finish your own part and say in your summary that this went to them.${draftWarning(target, task.rehearsal)}` };
    },
  };

  const needSkill: AgentTool = {
    name: "needSkill",
    description:
      "Record that this work needs a craft nobody on the roster has. Use it only after findAgent has come back with nobody — it is not a way to avoid work that is yours. It does not create anything: it tells the Agent Creator that the gap exists, and a person decides whether Dakyworld employs somebody for it.",
    inputSchema: zodToJsonSchema(
      z.object({
        skill: z.string().min(3).max(120).describe("The craft, in a client's words rather than a tool key — 'edit a video', 'keep the books'."),
        reason: z.string().min(20).max(800).describe("What you were trying to do, and why it is not a stretch of your own job. Be specific: this is the evidence somebody decides on."),
        blocking: z
          .boolean()
          .default(true)
          .describe("True when the task cannot be finished without it — you stop here and are picked up again if somebody is hired. False when you can carry on with the rest."),
      }),
      { target: "jsonSchema7", $refStrategy: "none" },
    ) as Record<string, unknown>,
    run: async (input) => {
      const skill = String(input.skill ?? "");
      const outcome = await recordGap({
        requestedByKey: agent.key,
        taskId: task.id,
        skillNeeded: skill,
        reason: String(input.reason ?? ""),
        rehearsal: task.rehearsal,
      });
      counters.gapsRaised += 1;
      await step(task.id, "GAP_RAISED", `Nobody can ${skill} — recorded${outcome.joined ? ` (${outcome.timesRequested} agents have now asked)` : ""}`, {
        data: { gapId: outcome.gapId, skill, joined: outcome.joined, reviewTaskId: outcome.reviewTaskId },
      });

      const told = outcome.note
        ? outcome.note
        : outcome.joined
          ? `Recorded. ${outcome.timesRequested} agents have now asked for this, which is the argument for hiring somebody.`
          : "Recorded. The Agent Creator will decide whether Dakyworld employs somebody for it.";

      if (input.blocking !== false) {
        // Stopped, exactly as an escalation stops — and for the same reason. The
        // difference is what happens next: an approved hire puts this task back
        // in the queue with the new agent's name in it, which `escalate` could
        // never do.
        counters.escalated = `Waiting on somebody who can ${skill}. ${told}`;
        return { content: `${told} You are stopping here. If somebody is hired for this, you will be given their name and picked up where you left off.`, stop: true };
      }
      return { content: `${told} Carry on with the parts of this you can do, and say in your summary what is still outstanding.` };
    },
  };

  // A specialist has nobody under it, so delegation would only ever fail.
  // Everything else here is for every agent: an agent that cannot look for a
  // colleague, ask one, or say that nobody exists is an agent that guesses.
  const hasReports = agent.tier !== "SUB_AGENT";
  const collaboration = [findAgentTool, consult, handOff, needSkill];
  const always = [escalate, rememberTool, noteTool, historyTool];
  return hasReports ? [...always, delegate, ...collaboration] : [...always, ...collaboration];
}

/**
 * One colleague answering one question, from their own prompt and their own
 * memory of this client.
 *
 * Deliberately **one model call and no tools**, rather than a nested agent run.
 * A consult that could call tools would be a second agent working on the same
 * task at the same time — the exact thing "one agent, one task" exists to
 * prevent — and it could spend money on a question the asking agent did not
 * budget for. What is wanted here is a judgement, and a judgement is what an
 * agent's prompt and memories produce without touching anything.
 *
 * It is routed by job like everything else, so a deployment with no Anthropic
 * key can still hold a conversation between two agents.
 */
async function askColleague(
  colleague: Agent,
  asker: Agent,
  task: AgentTask,
  question: string,
): Promise<{ text: string; provider: string }> {
  // Their memories of the subjects *this* task is about — which is the whole
  // value of asking a colleague rather than asking the same model twice. The
  // SEO Specialist answering about this lead has read what it concluded about
  // this lead before.
  const memories = await recall(colleague.key, taskSubjects(task));
  const system = [
    await systemPrompt(colleague, memories, { working: false }),
    `A colleague is asking you a question. You are not taking the work on — ${asker.name} keeps it — and you have no tools here, so answer from your own judgement and say plainly where you are unsure.`,
    "Answer in three or four sentences. If the honest answer is that you cannot tell from what you have been given, say that and name the one thing you would need.",
  ].join("\n\n");

  try {
    const result = await callModel<{ answer: string; confident: boolean; wouldNeed: string }>({
      purpose: `consult.${colleague.key}`,
      job: "text",
      system,
      prompt: () => `${asker.name} (${asker.title}) asks:\n\n${question}`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer", "confident", "wouldNeed"],
        properties: {
          answer: { type: "string", description: "Three or four sentences." },
          confident: { type: "boolean", description: "False when you are guessing." },
          wouldNeed: { type: "string", description: "The one thing that would let you answer properly, or an empty string." },
        },
      },
      effort: "medium",
      maxTokens: 1200,
    });
    const caveat = result.data.confident ? "" : `\n\n(Not confident.${result.data.wouldNeed ? ` Would need: ${result.data.wouldNeed}` : ""})`;
    return { text: `${result.data.answer}${caveat}`, provider: result.provider };
  } catch (err) {
    // A colleague who cannot be reached is a colleague who cannot be reached.
    // Reported as an answer rather than thrown, because the asking agent still
    // has a task to finish and "I could not get hold of them" is information.
    return { text: `[${colleague.name} could not be reached: ${(err as Error).message}]`, provider: "none" };
  }
}

// --- The prompt -------------------------------------------------------------

/**
 * The agent's ten layers, in the order the blueprint defines them.
 *
 * Read fresh from the row on every task, never cached — which is what makes an
 * edit on the Agents screen take effect on the very next task rather than on
 * the next restart. Layers the Owner has emptied are skipped rather than
 * printed blank.
 */

/**
 * How many colleagues there are, for the prompt.
 *
 * A number rather than a list: the roster is fifty agents and printing it in
 * every prompt would cost more tokens than the task, while telling an agent it
 * has fifty colleagues is what makes `findAgent` the obvious next move instead
 * of a tool it never thinks to reach for.
 */
async function rosterSize(): Promise<number> {
  return prisma.agent.count({ where: { status: { not: "RETIRED" } } });
}

/**
 * Re-exported so the Agents screen and the runner keep one import between them.
 * The definition is in `./authored.js` — a leaf, because the writers in `lib/`
 * need it too and this module imports the tool catalogue, which imports them.
 */
export { authoredInstruction } from "./authored.js";

/** One labelled block of the assembled prompt. */
export interface PromptRegion {
  key: "instruction" | "skills" | "brand" | "contact" | "voice" | "shared" | "own" | "working";
  /** The heading the screen puts on it. */
  label: string;
  /** Where the words come from, in a sentence, for somebody deciding whether they can change them. */
  source: string;
  /**
   * True only for the part a person authored. Everything else is assembled
   * from live state — the company profile, what the agent recalled, how many
   * colleagues it has — and editing a copy of it would either be overwritten
   * on the next run or quietly diverge from what the other forty-nine agents
   * are told.
   */
  editable: boolean;
  text: string;
}

/**
 * Who never writes a sentence a client, a prospect or the public reads.
 *
 * Classified by mission and toolkit on 29 Aug 2026 — not by whether a tool is
 * `outward`, which looked like the obvious signal and was wrong: a writer
 * drafts through `message.draft` / `content.draft`, which are `outward: false`
 * by design (sending is a separate, gated step), so that filter would have
 * struck brand voice from `outreach.writer` and `content.writer` — the two
 * agents that need it most.
 *
 * Every executive and every purely internal research/ops/technical role is
 * here; every agent that drafts a proposal, an email, a page, a report or a
 * caption a client or the public actually reads is deliberately not. Five
 * were genuine judgement calls: `mail.room` and `delivery.handover` keep it
 * (client email and a handover pack a client reads); `design.social` and
 * `video.editor` keep it (a hook or a caption is prose, not layout);
 * `design.graphic` and `billing.invoicer` drop it (print layout of existing
 * content, and template-driven line items, neither is voice-governed prose).
 *
 * **`review.look` and `design.ux` are deliberately not here**, on the same
 * reasoning `WRITES_FOR_OUTSIDE` above already made about their *effort*: a
 * reviewer's finding is a paragraph of prose that gets quoted straight into a
 * cold email opener or a branded audit a prospect reads, not a structured fact
 * a separate writer re-drafts the way `seo.specialist`'s or `sec.analyst`'s
 * findings are. Two lists making different calls about the same two agents
 * would be the kind of drift nobody notices until a quoted line reads wrong.
 */
const NO_BRAND_VOICE = new Set([
  // Executive and board — strategic reasoning over other agents' output, read-only toolkits.
  "ceo", "board.chair", "cro", "cmo", "coo", "cto", "cfo", "cco",
  // Revenue — pipeline, research and infrastructure, not writing.
  "email.sequencer", "analytics.upsell", "lead.orchestrator", "lead.enricher", "lead.capture", "email.deliverability",
  // Delivery — planning, not client correspondence.
  "delivery.director",
  // Finance — arithmetic and template documents.
  "careplan.manager", "billing.invoicer", "finance.forecast",
  // Marketing — technical audits and internal briefs whose findings a separate
  // writer re-drafts, or layout of others' content. Not review.look or
  // design.ux — see above.
  "design.graphic", "seo.specialist", "seo.local", "seo.keywords",
  // Technology — nothing here is read by anybody outside the company.
  "dev.web", "dev.hosting", "sec.analyst", "qa.tester", "dev.automation", "analytics.engine", "integration.manager",
  // Client — analysis, not correspondence.
  "analytics.churn",
  // Risk and People — internal governance.
  "risk.qa", "people.recruiter", "people.ops",
]);

/**
 * The prompt, in labelled pieces.
 *
 * `systemPrompt()` below is this joined together, so there is exactly one
 * description of what an agent is told and both the runner and the Agents
 * screen read it.
 */
export async function composePrompt(
  agent: Agent,
  memories: Recalled[],
  options: { working?: boolean } = {},
): Promise<PromptRegion[]> {
  // `working: false` is a colleague being asked a question rather than an agent
  // holding a task. Everything about who they are and what they know still
  // applies; everything about tools, dry run and who to hand work to does not,
  // and printing it would tell somebody with no tools how to use them.
  const working = options.working !== false;
  const profile = await companyProfile();

  const regions: PromptRegion[] = [
    {
      key: "instruction",
      label: "Its instructions",
      source: agent.promptText?.trim() ? "Written here, replacing the ten shipped sections." : "The ten shipped sections, run together in order.",
      editable: true,
      text: authoredInstruction(agent),
    },
    {
      key: "skills",
      label: "What it is relied on for",
      source: "The skills on this agent, edited on this screen.",
      editable: false,
      text: agent.skills.length > 0 ? `What you are relied on for:\n${agent.skills.map((skill) => `- ${skill}`).join("\n")}` : "",
    },
  ];

  // Who Dakyworld is and how it writes — 390 tokens, identical on every
  // agent's prompt whether or not it ever produces a sentence a client reads.
  // An agent that only reads numbers or fixes a server has no use for "sign
  // off as Dan" or the service catalogue's pitch, and paying for it on every
  // one of its tasks bought nothing. Held to a deny-list rather than an
  // allow-list: an agent the roster doesn't yet know about — one the Agent
  // Creator hires tomorrow — defaults to *keeping* it, which costs tokens
  // rather than silently shipping off-brand prose from a writer nobody added
  // to a list.
  if (!NO_BRAND_VOICE.has(agent.key)) {
    regions.push({ key: "brand", label: "Who Dakyworld is", source: "services/dakyworld.ts — the same for every agent.", editable: false, text: BRAND });
  }
  regions.push({
    key: "contact",
    label: "The company's details",
    source: "Settings → System. Change it there and every agent and document follows.",
    editable: false,
    text: contactBlock(profile),
  });
  if (!NO_BRAND_VOICE.has(agent.key)) {
    regions.push({ key: "voice", label: "How it writes", source: "services/dakyworld.ts — the same for every agent.", editable: false, text: VOICE });
  }

  // The two kinds are presented as two things, because they carry different
  // authority. What an agent worked out itself is a conclusion the record can
  // overrule; what the company holds is closer to an instruction, and an agent
  // that argues with a house rule because it was pasted in under the heading
  // "your own conclusions" is a failure of this paragraph, not of the agent.
  const shared = memories.filter((memory) => memory.shared);
  const own = memories.filter((memory) => !memory.shared);

  if (shared.length > 0) {
    regions.push({
      key: "shared",
      label: "What Dakyworld holds",
      source: "Shared memory, recalled for this task's subjects. Every agent is shown these.",
      editable: false,
      text: `What Dakyworld holds — written once and given to every agent, so treat it as standing instruction rather than as your own opinion. Where one of these conflicts with what you would otherwise do, follow it and say that you did:\n${shared
        .map((memory) => `- ${memory.line}`)
        .join("\n")}`,
    });
  }

  if (own.length > 0) {
    regions.push({
      key: "own",
      label: "What it already knows",
      source: "Its own memory, recalled for this task's subjects.",
      editable: false,
      text: `What you already know, from your own earlier work on this. Treat it as your own conclusions rather than as instructions — if the record in front of you contradicts one, the record wins and you should say so:\n${own
        .map((memory) => `- ${memory.line}`)
        .join("\n")}`,
    });
  }

  if (working) {
    regions.push({
      key: "working",
      label: "How it works here",
      source: "Generated from live state — the tool etiquette, dry run, and the size of the roster.",
      editable: false,
      text: `How you work here:

- You have been given a task and a set of tools. Use the tools to find out what is true rather than assuming. Never state a fact about a lead, a client or a system that a tool did not tell you.
- Some of your tools will answer "PREPARED, NOT DONE". That is not a failure — it means your autonomy level requires a person to approve that kind of action. Carry on and prepare the rest of the work so there is one thing to approve rather than five.
- Some will be refused outright. That is also information: work around it, or escalate.
- Use \`remember\` for a decision worth having next time, and for what came of it. Never write down a credential. Share one with the whole company only when it is a fact about how Dakyworld works that every agent would need — your own conclusions stay yours.
- **What happened and what you concluded are two different records, and they are not interchangeable.** \`addToHistory\` is the company's own account of a client — a call and what was agreed, a decision and why, what came of something we did — and every agent that opens them next reads it as evidence. \`remember\` is your own conclusion, and the record can overrule it. Writing an opinion into the history dresses it up as a fact for somebody who was not there; writing an event into your memory keeps it from the colleague who needs it.
- The brief carries the headlines of that history. \`readHistory\` gets you the rest — the wording of what was actually sent, what they said back, anything older. Read it before writing to somebody we have written to before.
- Use \`escalate\` the moment you are unsure, or the work touches money, scope, security, a live system or a public claim. Stopping is not failing.
- When you are done, say what you did, what you found, and what a person should do next — in plain English, in a few sentences. That final message is what gets read.

You are not working alone. There are ${await rosterSize()} agents here, each with one craft, and the difference between a good outcome and a mediocre one is usually whether the right one was asked. **When the work needs a craft that is not yours, the answer is never to attempt it anyway.** Work through it in this order, and stop at the first step that answers:

1. \`findAgent\` — look for somebody whose craft this is. Do this *before* attempting anything outside your own job, not after producing something you are unsure of.
2. \`consult\` — you keep the work and want their judgement on one question inside their craft. They answer from their own instructions and their own memory of this client, so ask them the thing only they would know. Their answer is an opinion, not a checked fact: where it contradicts the record in front of you, the record wins and you say so.
3. \`handOff\` (or \`delegate\`, if they report to you) — the work itself is theirs. Write the brief as if to somebody who was not here, because they were not.
4. \`needSkill\` — only when \`findAgent\` found nobody. It records that Dakyworld has no such craft; the Agent Creator reads it and a person decides whether to employ somebody. It is not a way to put down work that is actually yours, and a gap raised for something a colleague already does is worse than useless — it argues for hiring a duplicate.

Asking is cheap and being wrong in public is not. An agent that consulted a colleague and changed its mind has done the job properly; say in your summary who you asked and what it changed.`,
    });
  }

  return regions;
}

async function systemPrompt(agent: Agent, memories: Recalled[], options: { working?: boolean } = {}): Promise<string> {
  const regions = await composePrompt(agent, memories, options);
  return regions
    .map((region) => region.text)
    .filter(Boolean)
    .join("\n\n");
}

// --- Running one task -------------------------------------------------------

export interface RunOutcome {
  status: AgentTask["status"];
  summary: string | null;
}

/**
 * Claims one task and works it — or picks up where the last runner left it.
 *
 * The claim is a conditional update rather than a read-then-write: two runners
 * reaching for the same task is the one race that matters here, and the loser
 * has to find out before it starts spending money rather than after.
 *
 * **A claim is not necessarily a beginning.** If the task has a checkpoint, the
 * conversation it holds is what runs — same agent, same tools, same memories,
 * but rejoining a job in progress rather than starting the brief again. A
 * deploy landing mid-task used to cost the whole run: the research repaid for,
 * the audit re-run, the same first email drafted twice from scratch.
 */
export async function runTask(taskId: string): Promise<RunOutcome> {
  if (running.has(taskId)) return { status: "RUNNING", summary: null };
  if (shuttingDown) return { status: "QUEUED", summary: null };
  running.add(taskId);

  // Set inside the claim below, and cleared in the same `finally` as the task
  // id — so an agent is freed by every exit, including a throw.
  let claimedAgent: string | null = null;
  const runOwner = `${PROCESS_ID}:${(claimCounter += 1)}`;

  try {
    const claim = await transition(taskId, {
      to: "RUNNING",
      reason: "Claimed by the runner",
      actor: "runner",
      // CANCELLED and FAILED are here so that pressing Run on one continues
      // it rather than being refused — the checkpoint is still there, and
      // "run this again" almost never means "throw away what it had done".
      expect: ["QUEUED", "BLOCKED", "CANCELLED", "FAILED"],
      // The rule, enforced where two processes can both see it. A relation
      // filter inside the conditional update means the loser of the race
      // finds out before it starts spending money rather than after.
      guard: { agent: { tasks: { none: { status: "RUNNING" } } } },
      data: {
        startedAt: new Date(),
        heartbeatAt: new Date(),
        runOwner,
        // Whatever asked the last run to stop has been honoured. Leaving it set
        // would stop this one on its first step, for ever.
        interruptRequested: false,
        attempts: { increment: 1 },
        error: null,
        blockedReason: null,
      },
    });
    if (!claim.moved) {
      const current = await prisma.agentTask.findUnique({
        where: { id: taskId },
        select: { status: true, summary: true, agentKey: true },
      });
      // Two different failures that look identical from here: the task was
      // already finished, or its agent is mid-way through something else. The
      // second is normal and temporary, so it stays QUEUED and the next tick
      // picks it up.
      if (current && (current.status === "QUEUED" || current.status === "BLOCKED")) {
        return { status: current.status, summary: current.summary };
      }
      return { status: current?.status ?? "CANCELLED", summary: current?.summary ?? null };
    }

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    if (!task) return { status: "CANCELLED", summary: null };
    claimedAgent = task.agentKey;
    busyAgents.add(task.agentKey);

    // Everything from here runs inside the task's own context, so an audit row
    // written four frames down — a writer inside a tool handler inside the
    // loop — is attributed to this run without every signature in between
    // having to carry a task id. It carries attribution only: nothing in it
    // decides what is allowed.
    return await withRunContext({ taskId: task.id, traceId: task.traceId, agentKey: task.agentKey }, async () => {
      const agent = await prisma.agent.findUnique({ where: { key: task.agentKey } });
      if (!agent) return finishTask(task.id, "FAILED", { error: `No agent called ${task.agentKey}.` });
      if (agent.status === "RETIRED" || agent.status === "PAUSED") {
        return finishTask(task.id, "BLOCKED", { blockedReason: `${agent.name} is ${agent.status.toLowerCase()} and cannot work.` });
      }

      const saved = await loadCheckpoint(task.id);
      const counters: Counters = saved
        ? restoreCounters(saved.counters)
        : { toolCalls: 0, dryRun: 0, refused: 0, escalated: null, delegated: 0, consulted: 0, handedOff: 0, gapsRaised: 0 };
      // A resume must not carry the escalation that ended the last run, or the
      // task would go straight back to BLOCKED without doing anything. What the
      // Owner answered is already in the conversation by this point.
      counters.escalated = null;
      const startedFrom = saved?.state.iteration ?? 0;

      if (saved) {
        await step(task.id, "RESUMED", `${agent.name} picked this up where it left off, ${startedFrom} step(s) in.`, {
          data: { iteration: startedFrom, toolCalls: counters.toolCalls },
        });
      } else {
        await step(task.id, "STARTED", `${agent.name} picked this up.`);
      }

      const memories = await recall(agent.key, taskSubjects(task));
      const [system, granted, described] = await Promise.all([
        systemPrompt(agent, memories),
        toolsFor(agent, task, counters),
        describeTask(task),
      ]);
      const tools = granted.tools;
      // Appended to the brief rather than woven into it, so the task's own
      // words stay first and a reader can see where ours begin.
      const hint = likelyToolsLine(granted.likely);
      const brief = hint ? `${described}\n\n${hint}` : described;

      // Flipped by a checkpoint that finds the row no longer belongs to this run.
      // The only correct response is to stop touching it.
      let lostOwnership = false;

      // Set when this task's own ceiling stopped it, rather than a person. The
      // two use the same mechanism and must not reach the same ending — see
      // where this is read, below.
      let stoppedByBudget: BudgetState | null = null;

      try {
        const result = await runAgentLoop({
          purpose: `agent.${agent.key}`,
          system,
          prompt: brief,
          tools,
          effort: await effortUnderBudget(agent),
          resume: saved?.state ?? null,
          // What it said on the way, written down as it says it.
          //
          // `AgentStepKind.THOUGHT` has existed since the runtime shipped and
          // nothing ever wrote one. The loop collected every text block into
          // `narration`, kept it on the checkpoint, and handed it back at the
          // end inside `result` — so an agent's reasoning existed, was paid
          // for, and was visible to nobody until after the run was over, if
          // then. The timeline showed which tools were called and never once
          // showed *why*, which is the question anybody watching an agent
          // actually has.
          //
          // Written before the tool calls of the same turn, because that is
          // the order the model produced them: the sentence explaining the
          // call comes above the call.
          onText: async (text) => {
            await step(task.id, "THOUGHT", text);
          },
          onCheckpoint: async (state) => {
            const held = await saveCheckpoint(task.id, runOwner, state, { ...counters });
            if (!held) lostOwnership = true;
          },
          shouldStop: async () => {
            if (shuttingDown || lostOwnership) return true;
            const row = await prisma.agentTask.findUnique({
              where: { id: task.id },
              select: { interruptRequested: true, budgetUsd: true },
            });
            if (row?.interruptRequested) return true;

            // This one task's own ceiling. Read here because this is a point
            // where the conversation is whole — between iterations and between
            // tool calls — which is the same reason the interrupt is read here
            // and not wherever it happens to be noticed.
            //
            // Null is no ceiling, and **so is zero**: the same call
            // `Rehearsal.budgetUsd` makes, so that the one person who types 0
            // on purpose is not silently given the default instead.
            const ceiling = row?.budgetUsd === null || row?.budgetUsd === undefined ? null : Number(row.budgetUsd.toString());
            if (ceiling === null || ceiling <= 0) return false;

            const spent = await prisma.llmCall.aggregate({ where: { taskId: task.id }, _sum: { costUsd: true } });
            const spentUsd = Number((spent._sum.costUsd ?? 0).toString());
            if (spentUsd < ceiling) return false;

            stoppedByBudget = {
              scopeType: "GLOBAL",
              scopeId: task.id,
              period: "MONTH",
              spentUsd,
              softLimitUsd: null,
              hardLimitUsd: ceiling,
              fraction: spentUsd / ceiling,
              action: "pause",
              note: null,
            };
            return true;
          },
        });

        // Its own ceiling stopped it. Deliberately **not** the interrupt ending:
        // an interrupt returns the task to QUEUED, and a task over budget put
        // back in the queue is picked up on the next tick, stopped again before
        // it does anything, and requeued — once a minute, for ever, with
        // nothing on any screen to say why. BLOCKED keeps the checkpoint just
        // as an escalation does, so raising the ceiling and pressing Carry on
        // resumes the conversation rather than starting a new one.
        if (result.stoppedBecause === "interrupted" && stoppedByBudget) {
          const ceiling = stoppedByBudget as BudgetState;
          return finishTask(task.id, "BLOCKED", {
            blockedReason: `This task has spent $${ceiling.spentUsd.toFixed(2)}, which is at or past the $${(ceiling.hardLimitUsd ?? 0).toFixed(2)} ceiling set on it. Its place is kept — raise the ceiling and carry on, or leave it here.`,
            costUsd: result.costUsd,
            toolCalls: counters.toolCalls,
            dryRunCalls: counters.dryRun,
          });
        }

        // Stopped on request with its place kept. Not an outcome — an intermission.
        if (result.stoppedBecause === "interrupted") {
          return interruptedTask(task.id, runOwner, {
            costUsd: result.costUsd,
            toolCalls: counters.toolCalls,
            dryRunCalls: counters.dryRun,
            progressed: result.state.iteration > startedFrom,
          });
        }

        let summary: string;
        if (result.text && result.text.trim()) {
          summary = result.text.trim();
        } else {
          const parts: string[] = [];
          if (counters.toolCalls > 0) {
            parts.push(`made ${counters.toolCalls} tool${counters.toolCalls !== 1 ? " calls" : ""}`);
          }
          if (counters.dryRun > 0) {
            parts.push(`prepared ${counters.dryRun} action${counters.dryRun !== 1 ? "s" : ""} for approval`);
          }
          if (counters.refused > 0) {
            parts.push(`had ${counters.refused} call${counters.refused !== 1 ? "s" : ""} refused`);
          }
          if (counters.escalated) {
            parts.push(`escalated: ${String(counters.escalated).slice(0, 200)}`);
          }
          if (counters.delegated > 0) {
            parts.push(`delegated to ${counters.delegated} agent${counters.delegated !== 1 ? "s" : ""}`);
          }
          if (counters.consulted > 0) {
            parts.push(`consulted ${counters.consulted} colleague${counters.consulted !== 1 ? "s" : ""}`);
          }
          if (counters.gapsRaised > 0) {
            parts.push(`raised ${counters.gapsRaised} gap${counters.gapsRaised !== 1 ? "s" : ""}`);
          }
          if (parts.length === 0) {
            summary = "Finished, but said nothing about what it did.";
          } else {
            summary = `Completed ${parts.join(", ")}.`;
          }
        }

        // Three ways to finish, and they are genuinely different outcomes.
        if (counters.escalated) {
          return finishTask(task.id, "BLOCKED", {
            summary,
            blockedReason: counters.escalated,
            costUsd: result.costUsd,
            toolCalls: counters.toolCalls,
            dryRunCalls: counters.dryRun,
          });
        }

        // Everything it did was a preview. There is work here, and none of it
        // has taken effect — which is exactly what autonomy 1 is for.
        const needsApproval = counters.dryRun > 0;
        // The last thing an agent says is its summary, not a thought on the
        // way — and `onText` has already written it as one. Dropping that
        // duplicate here rather than not writing it in the first place,
        // because the loop cannot know which text block will turn out to be
        // the last one until the turn ends.
        await dropTrailingThought(task.id, summary);
        await step(task.id, "FINISHED", summary.slice(0, 500));

        return finishTask(task.id, needsApproval ? "NEEDS_APPROVAL" : "DONE", {
          summary,
          result: {
            narration: result.narration,
            stoppedBecause: result.stoppedBecause,
            delegated: counters.delegated,
            handedOff: counters.handedOff,
            consulted: counters.consulted,
            gapsRaised: counters.gapsRaised,
          },
          costUsd: result.costUsd,
          toolCalls: counters.toolCalls,
          dryRunCalls: counters.dryRun,
        });
      } catch (err) {
        const message = err instanceof AnalystError ? err.message : (err as Error).message;
        await step(task.id, "FAILED", message);

        // A rate limit is not a broken task — it goes back in the queue unless
        // it has already failed too many times. Its checkpoint is kept either
        // way, so the retry continues the conversation rather than repeating it.
        const retryable = err instanceof AnalystError && err.status === 429;
        const attempts = task.attempts + 1;
        if (retryable && attempts < MAX_ATTEMPTS) {
          await transition(task.id, {
            to: "QUEUED",
            reason: `Rate-limited by the model provider; waiting five minutes (attempt ${task.attempts}).`,
            actor: "runner",
            expect: ["RUNNING"],
            data: {
              scheduledFor: new Date(Date.now() + 5 * 60_000),
              error: message,
              runOwner: null,
              startedAt: null,
            },
          });
          return { status: "QUEUED", summary: null };
        }

        return finishTask(task.id, "FAILED", { error: message, costUsd: 0, toolCalls: counters.toolCalls });
      }
    });
  } finally {
    running.delete(taskId);
    if (claimedAgent) busyAgents.delete(claimedAgent);
  }
}

/**
 * Puts a run down mid-job without losing it.
 *
 * Back to QUEUED, not FAILED and not CANCELLED: nothing went wrong and there is
 * a conversation on disk the next tick will carry on. The one thing that must
 * happen here is the `attempts` reset — that counter exists to stop a task that
 * keeps dying being retried for ever, and a task interrupted four times by four
 * deploys is not that task. Progress is the test: if the conversation moved
 * forward, this run was work rather than a failure.
 */
async function interruptedTask(
  taskId: string,
  runOwner: string,
  data: { costUsd: number; toolCalls: number; dryRunCalls: number; progressed: boolean },
): Promise<RunOutcome> {
  await step(taskId, "INTERRUPTED", "Stopped part-way and kept its place. It carries on from here rather than starting again.");
  // Matched on the owner: a run that was reaped while it was stopping must not
  // drag the task that replaced it back into the queue.
  await transition(taskId, {
    to: "QUEUED",
    reason: data.progressed
      ? "Stopped part-way and kept its place; it had made progress, so the attempt count is reset."
      : "Stopped part-way and kept its place.",
    actor: "runner",
    expect: ["RUNNING"],
    guard: { runOwner },
    data: {
      runOwner: null,
      startedAt: null,
      interruptRequested: false,
      costUsd: data.costUsd.toFixed(6),
      toolCalls: data.toolCalls,
      dryRunCalls: data.dryRunCalls,
      ...(data.progressed ? { attempts: 0 } : {}),
    },
  });
  return { status: "QUEUED", summary: null };
}

/**
 * The endings that will never be continued.
 *
 * DONE and NEEDS_APPROVAL are finished work: the conversation behind them is
 * of no further use and holding it costs storage and a small amount of
 * confusion. Everything else keeps its checkpoint on purpose — a BLOCKED task
 * resumes when its question is answered, and a FAILED one resumes when
 * somebody presses Run, both of which should continue rather than repeat.
 */
const FINISHED_FOR_GOOD: AgentTask["status"][] = ["DONE", "NEEDS_APPROVAL"];

/**
 * Why a run ended, in a sentence for the history rather than a status name.
 *
 * "NEEDS_APPROVAL" on its own does not say whether three letters are waiting or
 * one lookup was held back, and that is the difference between reading the
 * queue tonight and reading it on Monday.
 */
function endingReason(status: AgentTask["status"], data: { blockedReason?: string; error?: string; dryRunCalls?: number }): string {
  if (status === "BLOCKED") return data.blockedReason ?? "Stopped and asked for a person.";
  if (status === "FAILED") return data.error ?? "The run failed.";
  if (status === "NEEDS_APPROVAL") {
    const n = data.dryRunCalls ?? 0;
    return `Prepared ${n} action${n === 1 ? "" : "s"} that need a decision; nothing took effect.`;
  }
  if (status === "DONE") return "Finished.";
  return `Ended as ${status}.`;
}

async function finishTask(
  taskId: string,
  status: AgentTask["status"],
  data: {
    summary?: string;
    result?: unknown;
    blockedReason?: string;
    error?: string;
    costUsd?: number;
    toolCalls?: number;
    dryRunCalls?: number;
  },
): Promise<RunOutcome> {
  // What this run actually burned, summed from the ledger.
  //
  // The obvious source is the checkpoint, and it is the wrong one twice over.
  // It is deleted for DONE and NEEDS_APPROVAL — so the only runs whose tokens
  // were knowable afterwards were the ones that failed — and a run that
  // finishes without ever needing to save its place does not write one at all,
  // which is every short task. `LlmCall` carries a `taskId` as of this pass, is
  // written by every model call whoever made it, and accumulates across
  // resumes because each run appends its own rows. It is simply the truth.
  const spent = await prisma.llmCall.aggregate({
    where: { taskId },
    _sum: { inputTokens: true, outputTokens: true },
  });

  if (FINISHED_FOR_GOOD.includes(status)) await clearCheckpoint(taskId);

  const moved = await transition(taskId, {
    to: status,
    reason: endingReason(status, data),
    actor: "runner",
    // Only over a task still running. A run whose task was reaped and requeued
    // while it was working must not write its outcome over the run that took
    // over — and it must not throw about it either, because being overtaken is
    // a normal thing that happens to a slow run, not a fault in this one.
    expect: ["RUNNING"],
    data: {
      finishedAt: new Date(),
      // The row is nobody's now. Left set, a stale owner would make the reaper
      // hesitate and a returning process think it still had the floor.
      runOwner: null,
      interruptRequested: false,
      summary: data.summary ?? undefined,
      result: (data.result ?? undefined) as never,
      blockedReason: data.blockedReason ?? null,
      error: data.error ?? null,
      inputTokens: spent._sum.inputTokens ?? 0,
      outputTokens: spent._sum.outputTokens ?? 0,
      ...(data.costUsd !== undefined ? { costUsd: data.costUsd.toFixed(6) } : {}),
      ...(data.toolCalls !== undefined ? { toolCalls: data.toolCalls } : {}),
      ...(data.dryRunCalls !== undefined ? { dryRunCalls: data.dryRunCalls } : {}),
    },
  });

  if (!moved.moved && moved.lostTo && moved.lostTo !== status) {
    console.warn(`[agent] ${taskId} was already ${moved.lostTo}; not writing ${status} over it.`);
  }

  // The two endings a person has to hear about.
  //
  // BLOCKED is an agent asking a question, and a question nobody hears is not
  // an escalation — it is an agent that stopped. FAILED is work that will not
  // happen unless somebody presses Run. Everything else is either finished or
  // already on a card of its own: NEEDS_APPROVAL posts one per prepared action
  // as it is prepared, which is the right grain, because the decision is about
  // the action rather than about the task.
  //
  // Only when this run is the one that ended it — a run overtaken by the
  // reaper must not announce an outcome it did not write. Imported here rather
  // than at the top for the same reason `invoke.ts` reaches for its card
  // builder late: the builder reads back across the services, and a cycle
  // through the runner shows up as an undefined export at boot. Not awaited,
  // and never fatal: Slack being down must not turn a question into a failure.
  if (moved.moved && (status === "BLOCKED" || status === "FAILED")) {
    void import("./escalationCards.js")
      .then(({ postTaskCard }) => postTaskCard(taskId))
      .catch((err: Error) => console.error("[agent] could not post the escalation card:", err.message));
  }

  const task = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { status: true, summary: true } });
  return { status: task?.status ?? status, summary: task?.summary ?? null };
}

// --- The queue --------------------------------------------------------------

/**
 * How long a run may go quiet before it is assumed dead.
 *
 * This used to be forty-five minutes measured from the *start* of the run,
 * because the start was the only thing recorded — which meant a container
 * killed thirty seconds into a task took its agent off the floor for the rest
 * of the hour. A heartbeat is written on every checkpoint, which is after every
 * model turn and after every tool call, so five minutes of silence is a run
 * that has genuinely stopped rather than one that is thinking.
 *
 * Generous against the slowest single step: one model turn at high effort with
 * a large conversation behind it, or one tool call that fetches a site,
 * photographs it twice and waits on Apify.
 */
const SILENT_FOR_MS = 5 * 60_000;

/**
 * A run that predates the heartbeat, or died before writing its first one.
 * Judged on `startedAt` instead, with the old generous timeout.
 */
const NEVER_BEAT_AFTER_MS = 45 * 60_000;

/**
 * Clears out runs whose process is gone, and hands their work back.
 *
 * A task is set RUNNING in the database and finished by the process that
 * claimed it. When that process dies — a deploy, a restart, an out-of-memory
 * kill — the row stays RUNNING for ever, and **since one agent may only hold
 * one task at a time, that one dead row now stops its agent working at all.**
 * Before that rule, a stranded task was one lost job; now it is an employee
 * who never comes back to their desk, so it has to be swept up.
 *
 * Requeued, never restarted. Whatever it had got to is on its checkpoint, so
 * the next runner rejoins the conversation — which is also why `attempts` is
 * no longer the right thing to fail on by itself: the cap now catches a task
 * that keeps dying *without progressing*, because any run that moves the
 * conversation forward resets it.
 *
 * Only rows this process is not actually running are touched, which is what
 * makes it safe to run on every tick: a task in the `running` set belongs to
 * somebody here and is left alone however long it has been going.
 */
async function reapAbandoned(now: Date): Promise<number> {
  const silent = new Date(now.getTime() - SILENT_FOR_MS);
  const ancient = new Date(now.getTime() - NEVER_BEAT_AFTER_MS);
  const abandoned = await prisma.agentTask.findMany({
    where: {
      status: "RUNNING",
      OR: [{ heartbeatAt: { lt: silent } }, { heartbeatAt: null, startedAt: { lt: ancient } }],
    },
    select: { id: true, agentKey: true, attempts: true, checkpoint: { select: { iteration: true } } },
  });

  const orphans = abandoned.filter((task) => !running.has(task.id));
  if (orphans.length === 0) return 0;

  for (const task of orphans) {
    const at = task.checkpoint?.iteration ?? 0;
    await step(
      task.id,
      "INTERRUPTED",
      at > 0
        ? `The process working on this stopped without finishing. ${at} step(s) were saved, and it carries on from there.`
        : "The process working on this stopped before it had done anything. It starts again from the brief.",
    );
    // Requeued rather than failed while it still has attempts left: a deploy
    // landing mid-task is the common cause, and the work is still wanted.
    const retryable = task.attempts < MAX_ATTEMPTS;
    await transition(
      task.id,
      retryable
        ? {
            to: "QUEUED",
            reason: `Heartbeat quiet and no live process owns it; requeued (attempt ${task.attempts} of ${MAX_ATTEMPTS}).`,
            actor: "reaper",
            data: {
              startedAt: null,
              runOwner: null,
              interruptRequested: false,
              error: "Picked up again after the previous run was interrupted.",
            },
          }
        : {
            to: "FAILED",
            reason: `Interrupted ${task.attempts} time(s) without getting any further.`,
            actor: "reaper",
            data: {
              finishedAt: now,
              runOwner: null,
              error: `Interrupted ${task.attempts} time(s) without getting any further. Something is stopping this run rather than it failing.`,
            },
          },
    );
    busyAgents.delete(task.agentKey);
  }

  console.warn(`[agent] recovered ${orphans.length} abandoned task(s)`);
  return orphans.length;
}

/**
 * Hands back every run this process was in the middle of when it last died.
 *
 * Called once at boot, before the first tick. `reapAbandoned` would get to
 * these eventually, but only after five minutes of a silence we already know
 * about: nothing is running in a process that has just started, so a RUNNING
 * row at this moment is by definition abandoned. Without it, the first minute
 * after every deploy has each interrupted agent standing at its desk unable to
 * take the task it is already holding.
 */
export async function resumeInterruptedTasks(): Promise<number> {
  const stranded = await prisma.agentTask.findMany({
    where: { status: "RUNNING" },
    select: { id: true, agentKey: true, checkpoint: { select: { iteration: true } } },
  });
  if (stranded.length === 0) return 0;

  for (const task of stranded) {
    const at = task.checkpoint?.iteration ?? 0;
    await step(
      task.id,
      "INTERRUPTED",
      at > 0
        ? `The service restarted mid-run. ${at} step(s) were saved, and this carries on from there.`
        : "The service restarted before this had got anywhere. It starts again from the brief.",
    );
    await transition(task.id, {
      to: "QUEUED",
      reason: "The service restarted while this was running; handed back to the queue.",
      actor: "boot",
      data: {
        startedAt: null,
        runOwner: null,
        interruptRequested: false,
        error: "The service restarted while this was running. It was picked up again.",
      },
    });
    busyAgents.delete(task.agentKey);
  }

  console.log(`  → ${stranded.length} interrupted agent task(s) returned to the queue, each from its own checkpoint`);
  return stranded.length;
}

/**
 * Runs whatever is due, up to the concurrency ceiling.
 *
 * Called once a minute by the scheduler. Only agents that are ACTIVE are
 * picked up: a DRAFT agent's queue fills and waits, which is what lets a task
 * be lined up before its agent is switched on.
 */
export async function runDueTasks(now = new Date(), limit = MAX_CONCURRENT): Promise<number> {
  // Before anything is picked up, because a task stuck in RUNNING now blocks
  // its agent rather than just itself.
  await reapAbandoned(now);

  const capacity = Math.max(0, limit - running.size);
  if (capacity === 0) return 0;

  // More than the capacity, because most of what comes back will be skipped:
  // a queue of eight tasks for one agent is one startable task and seven that
  // have to wait for it. Taking exactly `capacity` rows would find that agent
  // twice and start nothing.
  const due = await prisma.agentTask.findMany({
    where: {
      status: "QUEUED",
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
      agent: { status: "ACTIVE", tasks: { none: { status: "RUNNING" } } },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: capacity * 8,
    select: { id: true, agentKey: true },
  });
  if (due.length === 0) return 0;

  // One per agent, highest priority first — which the ordering above has
  // already decided, so the first task seen for an agent is the right one.
  const started: string[] = [];
  const takenThisTick = new Set<string>();
  let heldByBudget = 0;
  for (const task of due) {
    if (started.length >= capacity) break;
    if (running.has(task.id)) continue;
    if (busyAgents.has(task.agentKey) || takenThisTick.has(task.agentKey)) continue;

    // The cheapest place a ceiling can be enforced, and the safest: nothing has
    // started, so nothing is half-done. A task held here stays QUEUED with its
    // place kept and starts on the tick after the ceiling is raised or the
    // period rolls over — being over budget is the guardrail working, exactly
    // as being at the concurrency limit is, so neither is an error and neither
    // changes the task's status.
    const budget = await check(scopesForAgent(task.agentKey), now);
    if (budget.action === "pause") {
      heldByBudget += 1;
      continue;
    }

    takenThisTick.add(task.agentKey);
    started.push(task.id);
    // Deliberately not awaited: the scheduler tick must not be held open for
    // a job that takes two minutes, and each run manages its own state.
    void runTask(task.id).catch((err) => console.error(`[agent] task ${task.id} died:`, (err as Error).message));
  }
  if (started.length > 0) console.log(`[agent] started ${started.length} task(s)`);
  // Said out loud once per tick. A workforce that has quietly stopped looks
  // exactly like a workforce with nothing to do, and the whole point of a
  // ceiling somebody can live with is that they can tell when it has bitten.
  if (heldByBudget > 0) console.log(`[agent] ${heldByBudget} task(s) held: over a spending ceiling`);
  return started.length;
}

/** True when this agent is mid-task, so a screen can say "busy" rather than "queued for ever". */
export function isBusy(agentKey: string): boolean {
  return busyAgents.has(agentKey);
}

/** How many are in flight right now, for the dashboard. */
export function inFlight(): number {
  return running.size;
}
