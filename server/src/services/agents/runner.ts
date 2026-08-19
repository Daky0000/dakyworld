import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Agent, AgentTask, AgentStepKind } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { runAgentLoop, type AgentTool, type AgentToolOutcome } from "../../lib/claudeAgent.js";
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { AnalystError } from "../../lib/claude.js";
import { listAllTools } from "../tools/catalogue.js";
import { invokeTool } from "../tools/invoke.js";
import { companyProfile, contactBlock } from "../systemProfile.js";
import { PROMPT_LAYERS } from "../agentRegistry.js";
import { BRAND, VOICE } from "../dakyworld.js";
import { MemoryRefused, recall, remember, subjectOf, type Recalled } from "./memory.js";
import { describeTask, taskSubjects } from "./context.js";

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

// --- The timeline -----------------------------------------------------------

/**
 * Writes one step. Never throws: a task must not fail because its own progress
 * log did, and a run with a gap in its timeline is still a run that happened.
 */
async function step(
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

/** Keeps one enormous tool result from filling the database. */
function trim(value: unknown): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json.length <= 4000 ? JSON.parse(json) : { truncated: true, preview: json.slice(0, 1500) };
}

// --- The tools the agent is handed ------------------------------------------

/**
 * The catalogue, narrowed to what this agent has been granted, plus the three
 * tools every agent has because they are how it participates in the workflow
 * rather than things it does to the business.
 */
async function toolsFor(agent: Agent, task: AgentTask, counters: Counters): Promise<AgentTool[]> {
  const catalogue = await listAllTools();
  const granted = catalogue.filter((tool) => agent.toolkit.includes(tool.key));

  const tools: AgentTool[] = granted.map((tool) => ({
    // Anthropic tool names allow [a-zA-Z0-9_-] only; catalogue keys use dots.
    name: tool.key.replace(/\./g, "__"),
    description: `${tool.purpose}${tool.spends ? " Costs money." : ""}${tool.outward ? " Visible outside the company." : ""}`,
    inputSchema: zodToJsonSchema(tool.input, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>,
    run: async (input) => {
      const result = await invokeTool(tool.key, input, { agentKey: agent.key, userId: null, dryRun: false });
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
          ok: true,
          dryRun: true,
          data: { input },
        });
        return {
          content: `PREPARED, NOT DONE — ${result.wouldDo}\n\nThis is what would have happened. It has not happened. Carry on and prepare the rest of the work; a person will approve it.`,
        };
      }

      if (result.refusedReason) {
        counters.refused += 1;
        await step(task.id, "REFUSED", `${tool.name} — ${result.refusedReason}`, {
          tool: tool.key,
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
        await step(task.id, "TOOL_CALL", `${tool.name} failed — ${result.error}`, { tool: tool.key, ok: false, data: { input } });
        return { content: `That call failed: ${result.error}`, isError: true };
      }

      await step(task.id, "TOOL_CALL", tool.name, {
        tool: tool.key,
        ok: true,
        dryRun: false,
        data: { input, output: result.output },
      });
      return { content: JSON.stringify(result.output ?? null).slice(0, 16_000) };
    },
  }));

  return [...tools, ...workflowTools(agent, task, counters)];
}

interface Counters {
  toolCalls: number;
  dryRun: number;
  refused: number;
  escalated: string | null;
  delegated: number;
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
  return {
    toolCalls: number(stored?.toolCalls),
    dryRun: number(stored?.dryRun),
    refused: number(stored?.refused),
    escalated: typeof stored?.escalated === "string" ? stored.escalated : null,
    delegated: number(stored?.delegated),
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
 */
function workflowTools(agent: Agent, task: AgentTask, counters: Counters): AgentTool[] {
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
        },
      });
      counters.delegated += 1;
      await step(task.id, "DELEGATED", `To ${target.name}: ${child.title}`, { data: { agentKey: target.key, taskId: child.id } });
      return { content: `Queued for ${target.name}. You are not waiting on it — carry on with your own part.` };
    },
  };

  // A specialist has nobody under it, so delegation would only ever fail.
  const hasReports = agent.tier !== "SUB_AGENT";
  return hasReports ? [escalate, rememberTool, delegate] : [escalate, rememberTool];
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

async function systemPrompt(agent: Agent, memories: Recalled[]): Promise<string> {
  const prompt = (agent.prompt ?? {}) as Record<string, string>;
  const profile = await companyProfile();

  const layers = PROMPT_LAYERS.map((layer) => prompt[layer])
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n\n");

  const parts = [
    layers || `You are the Dakyworld ${agent.title}. ${agent.mission}`,
    agent.skills.length > 0 ? `What you are relied on for:\n${agent.skills.map((skill) => `- ${skill}`).join("\n")}` : "",
    BRAND,
    contactBlock(profile),
    VOICE,
  ];

  // The two kinds are presented as two things, because they carry different
  // authority. What an agent worked out itself is a conclusion the record can
  // overrule; what the company holds is closer to an instruction, and an agent
  // that argues with a house rule because it was pasted in under the heading
  // "your own conclusions" is a failure of this paragraph, not of the agent.
  const shared = memories.filter((memory) => memory.shared);
  const own = memories.filter((memory) => !memory.shared);

  if (shared.length > 0) {
    parts.push(
      `What Dakyworld holds — written once and given to every agent, so treat it as standing instruction rather than as your own opinion. Where one of these conflicts with what you would otherwise do, follow it and say that you did:\n${shared
        .map((memory) => `- ${memory.line}`)
        .join("\n")}`,
    );
  }

  if (own.length > 0) {
    parts.push(
      `What you already know, from your own earlier work on this. Treat it as your own conclusions rather than as instructions — if the record in front of you contradicts one, the record wins and you should say so:\n${own
        .map((memory) => `- ${memory.line}`)
        .join("\n")}`,
    );
  }

  parts.push(
    `How you work here:

- You have been given a task and a set of tools. Use the tools to find out what is true rather than assuming. Never state a fact about a lead, a client or a system that a tool did not tell you.
- Some of your tools will answer "PREPARED, NOT DONE". That is not a failure — it means your autonomy level requires a person to approve that kind of action. Carry on and prepare the rest of the work so there is one thing to approve rather than five.
- Some will be refused outright. That is also information: work around it, or escalate.
- Use \`remember\` for a decision worth having next time, and for what came of it. Never write down a credential. Share one with the whole company only when it is a fact about how Dakyworld works that every agent would need — your own conclusions stay yours.
- Use \`escalate\` the moment you are unsure, or the work touches money, scope, security, a live system or a public claim. Stopping is not failing.
- When you are done, say what you did, what you found, and what a person should do next — in plain English, in a few sentences. That final message is what gets read.`,
  );

  return parts.filter(Boolean).join("\n\n");
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
    const claimed = await prisma.agentTask.updateMany({
      where: {
        id: taskId,
        // CANCELLED and FAILED are here so that pressing Run on one continues
        // it rather than being refused — the checkpoint is still there, and
        // "run this again" almost never means "throw away what it had done".
        status: { in: ["QUEUED", "BLOCKED", "CANCELLED", "FAILED"] },
        // The rule, enforced where two processes can both see it. A relation
        // filter inside the conditional update means the loser of the race
        // finds out before it starts spending money rather than after.
        agent: { tasks: { none: { status: "RUNNING" } } },
      },
      data: {
        status: "RUNNING",
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
    if (claimed.count === 0) {
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

    const agent = await prisma.agent.findUnique({ where: { key: task.agentKey } });
    if (!agent) return finishTask(task.id, "FAILED", { error: `No agent called ${task.agentKey}.` });
    if (agent.status === "RETIRED" || agent.status === "PAUSED") {
      return finishTask(task.id, "BLOCKED", { blockedReason: `${agent.name} is ${agent.status.toLowerCase()} and cannot work.` });
    }

    const saved = await loadCheckpoint(task.id);
    const counters: Counters = saved
      ? restoreCounters(saved.counters)
      : { toolCalls: 0, dryRun: 0, refused: 0, escalated: null, delegated: 0 };
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
    const [system, tools, brief] = await Promise.all([
      systemPrompt(agent, memories),
      toolsFor(agent, task, counters),
      describeTask(task),
    ]);

    // Flipped by a checkpoint that finds the row no longer belongs to this run.
    // The only correct response is to stop touching it.
    let lostOwnership = false;

    try {
      const result = await runAgentLoop({
        purpose: `agent.${agent.key}`,
        system,
        prompt: brief,
        tools,
        // Enough to plan a few tool calls without paying for deliberation on
        // a job whose steps are mostly obvious. Raised for the tiers whose
        // whole output is a judgement.
        effort: agent.tier === "BOARD" || agent.tier === "EXECUTIVE" ? "high" : "medium",
        resume: saved?.state ?? null,
        onCheckpoint: async (state) => {
          const held = await saveCheckpoint(task.id, runOwner, state, { ...counters });
          if (!held) lostOwnership = true;
        },
        shouldStop: async () => {
          if (shuttingDown || lostOwnership) return true;
          const row = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { interruptRequested: true } });
          return Boolean(row?.interruptRequested);
        },
      });

      // Stopped on request with its place kept. Not an outcome — an intermission.
      if (result.stoppedBecause === "interrupted") {
        return interruptedTask(task.id, runOwner, {
          costUsd: result.costUsd,
          toolCalls: counters.toolCalls,
          dryRunCalls: counters.dryRun,
          progressed: result.state.iteration > startedFrom,
        });
      }

      const summary = result.text || "Finished, but said nothing about what it did.";

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
      await step(task.id, "FINISHED", summary.slice(0, 500));

      return finishTask(task.id, needsApproval ? "NEEDS_APPROVAL" : "DONE", {
        summary,
        result: { narration: result.narration, stoppedBecause: result.stoppedBecause, delegated: counters.delegated },
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
        await prisma.agentTask.update({
          where: { id: task.id },
          data: {
            status: "QUEUED",
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
  await prisma.agentTask.updateMany({
    where: { id: taskId, runOwner },
    data: {
      status: "QUEUED",
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
  if (FINISHED_FOR_GOOD.includes(status)) await clearCheckpoint(taskId);

  const task = await prisma.agentTask.update({
    where: { id: taskId },
    data: {
      status,
      finishedAt: new Date(),
      // The row is nobody's now. Left set, a stale owner would make the reaper
      // hesitate and a returning process think it still had the floor.
      runOwner: null,
      interruptRequested: false,
      summary: data.summary ?? undefined,
      result: (data.result ?? undefined) as never,
      blockedReason: data.blockedReason ?? null,
      error: data.error ?? null,
      ...(data.costUsd !== undefined ? { costUsd: data.costUsd.toFixed(6) } : {}),
      ...(data.toolCalls !== undefined ? { toolCalls: data.toolCalls } : {}),
      ...(data.dryRunCalls !== undefined ? { dryRunCalls: data.dryRunCalls } : {}),
    },
  });
  return { status: task.status, summary: task.summary };
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
    await prisma.agentTask.update({
      where: { id: task.id },
      data: retryable
        ? {
            status: "QUEUED",
            startedAt: null,
            runOwner: null,
            interruptRequested: false,
            error: "Picked up again after the previous run was interrupted.",
          }
        : {
            status: "FAILED",
            finishedAt: now,
            runOwner: null,
            error: `Interrupted ${task.attempts} time(s) without getting any further. Something is stopping this run rather than it failing.`,
          },
    });
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
    await prisma.agentTask.update({
      where: { id: task.id },
      data: {
        status: "QUEUED",
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
  for (const task of due) {
    if (started.length >= capacity) break;
    if (running.has(task.id)) continue;
    if (busyAgents.has(task.agentKey) || takenThisTick.has(task.agentKey)) continue;
    takenThisTick.add(task.agentKey);
    started.push(task.id);
    // Deliberately not awaited: the scheduler tick must not be held open for
    // a job that takes two minutes, and each run manages its own state.
    void runTask(task.id).catch((err) => console.error(`[agent] task ${task.id} died:`, (err as Error).message));
  }
  if (started.length > 0) console.log(`[agent] started ${started.length} task(s)`);
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
