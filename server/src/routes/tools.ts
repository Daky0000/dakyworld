import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { summarise, toolStatuses } from "../services/toolRegistry.js";
import { listAllTools, resolveTool } from "../services/tools/catalogue.js";
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

    // Built-in tools plus whatever the connected MCP servers advertise — one
    // catalogue, because a tool from a server is granted, called and audited
    // on exactly the same terms as one from this repository.
    const tools = await listAllTools();
    const catalogue = await Promise.all(
      tools.map(async (tool) => {
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
      groups: [...new Set(tools.map((tool) => tool.group))],
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
    if (!(await resolveTool(req.params.key))) return res.status(404).json({ error: `There is no tool called ${req.params.key}.` });

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

/**
 * Who may call this tool, and changing that from here.
 *
 * The Agents screen answers "what may this agent do"; this answers the same
 * question from the other side — "who can send email", "who can spend on
 * images" — which is the one you actually ask when a capability worries you.
 * It writes the same `toolkit` field the Agents screen writes, because there
 * is one grant and two ways of looking at it, not two grants.
 */
toolsRouter.get("/:key/agents", async (req, res, next) => {
  try {
    const tool = await resolveTool(req.params.key);
    if (!tool) return res.status(404).json({ error: `There is no tool called ${req.params.key}.` });

    const agents = await prisma.agent.findMany({
      orderBy: [{ tier: "asc" }, { name: "asc" }],
      select: { key: true, name: true, title: true, tier: true, department: true, status: true, autonomyLevel: true, dryRun: true, toolkit: true },
    });

    res.json({
      tool: { key: tool.key, name: tool.name, group: tool.group, purpose: tool.purpose, scope: tool.scope, spends: tool.spends, outward: tool.outward },
      agents: await Promise.all(
        agents.map(async (agent) => {
          const permission = await permissionFor(tool, { agentKey: agent.key, userId: null, dryRun: false });
          return {
            key: agent.key,
            name: agent.name,
            title: agent.title,
            tier: agent.tier,
            department: agent.department,
            status: agent.status,
            granted: agent.toolkit.includes(tool.key),
            // Granted and still unable to act is a different problem from not
            // granted, and needs a different fix. Both are worth seeing here.
            //
            // `allowed` is the third state and was missing. A refusal — a
            // paused agent, or a scope over its spending ceiling — came back as
            // `mustDryRun: false` with a sentence explaining why, and the screen
            // only printed that sentence when `mustDryRun` was true. So an agent
            // that could not act at all looked entirely able, and the only sign
            // was the call failing later. A workforce that has quietly stopped
            // must never look like a workforce with nothing to do.
            allowed: permission.allowed,
            mustDryRun: permission.mustDryRun,
            permissionNote: permission.reason,
          };
        }),
      ),
    });
  } catch (err) {
    next(err);
  }
});

toolsRouter.post("/:key/agents", async (req, res, next) => {
  try {
    const tool = await resolveTool(req.params.key);
    if (!tool) return res.status(404).json({ error: `There is no tool called ${req.params.key}.` });

    const { agentKey, granted } = z.object({ agentKey: z.string().max(64), granted: z.boolean() }).parse(req.body);
    const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
    if (!agent) return res.status(404).json({ error: "No such agent." });

    const toolkit = granted
      ? [...new Set([...agent.toolkit, tool.key])]
      : agent.toolkit.filter((existing) => existing !== tool.key);

    await prisma.agent.update({ where: { key: agentKey }, data: { toolkit } });
    res.json({ agentKey, granted, toolkit });
  } catch (err) {
    next(err);
  }
});
