import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Agent, AgentTask, AgentStepKind } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { runAgentLoop, type AgentTool, type AgentToolOutcome } from "../../lib/claudeAgent.js";
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
 * Claims one task and works it.
 *
 * The claim is a conditional update rather than a read-then-write: two runners
 * reaching for the same task is the one race that matters here, and the loser
 * has to find out before it starts spending money rather than after.
 */
export async function runTask(taskId: string): Promise<RunOutcome> {
  if (running.has(taskId)) return { status: "RUNNING", summary: null };
  running.add(taskId);

  // Set inside the claim below, and cleared in the same `finally` as the task
  // id — so an agent is freed by every exit, including a throw.
  let claimedAgent: string | null = null;

  try {
    const claimed = await prisma.agentTask.updateMany({
      where: {
        id: taskId,
        status: { in: ["QUEUED", "BLOCKED"] },
        // The rule, enforced where two processes can both see it. A relation
        // filter inside the conditional update means the loser of the race
        // finds out before it starts spending money rather than after.
        agent: { tasks: { none: { status: "RUNNING" } } },
      },
      data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, error: null, blockedReason: null },
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

    await step(task.id, "STARTED", `${agent.name} picked this up.`);

    const counters: Counters = { toolCalls: 0, dryRun: 0, refused: 0, escalated: null, delegated: 0 };
    const memories = await recall(agent.key, taskSubjects(task));
    const [system, tools, brief] = await Promise.all([
      systemPrompt(agent, memories),
      toolsFor(agent, task, counters),
      describeTask(task),
    ]);

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
      });

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
      // it has already failed too many times.
      const retryable = err instanceof AnalystError && err.status === 429;
      const attempts = task.attempts + 1;
      if (retryable && attempts < MAX_ATTEMPTS) {
        await prisma.agentTask.update({
          where: { id: task.id },
          data: { status: "QUEUED", scheduledFor: new Date(Date.now() + 5 * 60_000), error: message },
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
  const task = await prisma.agentTask.update({
    where: { id: taskId },
    data: {
      status,
      finishedAt: new Date(),
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
 * How long a run may take before it is assumed dead.
 *
 * A real run is bounded: sixteen iterations, each capped by the SDK's own
 * timeout, so a long one is minutes rather than an hour. This is generous
 * against that, because reaping a task that was only slow would kill work that
 * had already been paid for.
 */
const ABANDONED_AFTER_MS = 45 * 60_000;

/**
 * Clears out runs whose process is gone.
 *
 * A task is set RUNNING in the database and finished by the process that
 * claimed it. When that process dies — a deploy, a restart, an out-of-memory
 * kill — the row stays RUNNING for ever, and **since one agent may only hold
 * one task at a time, that one dead row now stops its agent working at all.**
 * Before that rule, a stranded task was one lost job; now it is an employee
 * who never comes back to their desk, so it has to be swept up.
 *
 * Only rows this process is not actually running are touched, which is what
 * makes it safe to run on every tick: a task in the `running` set belongs to
 * somebody here and is left alone however long it has been going.
 */
async function reapAbandoned(now: Date): Promise<number> {
  const stale = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const abandoned = await prisma.agentTask.findMany({
    where: { status: "RUNNING", startedAt: { lt: stale } },
    select: { id: true, agentKey: true, attempts: true },
  });

  const orphans = abandoned.filter((task) => !running.has(task.id));
  if (orphans.length === 0) return 0;

  for (const task of orphans) {
    await step(task.id, "FAILED", "This run was abandoned — the process working on it stopped before it finished.");
    // Requeued rather than failed while it still has attempts left: a deploy
    // landing mid-task is the common cause, and the work is still wanted.
    const retryable = task.attempts < MAX_ATTEMPTS;
    await prisma.agentTask.update({
      where: { id: task.id },
      data: retryable
        ? { status: "QUEUED", startedAt: null, error: "Picked up again after the previous run was interrupted." }
        : {
            status: "FAILED",
            finishedAt: now,
            error: `Abandoned ${task.attempts} time(s) without finishing. Something is stopping this run rather than it failing.`,
          },
    });
    busyAgents.delete(task.agentKey);
  }

  console.warn(`[agent] recovered ${orphans.length} abandoned task(s)`);
  return orphans.length;
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
