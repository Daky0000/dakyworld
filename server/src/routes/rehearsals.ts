import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { SCENARIOS } from "../services/rehearsals/scenarios.js";
import { REHEARSAL_GUARANTEE, RehearsalRefused, nudge, startRehearsal, stopRehearsal, teardownRehearsal } from "../services/rehearsals/run.js";
import { listRehearsals, readRehearsal } from "../services/rehearsals/view.js";

/**
 * The rehearsal room.
 *
 * Owner-only for the same reason the Agents screen is: starting one spends
 * real money on real models, and the fact that nothing can leave the building
 * makes it safe rather than free.
 */
export const rehearsalsRouter = Router();

rehearsalsRouter.use(requireRole("OWNER"));

/**
 * The workflows on offer, and what each is for.
 *
 * Every scenario names an agent it starts with, and an agent that has been
 * paused or retired since the workflow was written cannot start anything. So
 * the roster is joined here rather than left for the run to discover: a
 * workflow that would refuse is shown as unavailable with the reason on it,
 * instead of as a button that fails.
 */
rehearsalsRouter.get("/scenarios", async (_req, res, next) => {
  try {
    const agents = await prisma.agent.findMany({
      where: { key: { in: SCENARIOS.map((scenario) => scenario.startAgent) } },
      select: { key: true, name: true, title: true, status: true, autonomyLevel: true, dryRun: true, toolkit: true },
    });
    const byKey = new Map(agents.map((agent) => [agent.key, agent]));

    res.json({
      guarantee: REHEARSAL_GUARANTEE,
      scenarios: SCENARIOS.map((scenario) => {
        const agent = byKey.get(scenario.startAgent);
        return {
          key: scenario.key,
          name: scenario.name,
          purpose: scenario.purpose,
          exercises: scenario.exercises,
          reach: scenario.reach,
          startAgent: scenario.startAgent,
          startAgentName: agent?.name ?? scenario.startAgent,
          startAgentTitle: agent?.title ?? null,
          available: agent?.status === "ACTIVE",
          unavailableBecause: !agent
            ? `There is no agent called ${scenario.startAgent} any more — the roster has moved on from this workflow.`
            : agent.status === "ACTIVE"
              ? null
              : `${agent.name} is a ${agent.status.toLowerCase()} and will not pick anything up. Set them to Active on the Agents screen.`,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

rehearsalsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ rehearsals: await listRehearsals(), guarantee: REHEARSAL_GUARANTEE });
  } catch (err) {
    next(err);
  }
});

const startInput = z.object({
  website: z.string().min(3).max(300),
  scenario: z.string().min(2).max(64),
  businessName: z.string().max(200).nullish(),
  note: z.string().max(1000).nullish(),
});

rehearsalsRouter.post("/", async (req, res, next) => {
  try {
    const input = startInput.parse(req.body);
    const rehearsal = await startRehearsal({ ...input, userId: req.dbUser?.id ?? null });
    res.status(201).json({ id: rehearsal.id, guarantee: REHEARSAL_GUARANTEE });
  } catch (err) {
    if (err instanceof RehearsalRefused) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * One rehearsal, and everything in it.
 *
 * **This read also drives the run**, which is unusual enough to say plainly.
 * The scheduler starts queued agent tasks once a minute, which is the right
 * cadence for standing work and the wrong one for a person watching a chain of
 * six agents happen — five of the six hops would be a still screen. So the
 * screen's own poll starts the next task in its own run.
 *
 * It cannot start anything the scheduler would not have started a minute
 * later, it holds the same per-agent lock, and two polls arriving together
 * cannot double-start because the claim is a conditional update that only one
 * can win. `nudging` is belt to that braces: it keeps a slow drain from being
 * entered again by the next poll two seconds later.
 */
const nudging = new Set<string>();

rehearsalsRouter.get("/:id", async (req, res, next) => {
  try {
    const view = await readRehearsal(req.params.id);
    if (!view) return res.status(404).json({ error: "No such rehearsal." });

    if (view.status === "RUNNING" && !nudging.has(view.id)) {
      nudging.add(view.id);
      void nudge(view.id)
        .catch((err) => console.error(`[rehearsal] nudge for ${view.id} failed:`, (err as Error).message))
        .finally(() => nudging.delete(view.id));
    }

    res.json(view);
  } catch (err) {
    next(err);
  }
});

rehearsalsRouter.post("/:id/stop", async (req, res, next) => {
  try {
    const rehearsal = await prisma.rehearsal.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
    if (!rehearsal) return res.status(404).json({ error: "No such rehearsal." });
    if (rehearsal.status !== "RUNNING") return res.status(409).json({ error: "That one has already finished." });

    const asked = await stopRehearsal(rehearsal.id);
    res.json({
      stopped: true,
      // Said as a request rather than as a fact, because for a RUNNING task it
      // is one: the loop honours it at the next point where its conversation is
      // whole, which is usually within a tool call.
      message:
        asked === 0
          ? "Nothing was left to stop."
          : `Asked ${asked} task${asked === 1 ? "" : "s"} to stop. Anything mid-sentence finishes its current step first and keeps its place.`,
    });
  } catch (err) {
    next(err);
  }
});

rehearsalsRouter.delete("/:id", async (req, res, next) => {
  try {
    const result = await teardownRehearsal(req.params.id);
    res.json({
      deleted: true,
      ...result,
      // Said rather than assumed: what a rehearsal spent stays in the ledger
      // next to what everything else spent, or the monthly total stops meaning
      // anything.
      note: "The tasks and the scratch lead are gone. What it spent stays on the model and tool ledgers.",
    });
  } catch (err) {
    if (err instanceof RehearsalRefused) return res.status(409).json({ error: err.message });
    next(err);
  }
});
