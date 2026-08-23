import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { listAllTools, resolveTool } from "../services/tools/catalogue.js";
import { toolReadiness } from "../services/tools/readiness.js";
import { permissionFor } from "../services/tools/invoke.js";
import { authoredInstruction, composePrompt, isBusy, runTask, step } from "../services/agents/runner.js";
import { historyOf, recordCreated, transition } from "../services/agents/state.js";

import { appendOwnerAnswer, clearCheckpoint } from "../services/agents/checkpoint.js";
import { MemoryRefused, editMemory, forget, listMemories, listSharedMemories, recall, remember } from "../services/agents/memory.js";
import { AGENT_SEEDS, PROMPT_LAYERS } from "../services/agentRegistry.js";
import { resolveBrief } from "../services/writers/brief.js";
import { briefSettingKey, jobsOwnedBy, writerJob } from "../services/writers/registry.js";
import { shippedDoctrine } from "../services/writers/shipped.js";
import { organisePrompt } from "../services/writers/organise.js";
import { taskSubjects } from "../services/agents/context.js";
import { syncStandingWork } from "../services/agents/standingWork.js";
import { isValidTimezone } from "../lib/timezone.js";
import {
  HireRefused,
  applyHire,
  declineHire,
  hirePolicy,
  listHireRequests,
  openGaps,
  setHirePolicy,
  withdrawHire,
} from "../services/agents/hiring.js";
import { slackConfigured } from "../lib/slack.js";
import { gateBy, registerEnforced } from "../middleware/permissionGate.js";

/**
 * The workforce.
 *
 * Autonomy, dry run and the toolkit are what decide whether anything an agent
 * works out can reach a client, a card or the public site. They are the
 * Owner's and nobody else's.
 *
 * **So is the wording.** A built-in agent's mission and prompt used to be
 * read-only here, on the grounds that they are a diff — which was the wrong
 * trade. A prompt is the instruction an agent works to, and an instruction the
 * person accountable for the work cannot change is not really theirs; the
 * Owner was left editing text files or hiring a duplicate agent to say the
 * same job differently. Every agent's wording is editable now, an edit takes
 * effect on the very next task it picks up (the runner reads the row, not a
 * cache), and a seeded agent that has been rewritten carries `promptEditedAt`
 * so the shipped wording stays one click away.
 *
 * **The toolkit is a real grant.** It used to be a list of strings nothing
 * read; since the tool layer landed it is the allow-list the invoker checks
 * before every call, so adding a key here gives an agent a capability and
 * removing one takes it away. Which is why this endpoint refuses a key that
 * isn't in the catalogue rather than storing it: an agent granted a tool that
 * doesn't exist looks equipped and is not.
 */
export const agentsRouter = Router();

registerEnforced("agents.autonomy");

agentsRouter.use(
  gateBy({
    view: "agents.view",
    create: "agents.hire",
    edit: "agents.edit",
    remove: "agents.edit",
    routes: [
      // Running work is where the money goes, and it is a different decision from
      // rewriting what an agent is told.
      { path: /^\/[^/]+\/tasks$/, method: "POST", permission: "agents.run" },
      { path: /^\/tasks\/[^/]+\/(run|approve|cancel)$/, permission: "agents.run" },
      { path: /^\/memory/, method: ["POST", "PATCH", "DELETE"], permission: "agents.memory" },
      { path: /^\/[^/]+\/memory/, method: ["POST", "PATCH", "DELETE"], permission: "agents.memory" },
      { path: /^\/hiring/, method: ["POST", "PUT"], permission: "agents.hire" },
      { path: /^\/[^/]+\/prompt\//, permission: "agents.edit" },
      { path: /^\/[^/]+\/writes\//, permission: "agents.edit" },
      { path: /^\/[^/]+\/schedules/, permission: "agents.edit" },
      { path: /^\/schedules\//, permission: "agents.edit" },
      { path: /^\/[^/]+\/feedback$/, permission: "agents.edit" },
    ],
  }),
);

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
          // See the note in routes/tools.ts: a refusal is a third state, and
          // without it a tool an agent cannot call at all renders exactly like
          // one it can.
          allowed: permission.allowed,
          mustDryRun: permission.mustDryRun,
          permissionNote: permission.reason,
        };
      }),
    );

    const [work, memories, shared] = await Promise.all([
      prisma.agentTask.groupBy({ by: ["status"], where: { agentKey: agent.key }, _count: true }),
      prisma.agentMemory.count({ where: { scope: "AGENT", agentKey: agent.key } }),
      // Counted separately: these are the company's, and the drawer says so
      // before offering to edit one.
      prisma.agentMemory.count({ where: { scope: "SHARED" } }),
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
      sharedMemories: shared,
      /** The ten prompt layers, in order, so the editor doesn't keep its own copy. */
      promptLayers: PROMPT_LAYERS,
      /** True when there is shipped wording to reset to. */
      resettable: !agent.custom,
      /** True when it is mid-task, so the screen can say a change lands after this one. */
      busy: isBusy(agent.key),
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
  /**
   * The instruction as one piece of prose, which is how the screen edits it.
   *
   * Null clears it and hands the job back to the ten layers — that is what
   * Reset does, and why it needs no separate route. The ceiling is well above
   * the ten layers' combined 20k because a prompt somebody has actually worked
   * on is longer than the seed, and being truncated silently at save time is
   * the worst way to find out about a limit.
   */
  promptText: z.string().max(24_000).nullish(),
});


agentsRouter.patch("/:key", async (req, res, next) => {
  try {
    const input = patchInput.parse(req.body);
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    // Autonomy and dry run decide whether software may act on a client without
    // being asked. That is the single most consequential field on this router
    // and it arrives on the same PATCH as a typo fix in a mission statement, so
    // the gate above cannot tell them apart and this asks separately.
    if ((input.autonomyLevel !== undefined || input.dryRun !== undefined) && !req.can?.("agents.autonomy")) {
      return res
        .status(403)
        .json({ error: 'Your role does not include "Set autonomy". Ask an Owner to add it on Team & Access.' });
    }

    // Rewriting a seeded agent is allowed and recorded. `ensureAgents()` only
    // ever creates, so an edit made here survives every future deploy — the
    // flag is what lets the screen offer the shipped wording back rather than
    // what protects it.
    const rewriting = ["name", "title", "mission", "skills", "kpis", "responsibilities", "escalationPolicy", "avatar", "managerKey", "department", "prompt", "promptText"].filter(
      (field) => input[field as keyof typeof input] !== undefined,
    );

    // An agent that reports to itself, directly or round a loop, has nowhere to
    // escalate to — and escalation is the one thing every agent must always be
    // able to do.
    if (input.managerKey) {
      const cycle = await reportsInto(input.managerKey, agent.key);
      if (cycle) {
        return res.status(400).json({
          error: `That would make ${agent.name} report into its own chain, and an agent with nowhere to escalate to is an agent that can't stop and ask.`,
        });
      }
    }

    if (input.prompt) {
      const unknown = Object.keys(input.prompt).filter((layer) => !PROMPT_LAYERS.includes(layer as never));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `A prompt is made of the ten named layers. Not a layer: ${unknown.join(", ")}.` });
      }
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
    const data = {
      ...input,
      ...(input.toolkit ? { toolkit: input.toolkit.filter((key) => known.has(key)) } : {}),
      // Stamped only on a seeded agent: a custom one has no shipped wording to
      // go back to, so the flag would mean nothing there.
      ...(rewriting.length > 0 && !agent.custom ? { promptEditedAt: new Date() } : {}),
    };

    const updated = await prisma.agent.update({ where: { key: req.params.key }, data });
    res.json({
      ...updated,
      ...(dropped.length ? { droppedGrants: dropped } : {}),
      // Said plainly, because the whole point of editing a prompt is that it
      // changes what the agent does, and a person should know when.
      ...(rewriting.length > 0
        ? { appliesFrom: isBusy(agent.key) ? "the next task after the one it is working on" : "its next task" }
        : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Would putting `agentKey` under `managerKey` create a loop?
 *
 * Walks up from the proposed manager looking for the agent being moved. Bounded
 * by the size of the roster rather than trusted to terminate, because the row
 * it is walking is the one thing that might already be broken.
 */
async function reportsInto(managerKey: string, agentKey: string): Promise<boolean> {
  let current: string | null = managerKey;
  for (let hops = 0; hops < 64 && current; hops += 1) {
    if (current === agentKey) return true;
    const next: { managerKey: string | null } | null = await prisma.agent.findUnique({
      where: { key: current },
      select: { managerKey: true },
    });
    current = next?.managerKey ?? null;
  }
  return false;
}

/**
 * Puts a seeded agent's shipped wording back.
 *
 * The counterpart to letting the wording be edited: an edit is only safe to
 * make if it is safe to undo. Restores every wording field from
 * `AGENT_SEEDS` — and deliberately not the toolkit, the autonomy level or the
 * dry-run flag, which are permissions the Owner set rather than words a deploy
 * shipped, and which resetting a prompt has no business touching.
 */
agentsRouter.post("/:key/prompt/reset", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    const seed = AGENT_SEEDS.find((entry) => entry.key === agent.key);
    if (!seed) {
      return res.status(409).json({
        error: `${agent.name} was created here rather than shipped, so there is no earlier wording to go back to.`,
      });
    }

    const updated = await prisma.agent.update({
      where: { key: agent.key },
      data: {
        name: seed.name,
        title: seed.title,
        mission: seed.mission,
        responsibilities: seed.responsibilities,
        kpis: seed.kpis,
        skills: seed.skills ?? [],
        escalationPolicy: seed.escalationPolicy,
        avatar: seed.avatar ?? null,
        prompt: seed.prompt as unknown as object,
        // Clearing this is the whole of "go back to the shipped instruction":
        // the layers underneath were never overwritten, so handing the job back
        // to them restores the seed exactly.
        promptText: null,
        promptEditedAt: null,
      },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * The prompt as the model actually receives it.
 *
 * The Agents screen used to draw ten boxes, one per layer, which is what the
 * database holds and not what the agent is told. The gap between those two was
 * most of the prompt: who Dakyworld is, the company's contact details, how to
 * write, what the agent recalled, and the whole passage about tools, dry run
 * and asking colleagues — none of it authored on that screen, all of it in
 * front of the model.
 *
 * So this returns the assembled thing, in labelled regions, from the same
 * `composePrompt()` the runner calls. One region is editable and the rest say
 * where they come from, which is the honest answer to "can I change this".
 *
 * **The memories shown are the ones a task with no particular subject would
 * recall** — the agent's standing lessons and the company's house rules. A
 * task about a lead recalls more, and the region says so rather than implying
 * this is everything.
 */
agentsRouter.get("/:key/prompt/compiled", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    const memories = await recall(agent.key, []);
    const regions = await composePrompt(agent, memories);
    const text = regions
      .map((region) => region.text)
      .filter(Boolean)
      .join("\n\n");

    res.json({
      regions: regions.filter((region) => region.text.trim().length > 0),
      text,
      /** What the editable region currently holds, which is what an edit starts from. */
      instruction: authoredInstruction(agent),
      /** True when the Owner has replaced the layers with their own prose. */
      overridden: Boolean(agent.promptText?.trim()),
      layers: PROMPT_LAYERS,
      prompt: agent.prompt,
      resettable: !agent.custom,
      /**
       * The deliverables this agent's wording writes, outside its own tasks.
       *
       * The question this answers is the one the screen could not answer
       * before: *where do these words actually go?* An agent's prompt used to
       * mean only "what it is told when it runs a task", while the cold email,
       * the proposal and the audit sections were written by string constants
       * in `lib/` that no screen displayed. Somebody could rewrite the Cold
       * Lead Writer, watch this page show their new wording, send an email and
       * get the old one — because the two were never connected.
       *
       * `active` is the honest part. A seeded agent nobody has edited still
       * falls through to the shipped doctrine, so the row says "shipped
       * wording — your edit will take this over" rather than claiming an
       * authority it does not yet have.
       */
      writes: await Promise.all(
        jobsOwnedBy(agent.key).map(async (job) => {
          const brief = await resolveBrief(job.key, "");
          return {
            job: job.key,
            label: job.label,
            what: job.what,
            outward: job.outward,
            where: job.where,
            source: brief.source,
            active: brief.source === "agent",
            explains: brief.explains,
          };
        }),
      ),
      /**
       * Roughly what this costs to send, every task, before the brief. Four
       * characters to the token is close enough to be worth showing and not
       * worth a dependency — it is there to make a prompt that has grown to
       * eight thousand tokens visible, not to bill anybody.
       */
      approxTokens: Math.round(text.length / 4),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Sort a written instruction into the ten sections, without saving it.
 *
 * The founder writes doctrine as doctrine — a playbook, a page of rules, a
 * paste out of a document — and this screen wants ten named layers. Doing that
 * by hand means everything lands in `process`, because it is the only layer
 * big enough to take a page.
 *
 * **It proposes and returns; it never writes.** What comes back goes into the
 * editor for a person to read and press Save on. An organiser that wrote
 * straight to the agent would be a model editing a prompt with nobody looking,
 * and the whole point of this area of the app is that a person can see what an
 * agent was told.
 */
agentsRouter.post("/:key/prompt/organise", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key }, select: { key: true } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    const parsed = z.object({ text: z.string().min(1).max(40_000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Paste the instruction you want sorted." });

    res.json(await organisePrompt(parsed.data.text));
  } catch (err) {
    next(err);
  }
});

/**
 * The prompt that writes one deliverable, as the model receives it.
 *
 * This is the other half of "the screen shows what runs". The compiled view
 * above answers it for an agent's *task*; this answers it for the thing the
 * agent actually produces — the cold email, the proposal, an audit section —
 * which for most of this app is the part anybody outside ever sees.
 *
 * `text` is what would be sent right now, whether that is the founder's own
 * wording or the shipped default, so the editor opens on the truth rather than
 * on a blank box.
 */
agentsRouter.get("/:key/writes/:job", async (req, res, next) => {
  try {
    const job = writerJob(req.params.job);
    if (!job || job.agentKey !== req.params.key) return res.status(404).json({ error: "That agent does not write that." });

    const shipped = await shippedDoctrine(job.key);
    const brief = await resolveBrief(job.key, shipped);
    res.json({
      job: job.key,
      label: job.label,
      what: job.what,
      where: job.where,
      outward: job.outward,
      text: brief.text,
      source: brief.source,
      explains: brief.explains,
      /** So the editor can offer "put the shipped wording back" without a second call. */
      shipped,
      edited: brief.source === "override",
    });
  } catch (err) {
    next(err);
  }
});

const briefBody = z.object({ text: z.string().max(40_000) });

/**
 * Rewrite what writes a deliverable.
 *
 * Saved against the job rather than the agent because one agent may own
 * several — `content.writer` judges a prospect's copy, writes Dakyworld's own
 * and rewrites prose into plain English, and those are three different
 * instructions that must not overwrite each other.
 *
 * **It takes effect on the next draft, not the next restart.** The resolver
 * reads this row on every call and deliberately bypasses the settings cache,
 * which is per-process and would otherwise leave a second instance writing to
 * the old wording with nothing on screen to say why.
 */
agentsRouter.put("/:key/writes/:job", async (req, res, next) => {
  try {
    const job = writerJob(req.params.job);
    if (!job || job.agentKey !== req.params.key) return res.status(404).json({ error: "That agent does not write that." });

    const parsed = briefBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "That prompt could not be read." });

    const text = parsed.data.text.trim();
    const key = briefSettingKey(job.key);

    // Empty means "go back to what Dakyworld ships" rather than "write with no
    // instruction at all", which is the only sane reading of an emptied box and
    // the one that cannot leave a model working from nothing.
    if (!text) {
      await prisma.appSetting.deleteMany({ where: { key } });
      return res.json({ reset: true, appliesFrom: "The next draft, which will use the shipped wording again." });
    }

    await prisma.appSetting.upsert({
      where: { key },
      update: { value: text, secret: false },
      create: { key, value: text, secret: false },
    });
    res.json({ saved: true, appliesFrom: `The next ${job.label.toLowerCase()}. Nothing already drafted changes.` });
  } catch (err) {
    next(err);
  }
});

/** Put the shipped wording back, without having to paste it. */
agentsRouter.delete("/:key/writes/:job", async (req, res, next) => {
  try {
    const job = writerJob(req.params.job);
    if (!job || job.agentKey !== req.params.key) return res.status(404).json({ error: "That agent does not write that." });
    await prisma.appSetting.deleteMany({ where: { key: briefSettingKey(job.key) } });
    res.json({ reset: true });
  } catch (err) {
    next(err);
  }
});

/** The shipped wording, without applying it — so an edit can be compared before it is undone. */
agentsRouter.get("/:key/prompt/shipped", async (req, res, next) => {
  try {
    const seed = AGENT_SEEDS.find((entry) => entry.key === req.params.key);
    if (!seed) return res.status(404).json({ error: "That agent was created here, so nothing was ever shipped for it." });
    res.json({
      layers: PROMPT_LAYERS,
      prompt: seed.prompt,
      name: seed.name,
      title: seed.title,
      mission: seed.mission,
      skills: seed.skills ?? [],
      kpis: seed.kpis,
      escalationPolicy: seed.escalationPolicy,
    });
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
    await recordCreated(task.id, task.traceId, task.status, {
      reason: `${req.dbUser?.name ?? "The Owner"} gave this to ${agent.name}.`,
      actor: "owner",
      actorId: req.dbUser?.id ?? null,
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
        checkpoint: { select: { iteration: true, updatedAt: true } },
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

    // Everything this run caused, gathered by its trace. Each of these facts
    // was already being written down and none of them could be reached from
    // the task: ToolCall had no task id, LlmCall had neither, and the step's
    // own `toolCallId` was declared as the join and never filled in.
    const [history, toolCalls, modelCalls] = await Promise.all([
      historyOf(task.id),
      prisma.toolCall.findMany({
        where: { OR: [{ taskId: task.id }, { traceId: task.traceId }] },
        orderBy: { createdAt: "asc" },
      }),
      prisma.llmCall.aggregate({
        where: { OR: [{ taskId: task.id }, { traceId: task.traceId }] },
        _sum: { inputTokens: true, outputTokens: true, costUsd: true },
        _count: true,
      }),
    ]);

    res.json({
      ...taskSummary(task),
      traceId: task.traceId,
      brief: task.brief,
      input: task.input,
      result: task.result,
      attempts: task.attempts,
      steps: task.steps,
      /** Every status this task has been in, and what moved it. */
      history,
      /** The audit rows behind the timeline, joined by `AgentTaskStep.toolCallId`. */
      toolCalls,
      /** What the model side of this run actually cost, in tokens rather than only in dollars. */
      spend: {
        inputTokens: task.inputTokens || (modelCalls._sum.inputTokens ?? 0),
        outputTokens: task.outputTokens || (modelCalls._sum.outputTokens ?? 0),
        modelCalls: modelCalls._count,
        costUsd: task.costUsd,
      },
      // What a resume would carry on from. Shown because "it will continue
      // where it stopped" is only reassuring if you can see that there is
      // something to continue from.
      resumesFrom: task.checkpoint ? { steps: task.checkpoint.iteration, savedAt: task.checkpoint.updatedAt } : null,
      heartbeatAt: task.heartbeatAt,
      stopRequested: task.interruptRequested,
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
 * Runs a task now — in the background, and continuing rather than restarting.
 *
 * Two things this deliberately does not do. It does not wait: the reply comes
 * back the moment the run is under way, so closing the tab, losing the
 * connection or shutting the laptop has no effect on work that is happening on
 * a server. And it does not start over: if the task has a checkpoint, the
 * runner rejoins that conversation.
 *
 * Also how a BLOCKED task is answered. The answer goes two places — appended
 * to the brief, where it stays on the record, and appended to the conversation
 * itself, because an agent that resumes without being told the answer carries
 * on from the question it asked.
 */
agentsRouter.post("/tasks/:id/run", async (req, res, next) => {
  try {
    const task = await prisma.agentTask.findUnique({
      where: { id: req.params.id },
      include: { agent: true, checkpoint: { select: { iteration: true } } },
    });
    if (!task) return res.status(404).json({ error: "No such task." });
    if (task.status === "RUNNING") return res.status(409).json({ error: "That one is already running." });
    if (task.agent.status !== "ACTIVE") {
      return res.status(409).json({ error: `${task.agent.name} is a ${task.agent.status.toLowerCase()} — set it to Active first.` });
    }

    // One agent, one task at a time — see services/agents/runner.ts. Refused
    // here rather than left to the claim, because "started: true" for something
    // that silently stayed queued is the reply that wastes somebody's afternoon.
    const alreadyWorking = await prisma.agentTask.findFirst({
      where: { agentKey: task.agentKey, status: "RUNNING" },
      select: { id: true, title: true },
    });
    if (alreadyWorking) {
      return res.status(409).json({
        error: `${task.agent.name} is already working on “${alreadyWorking.title}”. One agent takes one task at a time — this one starts as soon as that finishes.`,
      });
    }

    // An answer to an escalation, appended rather than replacing the brief:
    // what it was originally asked stays on the record.
    const { answer, fresh } = z
      .object({
        answer: z.string().max(2000).optional(),
        /** Throw away where it had got to and work the brief again from the top. */
        fresh: z.boolean().optional(),
      })
      .parse(req.body ?? {});

    if (answer?.trim()) {
      await prisma.agentTask.update({
        where: { id: task.id },
        data: { brief: `${task.brief}\n\n--- Answer from the Owner ---\n${answer.trim()}` },
      });
      // Into the conversation as well as onto the record. Without this the
      // agent resumes at the moment it asked its question, having never been
      // told the answer, and asks it again.
      await appendOwnerAnswer(task.id, answer.trim());
    }

    const resuming = Boolean(task.checkpoint) && !fresh;
    if (fresh) await clearCheckpoint(task.id);

    // Deliberately not awaited. The work belongs to the server, not to whoever
    // is looking at it: this returns immediately and the run carries on through
    // a closed tab, a dropped connection and a shut laptop.
    void runTask(task.id).catch((err) => console.error(`[agent] ${task.id} died:`, (err as Error).message));
    res.json({
      started: true,
      resuming,
      resumingFrom: resuming ? (task.checkpoint?.iteration ?? 0) : 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Stops a task.
 *
 * A running one is *asked* rather than told. The loop reads the request between
 * steps and stops at the next point where the conversation is whole — usually
 * within one tool call — writing its checkpoint on the way out, so the task
 * comes back to the queue rather than being lost. That is why this now works at
 * all on a RUNNING task: it used to answer "it cannot be interrupted safely",
 * which was true of a loop that checked nothing and kept no place.
 */
agentsRouter.post("/tasks/:id/cancel", async (req, res, next) => {
  try {
    const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "No such task." });
    if (task.status === "RUNNING") {
      await prisma.agentTask.update({ where: { id: task.id }, data: { interruptRequested: true } });
      // A step rather than a transition, because asking is not yet a move: the
      // status changes when the loop honours it, and that write records itself.
      // What would otherwise be lost is who asked.
      await step(task.id, "NOTED", `${req.dbUser?.name ?? "Somebody"} asked this to stop.`);
      return res.json({
        asked: true,
        message:
          "Asked it to stop. It finishes the step it is on, saves its place, and goes back to the queue — nothing it has already done is lost, and running it again carries on from there.",
      });
    }
    await transition(task.id, {
      to: "CANCELLED",
      reason: "Cancelled by a person.",
      actor: "owner",
      actorId: req.dbUser?.id ?? null,
      data: { finishedAt: new Date() },
    });
    const updated = await prisma.agentTask.findUnique({ where: { id: task.id }, include: taskInclude });
    res.json(taskSummary(updated!));
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
 *
 * **It will not close a task whose prepared actions are still waiting.** This
 * route predates the approval queue, and once the queue existed the two
 * disagreed: closing the task here left its letters sitting PENDING under
 * Approvals while the board said the work was done. Two records of one
 * decision, one of them wrong. Deciding the actions is the way to close it, and
 * the refusal names them so it is obvious where to go.
 */
agentsRouter.post("/tasks/:id/approve", async (req, res, next) => {
  try {
    const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "No such task." });
    if (task.status !== "NEEDS_APPROVAL") {
      return res.status(409).json({ error: "That task is not waiting on approval." });
    }

    const waiting = await prisma.actionRequest.findMany({
      where: { taskId: task.id, status: "PENDING" },
      select: { id: true, wouldDo: true },
    });
    if (waiting.length > 0) {
      return res.status(409).json({
        error:
          waiting.length === 1
            ? "There is still an action from this task waiting for a decision. Decide it under Approvals — that is what carries it out."
            : `There are still ${waiting.length} actions from this task waiting for a decision. Decide them under Approvals — that is what carries them out.`,
        pending: waiting,
      });
    }

    await transition(task.id, {
      to: "DONE",
      reason: "A person read the prepared work and accepted it.",
      actor: "owner",
      actorId: req.dbUser?.id ?? null,
      expect: ["NEEDS_APPROVAL"],
      data: { finishedAt: task.finishedAt ?? new Date() },
    });
    const updated = await prisma.agentTask.findUnique({ where: { id: task.id }, include: taskInclude });
    res.json(taskSummary(updated!));
  } catch (err) {
    next(err);
  }
});

// --- What it remembers ------------------------------------------------------

/**
 * The company's memory — written once, read by every agent.
 *
 * Mounted at `/memory/shared` rather than under an agent key, because it does
 * not belong to one. `/:key/memory` cannot claim these paths: its second
 * segment is the literal "memory", and this one's is "shared".
 *
 * This is the thing per-agent memory could not do. "We do not take on
 * unregistered businesses", "always quote in cedis", "never promise a date in
 * December" — each of those had to be typed into nineteen agents one at a
 * time, and the twentieth agent hired next month would never have heard any of
 * them. Said here, it is said once and stays said.
 */
agentsRouter.get("/memory/shared", async (req, res, next) => {
  try {
    const memories = await listSharedMemories(typeof req.query.subject === "string" ? req.query.subject : undefined);
    res.json({
      memories,
      summary: {
        total: memories.length,
        /** How many apply to every task, as opposed to one lead or one client. */
        standing: memories.filter((memory) => memory.subject === "company").length,
        subjects: new Set(memories.map((memory) => memory.subject)).size,
        neverUsed: memories.filter((memory) => memory.useCount === 0).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post("/memory/shared", async (req, res, next) => {
  try {
    const input = z
      .object({
        content: z.string().min(8).max(600),
        kind: z.enum(["DECISION", "OUTCOME", "FACT", "LESSON", "PREFERENCE"]).default("PREFERENCE"),
        /**
         * `company` for anything that applies to all work — which is what this
         * is normally for. A record key (`lead:abc`) narrows it to tasks about
         * that record, because sharing widens who sees a memory and must never
         * widen when it surfaces.
         */
        subject: z.string().max(80).default("company"),
        /** Shared memories already outrank an agent's own in recall; 5 is for a rule that must never be crowded out. */
        importance: z.number().int().min(1).max(5).default(4),
      })
      .parse(req.body);

    try {
      // `owner` rather than an agent key: this was a person's decision, and the
      // author is kept so "who concluded this" stays answerable.
      const memory = await remember({ agentKey: "owner", shared: true, ...input });
      res.status(201).json(memory);
    } catch (err) {
      if (err instanceof MemoryRefused) return res.status(400).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

agentsRouter.patch("/memory/shared/:id", async (req, res, next) => {
  try {
    const input = z
      .object({
        content: z.string().min(8).max(600).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        subject: z.string().max(80).optional(),
        expiresAt: z.coerce.date().nullish(),
      })
      .parse(req.body);

    const memory = await prisma.agentMemory.findUnique({ where: { id: req.params.id } });
    if (!memory) return res.status(404).json({ error: "No such memory." });
    if (memory.scope !== "SHARED") {
      return res.status(409).json({ error: "That one belongs to a single agent. Edit it from that agent's drawer." });
    }

    try {
      res.json(await editMemory(req.params.id, input));
    } catch (err) {
      if (err instanceof MemoryRefused) return res.status(400).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

agentsRouter.delete("/memory/shared/:id", async (req, res, next) => {
  try {
    const memory = await prisma.agentMemory.findUnique({ where: { id: req.params.id } });
    if (!memory) return res.status(404).json({ error: "No such memory." });
    if (memory.scope !== "SHARED") {
      return res.status(409).json({ error: "That one belongs to a single agent. Delete it from that agent's drawer." });
    }
    await forget(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});


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

/**
 * "Next time, do this."
 *
 * The Owner reads a draft and knows what is wrong with it. Until now the only
 * ways to act on that were to rewrite the prompt — a permanent change made
 * from one example — or to fix the draft by hand and watch the same agent make
 * the same choice tomorrow. Neither is what a person would do with a
 * colleague, which is to say the thing once and expect it to stick.
 *
 * So this is one sentence typed under a piece of work, filed as a
 * `PREFERENCE`, which recall already puts in front of the agent on its next
 * task. No prompt engineering, and it is undoable — it is a memory row like
 * any other, editable and deletable on the Memory panel.
 *
 * Three decisions the caller makes, and each changes when it comes up again:
 *
 * - **`shared`** widens it from this agent to all of them. For a house rule —
 *   "we never quote a price in a first email" — which is otherwise typed
 *   forty-nine times and still missed by the fiftieth agent hired next month.
 * - **`aboutThisRecord`** files it against the lead or client the task was
 *   about instead of against the agent's own way of working, so it surfaces
 *   for this company and no other. That is the right home for "they asked us
 *   not to call before ten".
 * - **`taskId`** records which piece of work produced it, so "why does it
 *   think that" is answerable months later.
 */
agentsRouter.post("/:key/feedback", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    const input = z
      .object({
        note: z.string().min(8).max(600),
        taskId: z.string().max(40).optional(),
        shared: z.boolean().default(false),
        aboutThisRecord: z.boolean().default(false),
        importance: z.number().int().min(1).max(5).default(4),
      })
      .parse(req.body);

    // The record the work was about, when there was one and the Owner asked for
    // the lesson to be filed against it. `taskSubjects` is the same ordering the
    // agent's own `remember` uses, so a note the Owner files and a note the
    // agent files about one lead land on the same subject key.
    let subject = input.shared ? "company" : "self";
    if (input.aboutThisRecord && input.taskId) {
      const task = await prisma.agentTask.findUnique({
        where: { id: input.taskId },
        select: { leadId: true, clientId: true, projectId: true, proposalId: true, invoiceId: true },
      });
      const subjects = task ? taskSubjects(task) : [];
      if (subjects.length === 0) {
        return res.status(400).json({
          error: "That task wasn't about a particular lead or client, so there's no record to file this against. Leave it as a general lesson instead.",
        });
      }
      [subject] = subjects;
    }

    try {
      const memory = await remember({
        // The memory belongs to the agent that has to act on it; `owner`
        // records who said so. On a shared one the agent key is dropped
        // entirely — it is the company's — and `owner` remains the author.
        agentKey: input.shared ? "owner" : agent.key,
        authorKey: "owner",
        shared: input.shared,
        kind: "PREFERENCE",
        subject,
        content: input.note,
        importance: input.importance,
        sourceTaskId: input.taskId ?? null,
      });

      res.status(201).json({
        memory,
        // Said plainly, because the point of typing it is that something
        // changes, and a person should know what and when.
        appliesTo: input.shared ? "every agent" : agent.name,
        appliesWhen:
          subject === "self"
            ? `every task ${agent.name} picks up`
            : subject === "company"
              ? "every task, whoever picks it up"
              : "the next task about this record",
      });
    } catch (err) {
      if (err instanceof MemoryRefused) return res.status(400).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Changes what a memory says.
 *
 * A memory is re-read into a prompt every time its subject comes up, which
 * makes it an instruction as much as a record — and until this route existed
 * the only way to correct one was to delete it, losing the fact that it had
 * ever been held. Editing takes effect on the next task, the same way a prompt
 * edit does, because recall reads the row.
 */
agentsRouter.patch("/:key/memory/:id", async (req, res, next) => {
  try {
    const input = z
      .object({
        content: z.string().min(8).max(600).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        subject: z.string().max(80).optional(),
        expiresAt: z.coerce.date().nullish(),
      })
      .parse(req.body);

    const memory = await prisma.agentMemory.findUnique({ where: { id: req.params.id } });
    if (!memory) return res.status(404).json({ error: "No such memory." });

    try {
      const updated = await editMemory(req.params.id, input);
      res.json({
        ...updated,
        // Worth saying out loud: this row is one every agent reads.
        ...(memory.scope === "SHARED" ? { note: "This is shared — the change applies to every agent." } : {}),
      });
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

// --- Hiring -----------------------------------------------------------------

/**
 * The same decisions Slack offers, in the app.
 *
 * Slack is the *convenient* place to answer a hiring card — it arrives on a
 * phone at the moment it matters. It must not be the *only* place. A Slack
 * workspace that has not been connected yet, a signing secret nobody has
 * pasted, an app somebody removed: each of those would otherwise mean the
 * Agent Creator files proposals nothing can ever approve, and the failure
 * would look like the agent not working.
 *
 * Mounted under `/agents` and above nothing — these paths cannot be mistaken
 * for an agent key, because `:key` is matched by the routes declared before
 * them and Express takes the first match. `hiring/policy` and `gaps` are two
 * segments where `/:key` is one.
 */
agentsRouter.get("/hiring/policy", async (_req, res, next) => {
  try {
    const [policy, slack, pending] = await Promise.all([hirePolicy(), slackConfigured(), listHireRequests("PENDING")]);
    res.json({
      policy,
      pending: pending.length,
      slackConnected: slack,
      // Said plainly, because the combination that surprises people is AUTO
      // with dry run still on: agents appear on the roster and appear to do
      // nothing, which reads as broken rather than as safe.
      explanation:
        policy === "AUTO"
          ? "The Agent Creator's proposals become agents as soon as it makes them — at autonomy 1 with dry run on, so nothing a new agent decides takes effect until you raise it."
          : "Nothing is created until you approve it. Proposals arrive in Slack when it is connected, and are listed here either way.",
      ...(slack ? {} : { note: "Slack is not connected, so hiring cards have nowhere to go. Proposals still land here." }),
    });
  } catch (err) {
    next(err);
  }
});

agentsRouter.put("/hiring/policy", async (req, res, next) => {
  try {
    const { policy } = z.object({ policy: z.enum(["ASK", "AUTO"]) }).parse(req.body ?? {});
    await setHirePolicy(policy, `${req.dbUser?.email ?? "the Owner"} in the app`);
    res.json({ policy });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get("/hiring/gaps", async (_req, res, next) => {
  try {
    res.json({ gaps: await openGaps() });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get("/hiring/requests", async (req, res, next) => {
  try {
    const status = z.enum(["PENDING", "APPROVED", "DECLINED", "EXPIRED", "WITHDRAWN"]).optional().parse(req.query.status);
    res.json({ requests: await listHireRequests(status) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post("/hiring/requests/:id/approve", async (req, res, next) => {
  try {
    const result = await applyHire(req.params.id, { userId: req.dbUser?.id ?? null, note: "Approved in the app." });
    res.json(result);
  } catch (err) {
    if (err instanceof HireRefused) return res.status(409).json({ error: err.message });
    next(err);
  }
});

agentsRouter.post("/hiring/requests/:id/decline", async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().max(600).optional() }).parse(req.body ?? {});
    const request = await declineHire(req.params.id, { userId: req.dbUser?.id ?? null, note: note ?? null });
    res.json(request);
  } catch (err) {
    if (err instanceof HireRefused) return res.status(409).json({ error: err.message });
    next(err);
  }
});

agentsRouter.post("/hiring/requests/:id/undo", async (req, res, next) => {
  try {
    const result = await withdrawHire(req.params.id, { userId: req.dbUser?.id ?? null });
    res.json(result);
  } catch (err) {
    if (err instanceof HireRefused) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// --- Standing work ----------------------------------------------------------

/**
 * What an agent does without being asked.
 *
 * `AgentTaskOrigin.SCHEDULE` existed from the start and nothing ever wrote it,
 * so the workforce was entirely reactive: fifty agents that could work, and no
 * reason for any of them to begin. A schedule is the reason.
 *
 * Everything lands disabled. Switching one on is the decision, and it is a
 * different decision from writing it down.
 */
agentsRouter.get("/:key/schedules", async (req, res, next) => {
  try {
    const schedules = await prisma.agentSchedule.findMany({ where: { agentKey: req.params.key }, orderBy: { createdAt: "asc" } });
    res.json({ schedules });
  } catch (err) {
    next(err);
  }
});

const scheduleInput = z.object({
  title: z.string().min(4).max(120),
  brief: z.string().min(20).max(4000),
  runTimes: z.array(z.string().regex(/^\d{1,2}:\d{2}$/)).min(1).max(6),
  timezone: z.string().max(64).default("Africa/Accra"),
  weekdaysOnly: z.boolean().default(true),
  enabled: z.boolean().default(false),
  maxOpenTasks: z.number().int().min(1).max(5).default(1),
});

agentsRouter.post("/:key/schedules", async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    const input = scheduleInput.parse(req.body);
    if (!isValidTimezone(input.timezone)) return res.status(400).json({ error: `"${input.timezone}" is not a timezone.` });

    const schedule = await prisma.agentSchedule.create({ data: { ...input, agentKey: agent.key } });
    await syncStandingWork(schedule.id);
    res.status(201).json(await prisma.agentSchedule.findUnique({ where: { id: schedule.id } }));
  } catch (err) {
    next(err);
  }
});

agentsRouter.patch("/schedules/:id", async (req, res, next) => {
  try {
    const input = scheduleInput.partial().parse(req.body);
    if (input.timezone && !isValidTimezone(input.timezone)) {
      return res.status(400).json({ error: `"${input.timezone}" is not a timezone.` });
    }
    const existing = await prisma.agentSchedule.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "No such schedule." });

    await prisma.agentSchedule.update({ where: { id: req.params.id }, data: input });
    const nextRunAt = await syncStandingWork(req.params.id);
    res.json({ ...(await prisma.agentSchedule.findUnique({ where: { id: req.params.id } })), nextRunAt });
  } catch (err) {
    next(err);
  }
});

agentsRouter.delete("/schedules/:id", async (req, res, next) => {
  try {
    await prisma.agentSchedule.deleteMany({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
