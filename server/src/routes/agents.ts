import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { listAllTools, resolveTool } from "../services/tools/catalogue.js";
import { toolReadiness } from "../services/tools/readiness.js";
import { permissionFor } from "../services/tools/invoke.js";

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

    // The roster is small; grouping it here keeps the page from re-deriving it.
    const byKey = new Map(agents.map((a) => [a.key, a.name]));
    res.json({
      agents: agents.map((a) => ({ ...a, managerName: a.managerKey ? (byKey.get(a.managerKey) ?? null) : null })),
      summary: {
        total: agents.length,
        active: agents.filter((a) => a.status === "ACTIVE").length,
        specialists: agents.filter((a) => a.tier === "SUB_AGENT").length,
        // The number that matters: how much can act without being asked.
        aboveDraft: agents.filter((a) => a.autonomyLevel > 2 || !a.dryRun).length,
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

    res.json({ ...agent, managerName: manager?.name ?? null, reports, tools });
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
