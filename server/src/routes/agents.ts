import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";

/**
 * The workforce, read-only for now.
 *
 * Autonomy and dry run are the only two things writable here, and only by the
 * Owner: they are what decides whether anything an agent decides can reach a
 * client. Everything else about an agent is seeded from code and changed in a
 * diff, not at runtime.
 */
export const agentsRouter = Router();

agentsRouter.use(requireRole("OWNER"));

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
    res.json({ ...agent, managerName: manager?.name ?? null, reports });
  } catch (err) {
    next(err);
  }
});

const patchInput = z.object({
  /** 0 observe · 1 draft · 2 recommend · 3 execute-with-policy · 4 autonomous · 5 delegated. */
  autonomyLevel: z.number().int().min(0).max(5).optional(),
  dryRun: z.boolean().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "RETIRED"]).optional(),
});

agentsRouter.patch("/:key", async (req, res, next) => {
  try {
    const input = patchInput.parse(req.body);
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    // Level 5 is delegated authority over money and legal exposure. The
    // blueprint reserves it for a board decision, so it is not a UI toggle.
    if (input.autonomyLevel === 5) {
      return res.status(403).json({
        error: "Level 5 is delegated authority and can't be set from here — it needs a recorded owner decision first.",
      });
    }

    const updated = await prisma.agent.update({ where: { key: req.params.key }, data: input });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
