import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { costReport } from "../services/costs.js";
import { listBudgets, removeBudget, setBudget } from "../services/budgets.js";

/**
 * What the workforce spends.
 *
 * Owner only, like the Tools and Settings screens and for the same reason: the
 * spend table names every agent, every feature and every model, which is a
 * complete map of what this company automates and what it pays to.
 *
 * Everything here reads the two ledgers and writes nothing. The ledgers already
 * carry the attribution — `purpose`, `agentKey`, `taskId`, `traceId`, `model`,
 * priced at the moment of the call — so no part of this needed a migration or a
 * new column. It needed asking.
 */
export const costsRouter = Router();

costsRouter.use(requireRole("OWNER"));

const windowQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** GET /api/costs?days=30 — the whole picture for a window. */
costsRouter.get("/", async (req, res, next) => {
  try {
    const { days } = windowQuery.parse(req.query);
    res.json(await costReport(days));
  } catch (err) {
    next(err);
  }
});

const callsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  take: z.coerce.number().int().min(1).max(200).default(50),
  purpose: z.string().max(120).optional(),
  agentKey: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  /** Only the ones that failed — the fastest way to see what an outage cost. */
  failed: z.coerce.boolean().optional(),
});

/**
 * GET /api/costs/calls — the rows behind a total.
 *
 * A number nobody can open is a number nobody trusts, and "which feature spent
 * it" is only half an answer if the next question — *on what* — has nowhere to
 * go. Filtered on the same columns the breakdowns group by, so clicking a row
 * in a table is one query away.
 */
costsRouter.get("/calls", async (req, res, next) => {
  try {
    const { days, take, purpose, agentKey, model, failed } = callsQuery.parse(req.query);
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);

    const calls = await prisma.llmCall.findMany({
      where: {
        createdAt: { gte: since },
        ...(purpose ? { purpose } : {}),
        ...(agentKey ? { agentKey } : {}),
        ...(model ? { model } : {}),
        ...(failed ? { ok: false } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
    });

    res.json({ calls });
  } catch (err) {
    next(err);
  }
});

// --- Ceilings ---------------------------------------------------------------

/**
 * Budgets live here rather than under Settings on purpose.
 *
 * The moment somebody wants to change a ceiling is the moment they are looking
 * at what was spent, not the moment they are looking at a settings screen —
 * the same argument `/dakyworld hiring auto|ask` makes about the hiring policy.
 * Putting the number next to the total it is a ceiling on is the whole reason
 * anybody will set a useful one.
 */

const budgetBody = z
  .object({
    scopeType: z.enum(["GLOBAL", "AGENT", "TOOL"]),
    scopeId: z.string().max(120).optional(),
    period: z.enum(["DAY", "MONTH"]),
    // `.nullable()` and no `.positive()`, deliberately. Zero is a real setting
    // — stop all spend on this scope — and the usual positive guard would read
    // it as "unset" and quietly restore no ceiling at all, which is the exact
    // opposite of what the person typing it meant.
    softLimitUsd: z.number().min(0).max(1_000_000).nullable().optional(),
    hardLimitUsd: z.number().min(0).max(1_000_000).nullable().optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(400).nullable().optional(),
  })
  .refine((body) => body.scopeType === "GLOBAL" || Boolean(body.scopeId?.trim()), {
    message: "A budget on an agent or a tool needs to say which one.",
  })
  .refine(
    (body) =>
      body.softLimitUsd === null ||
      body.softLimitUsd === undefined ||
      body.hardLimitUsd === null ||
      body.hardLimitUsd === undefined ||
      body.softLimitUsd <= body.hardLimitUsd,
    { message: "The warning level has to be at or below the ceiling, or it would never fire." },
  );

/** GET /api/costs/budgets — every ceiling, and what it has spent this period. */
costsRouter.get("/budgets", async (_req, res, next) => {
  try {
    res.json({ budgets: await listBudgets() });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/costs/budgets — set or change one.
 *
 * An upsert on the scope rather than a create, because a scope has one ceiling
 * per period by definition and two rows disagreeing about it is not a state
 * worth being able to reach. The unique index says the same thing.
 */
costsRouter.put("/budgets", async (req, res, next) => {
  try {
    const body = budgetBody.parse(req.body ?? {});
    res.json({ budget: await setBudget(body), budgets: await listBudgets() });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/costs/budgets/:id — no ceiling at all, which is the shipped state. */
costsRouter.delete("/budgets/:id", async (req, res, next) => {
  try {
    await removeBudget(req.params.id);
    res.json({ budgets: await listBudgets() });
  } catch (err) {
    next(err);
  }
});
