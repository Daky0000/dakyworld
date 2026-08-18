import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { summarise, toolStatuses } from "../services/toolRegistry.js";
import { TOOLS, findTool } from "../services/tools/catalogue.js";
import { toolReadiness } from "../services/tools/readiness.js";
import { invokeTool, permissionFor } from "../services/tools/invoke.js";

/**
 * What each tool is for, whether it works, and what it still needs — plus,
 * now, a way to actually call one.
 *
 * The call endpoint exists for two reasons that both come before agents using
 * it: proving a newly pasted credential does something, and letting the Owner
 * see exactly what an agent would see. It runs as the Owner (`asOwner`), so it
 * bypasses the grant checks and honours only the dry-run flag the caller asks
 * for — a person testing their own tools should not have to grant themselves
 * anything.
 */
export const toolsRouter = Router();

toolsRouter.use(requireRole("OWNER"));

toolsRouter.get("/", async (_req, res, next) => {
  try {
    const tools = await toolStatuses();
    res.json({ tools, summary: summarise(tools) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tools/catalogue — every callable tool, with its shape.
 *
 * `?agentKey=` answers the same question from one agent's point of view: what
 * it may call, what it may only prepare, and what it hasn't been granted.
 */
toolsRouter.get("/catalogue", async (req, res, next) => {
  try {
    const agentKey = typeof req.query.agentKey === "string" ? req.query.agentKey : null;

    const catalogue = await Promise.all(
      TOOLS.map(async (tool) => {
        const readiness = await toolReadiness(tool.requires);
        const permission = agentKey
          ? await permissionFor(tool, { agentKey, userId: null, dryRun: false })
          : null;
        return {
          key: tool.key,
          name: tool.name,
          group: tool.group,
          purpose: tool.purpose,
          scope: tool.scope,
          requires: tool.requires,
          spends: tool.spends,
          outward: tool.outward,
          canPreview: Boolean(tool.preview),
          ready: readiness.ready,
          blockedReason: readiness.reason,
          ...(permission
            ? { granted: permission.allowed, mustDryRun: permission.mustDryRun, permissionNote: permission.reason }
            : {}),
        };
      }),
    );

    res.json({
      tools: catalogue,
      groups: [...new Set(TOOLS.map((tool) => tool.group))],
      summary: {
        total: catalogue.length,
        ready: catalogue.filter((tool) => tool.ready).length,
        outward: catalogue.filter((tool) => tool.outward).length,
        spending: catalogue.filter((tool) => tool.spends).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

const callInput = z.object({
  input: z.record(z.unknown()).default({}),
  /**
   * Defaults to a dry run. Calling a tool from a settings screen should not be
   * able to email a client because somebody left a field blank.
   */
  dryRun: z.boolean().default(true),
  /** Attribute the call to an agent, and apply that agent's grants. */
  agentKey: z.string().max(64).optional(),
});

toolsRouter.post("/call/:key", async (req, res, next) => {
  try {
    const { input, dryRun, agentKey } = callInput.parse(req.body ?? {});
    if (!findTool(req.params.key)) return res.status(404).json({ error: `There is no tool called ${req.params.key}.` });

    const result = await invokeTool(req.params.key, input, {
      agentKey: agentKey ?? null,
      userId: req.dbUser?.id ?? null,
      dryRun,
      // Only when the Owner is calling it directly rather than standing in for
      // an agent — testing as an agent has to obey that agent's grants or the
      // test proves nothing.
      asOwner: !agentKey,
    });

    res.status(result.ok ? 200 : result.refusedReason ? 403 : 400).json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/tools/calls — the audit trail, newest first. */
toolsRouter.get("/calls", async (req, res, next) => {
  try {
    const take = Math.min(Number(req.query.take) || 50, 200);
    const tool = typeof req.query.tool === "string" ? req.query.tool : undefined;
    const agentKey = typeof req.query.agentKey === "string" ? req.query.agentKey : undefined;

    const [calls, spend] = await Promise.all([
      prisma.toolCall.findMany({
        where: { ...(tool ? { tool } : {}), ...(agentKey ? { agentKey } : {}) },
        orderBy: { createdAt: "desc" },
        take,
      }),
      prisma.toolCall.aggregate({
        _sum: { costUsd: true },
        _count: true,
        where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60_000) } },
      }),
    ]);

    res.json({
      calls,
      lastThirtyDays: { calls: spend._count, spendUsd: spend._sum.costUsd ?? 0 },
    });
  } catch (err) {
    next(err);
  }
});
