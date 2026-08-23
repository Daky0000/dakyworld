import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { SCENARIOS } from "../services/rehearsals/scenarios.js";
import { REHEARSAL_GUARANTEE, RehearsalRefused, nudge, startRehearsal, stopRehearsal, teardownRehearsal } from "../services/rehearsals/run.js";
import { listRehearsals, readRehearsal } from "../services/rehearsals/view.js";
import { reportsUnder } from "../services/rehearsals/wake.js";
import { gateBy } from "../middleware/permissionGate.js";

/**
 * The rehearsal room.
 *
 * Owner-only for the same reason the Agents screen is: starting one spends
 * real money on real models, and the fact that nothing can leave the building
 * makes it safe rather than free.
 */
export const rehearsalsRouter = Router();

rehearsalsRouter.use(
  gateBy({
    view: "agents.rehearsals.view",
    create: "agents.rehearsals.run",
    remove: "agents.rehearsals.run",
  }),
);


/**
 * The workflows on offer, what each is for, and who each would wake.
 *
 * Every scenario names an agent it starts with, and most of the roster seeds as
 * a draft — so the first version of this screen showed five greyed-out cards
 * and an errand. A rehearsal wakes the drafts it needs and puts them back when
 * it ends, so the honest thing to show is **who it would switch on**, counted
 * here rather than discovered afterwards on the Agents screen.
 *
 * A paused or retired starting agent is still unavailable, and says so. That
 * is a decision somebody made, and a test is not a reason to overrule it.
 */
rehearsalsRouter.get("/scenarios", async (_req, res, next) => {
  try {
    const roster = await prisma.agent.findMany({ select: { key: true, name: true, title: true, status: true, managerKey: true } });
    const byKey = new Map(roster.map((agent) => [agent.key, agent]));

    const scenarios = await Promise.all(
      SCENARIOS.map(async (scenario) => {
        const agent = byKey.get(scenario.startAgent);
        // The reporting tree under the starting agent — the set `delegate` can
        // reach. A hand-off can go anywhere and is woken as it happens, so this
        // is a floor on the count rather than a promise about it.
        const reachable = agent ? await reportsUnder(agent.key) : [];
        const wouldWake = reachable.filter((key) => byKey.get(key)?.status === "DRAFT");
        const blocked = agent && (agent.status === "PAUSED" || agent.status === "RETIRED");

        return {
          key: scenario.key,
          name: scenario.name,
          purpose: scenario.purpose,
          exercises: scenario.exercises,
          reach: scenario.reach,
          startAgent: scenario.startAgent,
          startAgentName: agent?.name ?? scenario.startAgent,
          startAgentTitle: agent?.title ?? null,
          available: Boolean(agent) && !blocked,
          /** How many drafts starting this would switch on, and put back afterwards. */
          wouldWake: wouldWake.length,
          wouldWakeNames: wouldWake.slice(0, 6).map((key) => byKey.get(key)?.name ?? key),
          unavailableBecause: !agent
            ? `There is no agent called ${scenario.startAgent} any more — the roster has moved on from this workflow.`
            : blocked
              ? `${agent.name} is ${agent.status.toLowerCase()}. A rehearsal wakes agents that were never switched on; it does not undo a decision you made.`
              : null,
        };
      }),
    );

    res.json({ guarantee: REHEARSAL_GUARANTEE, scenarios });
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
  // Zero is a value, not an absence: it is the obvious way to ask for no
  // ceiling at all, and a `.positive()` here would silently restore the
  // default instead — the same trap as the hiring ceilings.
  budgetUsd: z.number().min(0).max(100).nullish(),
});

rehearsalsRouter.post("/", async (req, res, next) => {
  try {
    const input = startInput.parse(req.body);
    const { rehearsal, woke } = await startRehearsal({ ...input, userId: req.dbUser?.id ?? null });
    res.status(201).json({
      id: rehearsal.id,
      guarantee: REHEARSAL_GUARANTEE,
      // What it switched on to make the run possible, so that is something the
      // Owner reads rather than discovers on the Agents screen afterwards.
      woke: Object.keys(woke.woke),
      refusedToWake: woke.refused,
    });
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
