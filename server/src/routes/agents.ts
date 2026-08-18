import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { listAllTools, resolveTool } from "../services/tools/catalogue.js";
import { toolReadiness } from "../services/tools/readiness.js";
import { permissionFor } from "../services/tools/invoke.js";
import { runTask } from "../services/agents/runner.js";
import { MemoryRefused, forget, listMemories, remember } from "../services/agents/memory.js";

/**
 * The workforce.
 *
 * Autonomy, dry run and the toolkit are what the Owner may change, and only
 * the Owner: between them they decide whether anything an agent works out can
 * reach a client, a card or the public site. Everything else about an agent —
 * its mission, its prompt, who it reports to — is seeded from code and changed
 * in a diff, not at runtime.
 *
 * **The toolkit is a real grant.** It used to be a list of strings nothing
 * read; since the tool layer landed it is the allow-list the invoker checks
 * before every call, so adding a key here gives an agent a capability and
 * removing one takes it away. Which is why this endpoint refuses a key that
 * isn't in the catalogue rather than storing it: an agent granted a tool that
 * doesn't exist looks equipped and is not.
 */
export const agentsRouter = Router();

agentsRouter.use(requireRole("OWNER"));
const DEPARTMENTS = [
  "EXECUTIVE",
  "REVENUE",
  "DELIVERY",
  "FINANCE",
  "MARKETING",
  "TECHNOLOGY",
  "CLIENT",
  "RISK",
  "PEOPLE",
] as const;


agentsRouter.get("/", async (_req, res, next) => {
  try {
    const agents = await prisma.agent.findMany({
      orderBy: [{ tier: "asc" }, { department: "asc" }, { name: "asc" }],
    });

    // One grouped query rather than a count per agent: the roster is 27 cards
    // and 27 round trips to draw a dot would be indefensible.
    const workload = await prisma.agentTask.groupBy({
      by: ["agentKey", "status"],
      where: { status: { in: ["RUNNING", "QUEUED", "NEEDS_APPROVAL", "BLOCKED"] } },
      _count: true,
    });
    const workByAgent = new Map<string, { running: number; queued: number; waiting: number }>();
    for (const row of workload) {
      const current = workByAgent.get(row.agentKey) ?? { running: 0, queued: 0, waiting: 0 };
      if (row.status === "RUNNING") current.running += row._count;
      else if (row.status === "QUEUED") current.queued += row._count;
      else current.waiting += row._count;
      workByAgent.set(row.agentKey, current);
    }

    // The roster is small; grouping it here keeps the page from re-deriving it.
    const byKey = new Map(agents.map((a) => [a.key, a.name]));
    res.json({
      agents: agents.map((a) => ({
        ...a,
        managerName: a.managerKey ? (byKey.get(a.managerKey) ?? null) : null,
        work: workByAgent.get(a.key) ?? { running: 0, queued: 0, waiting: 0 },
      })),
      summary: {
        total: agents.length,
        active: agents.filter((a) => a.status === "ACTIVE").length,
        specialists: agents.filter((a) => a.tier === "SUB_AGENT").length,
        // The number that matters: how much can act without being asked.
        aboveDraft: agents.filter((a) => a.autonomyLevel > 2 || !a.dryRun).length,
        working: [...workByAgent.values()].reduce((total, work) => total + work.running, 0),
        waiting: [...workByAgent.values()].reduce((total, work) => total + work.waiting, 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get("/:key", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });
    const manager = agent.managerKey ? await prisma.agent.findUnique({ where: { key: agent.managerKey } }) : null;
    const reports = await prisma.agent.findMany({ where: { managerKey: agent.key }, select: { key: true, name: true, title: true } });

    // What this agent can actually do right now, which is the toolkit crossed
    // with what is configured and what its autonomy allows. Three different
    // reasons a granted tool might not fire, and all three are worth seeing
    // here rather than discovering in a failed run.
    const catalogue = await listAllTools();
    const tools = await Promise.all(
      catalogue.map(async (tool) => {
        const [readiness, permission] = await Promise.all([
          toolReadiness(tool.requires),
          permissionFor(tool, { agentKey: agent.key, userId: null, dryRun: false }),
        ]);
        return {
          key: tool.key,
          name: tool.name,
          group: tool.group,
          purpose: tool.purpose,
          scope: tool.scope,
          spends: tool.spends,
          outward: tool.outward,
          granted: agent.toolkit.includes(tool.key),
          ready: readiness.ready,
          blockedReason: readiness.reason,
          mustDryRun: permission.mustDryRun,
          permissionNote: permission.reason,
        };
      }),
    );

    const [work, memories] = await Promise.all([
      prisma.agentTask.groupBy({ by: ["status"], where: { agentKey: agent.key }, _count: true }),
      prisma.agentMemory.count({ where: { agentKey: agent.key } }),
    ]);
    const byStatus = Object.fromEntries(work.map((row) => [row.status, row._count]));

    res.json({
      ...agent,
      managerName: manager?.name ?? null,
      reports,
      tools,
      // The two numbers that decide whether the drawer is worth opening.
      work: {
        running: byStatus.RUNNING ?? 0,
        queued: byStatus.QUEUED ?? 0,
        waiting: (byStatus.NEEDS_APPROVAL ?? 0) + (byStatus.BLOCKED ?? 0),
        done: byStatus.DONE ?? 0,
        failed: byStatus.FAILED ?? 0,
      },
      memories,
    });
  } catch (err) {
    next(err);
  }
});

const patchInput = z.object({
  /** 0 observe · 1 draft · 2 recommend · 3 execute-with-policy · 4 autonomous · 5 delegated. */
  autonomyLevel: z.number().int().min(0).max(5).optional(),
  dryRun: z.boolean().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "RETIRED"]).optional(),
  /** Catalogue keys this agent may call. Replaces the list wholesale. */
  toolkit: z.array(z.string().max(64)).max(60).optional(),
  // Everything below is wording, and a seeded agent's wording is a diff — see
  // the guard in the handler. Only an agent the Owner created can be rewritten
  // here, which is what keeps a deploy able to improve the shipped prompts
  // without arguing with the database.
  name: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(120).optional(),
  mission: z.string().min(1).max(600).optional(),
  skills: z.array(z.string().max(80)).max(24).optional(),
  kpis: z.array(z.string().max(120)).max(12).optional(),
  responsibilities: z.array(z.string().max(160)).max(12).optional(),
  escalationPolicy: z.string().max(600).optional(),
  avatar: z.string().max(4).nullish(),
  managerKey: z.string().max(64).nullish(),
  department: z.enum(DEPARTMENTS).optional(),
  prompt: z.record(z.string().max(2000)).optional(),
});


agentsRouter.patch("/:key", async (req, res, next) => {
  try {
    const input = patchInput.parse(req.body);
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    // A seeded agent's wording lives in services/agentRegistry.ts and is
    // changed in a diff, so a deploy can improve it. Only an agent the Owner
    // created here can be rewritten here; the permission fields below are
    // editable on both, because those are the Owner's alone either way.
    const rewriting = ["name", "title", "mission", "skills", "kpis", "responsibilities", "escalationPolicy", "avatar", "managerKey", "department", "prompt"].filter(
      (field) => input[field as keyof typeof input] !== undefined,
    );
    if (rewriting.length > 0 && !agent.custom) {
      return res.status(409).json({
        error: `${agent.name} is a built-in agent, so its wording is changed in the code rather than here. Autonomy, dry run, status and its toolkit are yours to change.`,
        fields: rewriting,
      });
    }

    // Level 5 is delegated authority over money and legal exposure. The
    // blueprint reserves it for a board decision, so it is not a UI toggle.
    if (input.autonomyLevel === 5) {
      return res.status(403).json({
        error: "Level 5 is delegated authority and can't be set from here — it needs a recorded owner decision first.",
      });
    }

    // A key with nothing behind it is an agent that looks equipped and can't
    // act, so it is dropped rather than stored — but dropped *and reported*,
    // because a grant silently disappearing is its own kind of lie. This is
    // also how a database seeded before the tool layer sheds the handful of
    // names that never had code behind them: the first save cleans them up.
    const known = new Set((await listAllTools()).map((tool) => tool.key));
    const dropped = input.toolkit?.filter((key) => !known.has(key)) ?? [];
    const data = { ...input, ...(input.toolkit ? { toolkit: input.toolkit.filter((key) => known.has(key)) } : {}) };

    const updated = await prisma.agent.update({ where: { key: req.params.key }, data });
    res.json({ ...updated, ...(dropped.length ? { droppedGrants: dropped } : {}) });
  } catch (err) {
    next(err);
  }
});

/**
 * A specialist the Owner hires.
 *
 * The nine shipped specialists are the crafts Dakyworld already sells. They
 * will not be the last — the next one is a 3D artist, a bookkeeper, a
 * translator — and every one of those needing a deploy would make the roster a
 * developer's list rather than the Owner's. So a custom agent is a real row
 * with `custom: true`: the seed never touches it, a deploy never overwrites
 * it, and unlike a built-in one its wording can be rewritten here.
 *
 * It lands at autonomy 1 with dry run on, exactly as the seeded ones do, and
 * the create call cannot say otherwise. Hiring somebody and handing them the
 * company card are two decisions.
 */
const createInput = z.object({
  key: z
    .string()
    .min(3)
    .max(48)
    .regex(/^[a-z][a-z0-9.]*[a-z0-9]$/, "Lowercase letters, numbers and dots, e.g. design.3d."),
  name: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  department: z.enum(DEPARTMENTS),
  /** Who it reports to. A specialist with no manager escalates into nothing. */
  managerKey: z.string().max(64),
  mission: z.string().min(10).max(600),
  skills: z.array(z.string().max(80)).max(24).default([]),
  kpis: z.array(z.string().max(120)).max(12).default([]),
  toolkit: z.array(z.string().max(64)).max(60).default([]),
  escalationPolicy: z.string().max(600).default("Escalates anything touching money, scope, security, a live system or a public claim."),
  avatar: z.string().max(4).nullish(),
  prompt: z.record(z.string().max(2000)).default({}),
});

agentsRouter.post("/", async (req, res, next) => {
  try {
    const input = createInput.parse(req.body);
    if (await prisma.agent.findUnique({ where: { key: input.key } })) {
      return res.status(409).json({ error: `There is already an agent with the key ${input.key}.` });
    }
    const manager = await prisma.agent.findUnique({ where: { key: input.managerKey } });
    if (!manager) return res.status(400).json({ error: `No agent called ${input.managerKey} to report to.` });

    const known = new Set((await listAllTools()).map((tool) => tool.key));
    const dropped = input.toolkit.filter((key) => !known.has(key));

    const agent = await prisma.agent.create({
      data: {
        key: input.key,
        name: input.name,
        title: input.title,
        tier: "SUB_AGENT",
        department: input.department,
        managerKey: input.managerKey,
        // Not negotiable on create, for the reason above.
        status: "DRAFT",
        autonomyLevel: 1,
        dryRun: true,
        mission: input.mission,
        responsibilities: [],
        skills: input.skills,
        kpis: input.kpis,
        toolkit: input.toolkit.filter((key) => known.has(key)),
        escalationPolicy: input.escalationPolicy,
        avatar: input.avatar ?? null,
        prompt: input.prompt as unknown as object,
        custom: true,
      },
    });
    res.status(201).json({ ...agent, ...(dropped.length ? { droppedGrants: dropped } : {}) });
  } catch (err) {
    next(err);
  }
});

/**
 * Removes a custom agent. A seeded one is retired instead — deleting it would
 * only mean the next deploy recreated it at its seeded settings, which is a
 * worse outcome than the row staying with RETIRED on it.
 */
agentsRouter.delete("/:key", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });
    if (!agent.custom) {
      return res.status(409).json({
        error: `${agent.name} is a built-in agent. Set it to Retired instead — deleting it would only mean the next deploy created it again.`,
      });
    }
    const reports = await prisma.agent.count({ where: { managerKey: agent.key } });
    if (reports > 0) {
      return res.status(409).json({ error: `${reports} agent(s) report to ${agent.name}. Move them first.` });
    }
    await prisma.agent.delete({ where: { key: agent.key } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- The work ---------------------------------------------------------------

/**
 * What an agent is doing, has done, and is waiting to do.
 *
 * The roster answers "who could do this" and the toolkit answers "what are
 * they allowed to do". This answers the question anybody actually asks of a
 * workforce — what is happening right now — and it is the reason the agent
 * drawer is worth opening.
 */
const taskInclude = {
  agent: { select: { key: true, name: true, title: true, avatar: true } },
  _count: { select: { steps: true, children: true } },
} as const;

function taskSummary(task: {
  id: string;
  title: string;
  status: string;
  priority: number;
  origin: string;
  summary: string | null;
  blockedReason: string | null;
  error: string | null;
  costUsd: unknown;
  toolCalls: number;
  dryRunCalls: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  scheduledFor: Date | null;
  dueAt: Date | null;
  createdAt: Date;
  agent: { key: string; name: string; title: string; avatar: string | null };
  _count: { steps: number; children: number };
}) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    origin: task.origin,
    summary: task.summary,
    blockedReason: task.blockedReason,
    error: task.error,
    costUsd: Number(task.costUsd),
    toolCalls: task.toolCalls,
    dryRunCalls: task.dryRunCalls,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    scheduledFor: task.scheduledFor,
    dueAt: task.dueAt,
    createdAt: task.createdAt,
    agent: task.agent,
    steps: task._count.steps,
    delegated: task._count.children,
  };
}

/** Everything on one agent's plate, split the way a person reads it. */
agentsRouter.get("/:key/tasks", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    const tasks = await prisma.agentTask.findMany({
      where: { agentKey: agent.key },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      include: taskInclude,
    });

    const rows = tasks.map(taskSummary);
    const inState = (...states: string[]) => rows.filter((task) => states.includes(task.status));

    res.json({
      // Running first, because it is the only one that is changing while you look.
      running: inState("RUNNING"),
      queued: inState("QUEUED"),
      waiting: inState("NEEDS_APPROVAL", "BLOCKED"),
      finished: inState("DONE", "FAILED", "CANCELLED").slice(0, 30),
      summary: {
        running: inState("RUNNING").length,
        queued: inState("QUEUED").length,
        waiting: inState("NEEDS_APPROVAL", "BLOCKED").length,
        done: rows.filter((task) => task.status === "DONE").length,
        // Thirty days of spend, which is the window the Tools screen uses too.
        spendUsd: rows
          .filter((task) => task.createdAt.getTime() > Date.now() - 30 * 86_400_000)
          .reduce((total, task) => total + task.costUsd, 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

const newTaskInput = z.object({
  title: z.string().min(3).max(120),
  brief: z.string().min(10).max(4000),
  priority: z.number().int().min(1).max(3).default(2),
  scheduledFor: z.coerce.date().nullish(),
  dueAt: z.coerce.date().nullish(),
  input: z.record(z.unknown()).nullish(),
  leadId: z.string().cuid().nullish(),
  clientId: z.string().cuid().nullish(),
  projectId: z.string().cuid().nullish(),
  proposalId: z.string().cuid().nullish(),
  invoiceId: z.string().cuid().nullish(),
  /** Starts it now rather than waiting for the next tick. */
  runNow: z.boolean().default(false),
});

agentsRouter.post("/:key/tasks", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });
    if (agent.status === "RETIRED") return res.status(409).json({ error: `${agent.name} is retired and cannot take work.` });

    const input = newTaskInput.parse(req.body);
    const task = await prisma.agentTask.create({
      data: {
        agentKey: agent.key,
        title: input.title,
        brief: input.brief,
        priority: input.priority,
        origin: "OWNER",
        createdById: req.dbUser?.id ?? null,
        scheduledFor: input.scheduledFor ?? null,
        dueAt: input.dueAt ?? null,
        input: (input.input ?? undefined) as never,
        leadId: input.leadId ?? null,
        clientId: input.clientId ?? null,
        projectId: input.projectId ?? null,
        proposalId: input.proposalId ?? null,
        invoiceId: input.invoiceId ?? null,
      },
      include: taskInclude,
    });

    // Not awaited: a run takes minutes and the request should not.
    if (input.runNow && agent.status === "ACTIVE" && !input.scheduledFor) {
      void runTask(task.id).catch((err) => console.error(`[agent] ${task.id} died:`, (err as Error).message));
    }

    res.status(201).json({
      task: taskSummary(task),
      // Said plainly rather than left to be discovered: a task queued against
      // an agent that is still a draft will sit there until it is activated.
      note:
        agent.status === "ACTIVE"
          ? null
          : `${agent.name} is a ${agent.status.toLowerCase()} and will not pick this up until you set it to Active.`,
    });
  } catch (err) {
    next(err);
  }
});

/** One task, with its whole timeline. What the drawer polls while it runs. */
agentsRouter.get("/tasks/:id", async (req, res, next) => {
  try {
    const task = await prisma.agentTask.findUnique({
      where: { id: req.params.id },
      include: {
        ...taskInclude,
        steps: { orderBy: { seq: "asc" } },
        parent: { select: { id: true, title: true, agent: { select: { name: true } } } },
        children: { select: { id: true, title: true, status: true, agent: { select: { key: true, name: true } } } },
        lead: { select: { id: true, contactName: true, companyName: true } },
        client: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        proposal: { select: { id: true, title: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
      },
    });
    if (!task) return res.status(404).json({ error: "No such task." });

    res.json({
      ...taskSummary(task),
      brief: task.brief,
      input: task.input,
      result: task.result,
      attempts: task.attempts,
      steps: task.steps,
      parent: task.parent,
      children: task.children,
      about: {
        lead: task.lead,
        client: task.client,
        project: task.project,
        proposal: task.proposal,
        invoice: task.invoice,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Runs a task now.
 *
 * Also how a BLOCKED task is resumed: the runner claims QUEUED and BLOCKED
 * alike, so answering an escalation is a matter of adding what was missing to
 * the brief and pressing this.
 */
agentsRouter.post("/tasks/:id/run", async (req, res, next) => {
  try {
    const task = await prisma.agentTask.findUnique({ where: { id: req.params.id }, include: { agent: true } });
    if (!task) return res.status(404).json({ error: "No such task." });
    if (task.status === "RUNNING") return res.status(409).json({ error: "That one is already running." });
    if (task.agent.status !== "ACTIVE") {
      return res.status(409).json({ error: `${task.agent.name} is a ${task.agent.status.toLowerCase()} — set it to Active first.` });
    }

    // An answer to an escalation, appended rather than replacing the brief:
    // what it was originally asked stays on the record.
    const { answer } = z.object({ answer: z.string().max(2000).optional() }).parse(req.body ?? {});
    if (answer?.trim()) {
      await prisma.agentTask.update({
        where: { id: task.id },
        data: { brief: `${task.brief}\n\n--- Answer from the Owner ---\n${answer.trim()}` },
      });
    }

    void runTask(task.id).catch((err) => console.error(`[agent] ${task.id} died:`, (err as Error).message));
    res.json({ started: true });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post("/tasks/:id/cancel", async (req, res, next) => {
  try {
    const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "No such task." });
    if (task.status === "RUNNING") {
      // The loop checks nothing mid-flight, so cancelling one that is already
      // turning would be a lie. Saying so beats a status that does not hold.
      return res.status(409).json({ error: "That one is mid-run. Wait for it to finish — it cannot be interrupted safely." });
    }
    const updated = await prisma.agentTask.update({
      where: { id: task.id },
      data: { status: "CANCELLED", finishedAt: new Date() },
      include: taskInclude,
    });
    res.json(taskSummary(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * Accepts the work of a task that stopped at NEEDS_APPROVAL.
 *
 * Deliberately a *record* rather than a replay: the agent's calls were
 * previews, and re-running them for real is a decision about the agent's
 * autonomy, not about this one task. Marking it approved says a person read it
 * and is content; raising the agent's level is how you stop being asked.
 */
agentsRouter.post("/tasks/:id/approve", async (req, res, next) => {
  try {
    const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "No such task." });
    if (task.status !== "NEEDS_APPROVAL") {
      return res.status(409).json({ error: "That task is not waiting on approval." });
    }
    const updated = await prisma.agentTask.update({
      where: { id: task.id },
      data: { status: "DONE", finishedAt: task.finishedAt ?? new Date() },
      include: taskInclude,
    });
    res.json(taskSummary(updated));
  } catch (err) {
    next(err);
  }
});

// --- What it remembers ------------------------------------------------------

agentsRouter.get("/:key/memory", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });
    const memories = await listMemories(agent.key, typeof req.query.subject === "string" ? req.query.subject : undefined);
    res.json({
      memories,
      summary: {
        total: memories.length,
        subjects: new Set(memories.map((memory) => memory.subject)).size,
        // A memory nothing has ever recalled is a memory crowding out one that
        // matters — the recall budget is finite.
        neverUsed: memories.filter((memory) => memory.useCount === 0).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** The Owner writing something an agent should know. Filed as a PREFERENCE against `self`. */
agentsRouter.post("/:key/memory", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    const input = z
      .object({
        content: z.string().min(8).max(600),
        kind: z.enum(["DECISION", "OUTCOME", "FACT", "LESSON", "PREFERENCE"]).default("PREFERENCE"),
        subject: z.string().max(80).default("self"),
        importance: z.number().int().min(1).max(5).default(4),
      })
      .parse(req.body);

    try {
      const memory = await remember({ agentKey: agent.key, ...input });
      res.status(201).json(memory);
    } catch (err) {
      if (err instanceof MemoryRefused) return res.status(400).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

agentsRouter.delete("/:key/memory/:id", async (req, res, next) => {
  try {
    await forget(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
