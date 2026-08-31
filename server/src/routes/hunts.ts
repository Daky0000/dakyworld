import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { gateBy } from "../middleware/permissionGate.js";
import { isValidTimezone, parseScheduleTime } from "../services/scheduler.js";
import { HuntBusyError, hunt, nextHuntAt, syncThesis } from "../services/hunt/run.js";
import { shippedThesis } from "../services/hunt/theses.js";
import { parseQualifier, signalCatalogue } from "../services/hunt/signals.js";
import { CaptureBudgetError, CaptureBusyError, ScrapeInProgressError } from "../services/scraperRunner.js";

/**
 * The hunts — why Dakyworld goes looking for anybody.
 *
 * Same gate as the lead sources, and for the same reason: turning a hunt on
 * starts spending money twice a day without anybody pressing anything.
 *
 * The one deliberate asymmetry in here is that **`enabled` can only be set by a
 * person**, never as a side effect of saving something else. A PATCH that
 * happens to include `enabled: true` while the Owner was editing a qualifier is
 * how a search starts running that nobody meant to start, so switching one on
 * is its own endpoint with its own answer.
 */
export const huntsRouter = Router();

huntsRouter.use(gateBy({ view: "leads.sources", create: "leads.sources", edit: "leads.sources", remove: "leads.sources" }));

const scheduleTime = z.string().refine((value) => parseScheduleTime(value) !== null, {
  message: "Use 24-hour HH:mm, e.g. 07:30",
});

function describe(thesis: {
  id: string;
  key: string;
  name: string;
  target: string;
  rationale: string;
  offer: string;
  qualifiers: string[];
  disqualifiers: string[];
  minScore: number;
  leadsPerRun: number;
  runTimes: string[];
  timezone: string;
  sourceId: string | null;
  routePriority: number;
  routeAgentKey: string | null;
  deleteRejected: boolean;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  custom: boolean;
  editedAt: Date | null;
}) {
  // Each line said back with whether it is decided from the audit for nothing
  // or has to be read by a model. That difference is what a thesis costs to
  // run, and it should be visible while somebody is writing one rather than
  // discoverable from the bill.
  const explain = (lines: string[]) =>
    lines.map((line) => {
      const { signal, prose } = parseQualifier(line);
      return { line, signal: signal?.key ?? null, says: prose, checkedBy: signal ? "the audit" : "a model" };
    });

  return {
    id: thesis.id,
    key: thesis.key,
    name: thesis.name,
    target: thesis.target,
    rationale: thesis.rationale,
    offer: thesis.offer,
    qualifiers: explain(thesis.qualifiers),
    disqualifiers: explain(thesis.disqualifiers),
    minScore: thesis.minScore,
    leadsPerRun: thesis.leadsPerRun,
    runTimes: thesis.runTimes,
    timezone: thesis.timezone,
    sourceId: thesis.sourceId,
    routePriority: thesis.routePriority,
    routeAgentKey: thesis.routeAgentKey,
    deleteRejected: thesis.deleteRejected,
    enabled: thesis.enabled,
    lastRunAt: thesis.lastRunAt,
    nextRunAt: thesis.nextRunAt,
    custom: thesis.custom,
    edited: Boolean(thesis.editedAt),
    hasShippedWording: Boolean(shippedThesis(thesis.key)),
    /** What a full cycle would cost per day at this configuration, roughly. */
    perDay: thesis.runTimes.length * thesis.leadsPerRun,
  };
}

/** Every signal a qualifier may name, so the editor is not a guessing game. */
huntsRouter.get("/signals", (_req, res) => res.json({ signals: signalCatalogue() }));

huntsRouter.get("/", async (_req, res, next) => {
  try {
    const theses = await prisma.leadThesis.findMany({
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
      include: {
        source: { select: { id: true, name: true, actorId: true, enabled: true } },
        hunts: { orderBy: { startedAt: "desc" }, take: 1 },
        _count: { select: { verdicts: true } },
      },
    });

    const qualified = await prisma.leadVerdict.groupBy({
      by: ["thesisId", "verdict"],
      _count: true,
    });

    res.json({
      theses: theses.map((thesis) => {
        const counts = qualified.filter((row) => row.thesisId === thesis.id);
        const count = (kind: string) => counts.find((row) => row.verdict === kind)?._count ?? 0;
        return {
          ...describe(thesis),
          source: thesis.source,
          judged: thesis._count.verdicts,
          qualified: count("QUALIFIED"),
          rejected: count("REJECTED"),
          undecided: count("UNDECIDED"),
          lastHunt: thesis.hunts[0]
            ? {
                id: thesis.hunts[0].id,
                at: thesis.hunts[0].startedAt,
                status: thesis.hunts[0].status,
                summary: thesis.hunts[0].summary,
                costUsd: Number(thesis.hunts[0].costUsd),
              }
            : null,
        };
      }),
      summary: {
        total: theses.length,
        running: theses.filter((thesis) => thesis.enabled).length,
        leadsPerDay: theses
          .filter((thesis) => thesis.enabled)
          .reduce((sum, thesis) => sum + thesis.runTimes.length * thesis.leadsPerRun, 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

huntsRouter.get("/:key", async (req, res, next) => {
  try {
    const thesis = await prisma.leadThesis.findUnique({
      where: { key: req.params.key },
      include: {
        source: true,
        hunts: { orderBy: { startedAt: "desc" }, take: 20 },
      },
    });
    if (!thesis) return res.status(404).json({ error: "There is no hunt with that key." });

    const verdicts = await prisma.leadVerdict.findMany({
      where: { thesisId: thesis.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        companyName: true,
        website: true,
        city: true,
        verdict: true,
        score: true,
        reason: true,
        deleted: true,
        leadId: true,
        createdAt: true,
        signals: true,
      },
    });

    res.json({
      ...describe(thesis),
      source: thesis.source,
      hunts: thesis.hunts.map((row) => ({
        id: row.id,
        status: row.status,
        trigger: row.trigger,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        captured: row.captured,
        audited: row.audited,
        qualified: row.qualified,
        rejected: row.rejected,
        skipped: row.skipped,
        routed: row.routed,
        costUsd: Number(row.costUsd),
        summary: row.summary,
        error: row.error,
      })),
      verdicts,
    });
  } catch (err) {
    next(err);
  }
});

const thesisInput = z.object({
  name: z.string().min(1).max(120),
  target: z.string().min(10).max(1000),
  rationale: z.string().min(10).max(4000),
  offer: z.string().min(5).max(1000),
  qualifiers: z.array(z.string().min(3).max(500)).max(20),
  disqualifiers: z.array(z.string().min(3).max(500)).max(20),
  minScore: z.number().int().min(0).max(100),
  // The Owner's instruction: five a run, two runs a day. Capped at twenty
  // because every one of these is audited, and twenty audits in one cycle is a
  // bill somebody should have to type on purpose.
  leadsPerRun: z.number().int().min(1).max(20),
  runTimes: z.array(scheduleTime).max(6),
  timezone: z.string().refine(isValidTimezone, { message: "That isn't a timezone this system knows." }),
  sourceId: z.string().nullish(),
  routePriority: z.number().int().min(1).max(3),
  routeAgentKey: z.string().max(64).nullish(),
  deleteRejected: z.boolean(),
});

huntsRouter.post("/", async (req, res, next) => {
  try {
    const input = thesisInput.parse(req.body);
    const key = z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, numbers and hyphens, starting with a letter.")
      .parse(String(req.body?.key ?? "").toLowerCase());

    if (await prisma.leadThesis.findUnique({ where: { key } })) {
      return res.status(409).json({ error: `There is already a hunt called ${key}.` });
    }
    await assertRoutable(input.routeAgentKey);

    const thesis = await prisma.leadThesis.create({
      data: { ...input, key, custom: true, enabled: false },
    });
    res.status(201).json(describe(thesis));
  } catch (err) {
    next(err);
  }
});

huntsRouter.patch("/:key", async (req, res, next) => {
  try {
    const existing = await prisma.leadThesis.findUnique({ where: { key: req.params.key } });
    if (!existing) return res.status(404).json({ error: "There is no hunt with that key." });

    const input = thesisInput.partial().parse(req.body);
    if (input.routeAgentKey !== undefined) await assertRoutable(input.routeAgentKey);

    const thesis = await prisma.leadThesis.update({
      where: { id: existing.id },
      data: {
        ...input,
        // Set the first time somebody rewrites a seeded hunt, so a deploy knows
        // to leave their wording alone from then on. The same contract an
        // agent's prompt keeps.
        ...(existing.custom || existing.editedAt ? {} : { editedAt: new Date() }),
      },
    });
    await syncThesis(thesis.id);
    const fresh = await prisma.leadThesis.findUnique({ where: { id: thesis.id } });
    res.json(describe(fresh!));
  } catch (err) {
    next(err);
  }
});

/**
 * Switching a hunt on or off — its own endpoint, deliberately.
 *
 * The answer says what was actually agreed to, in numbers: how many businesses
 * a day this will look at and roughly what that costs. "Enabled: true" is not
 * informed consent to a standing daily charge.
 */
huntsRouter.post("/:key/enabled", async (req, res, next) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const thesis = await prisma.leadThesis.findUnique({ where: { key: req.params.key }, include: { source: true } });
    if (!thesis) return res.status(404).json({ error: "There is no hunt with that key." });

    if (enabled) {
      if (!thesis.sourceId) {
        return res.status(400).json({ error: "This hunt has no search attached, so there is nothing for it to run. Attach a lead source first." });
      }
      if (thesis.runTimes.length === 0) {
        return res.status(400).json({ error: "This hunt has no run times, so it would never start. Add at least one." });
      }
      if (thesis.qualifiers.length === 0) {
        return res.status(400).json({ error: "This hunt has nothing to judge a business against, so everything it found would be undecided. Write at least one qualifier." });
      }
    }

    const updated = await prisma.leadThesis.update({
      where: { id: thesis.id },
      data: { enabled, nextRunAt: enabled ? nextHuntAt({ ...thesis, enabled }) : null },
    });

    const perDay = updated.runTimes.length * updated.leadsPerRun;
    res.json({
      ...describe(updated),
      note: enabled
        ? `Running. ${updated.runTimes.length} time(s) a day, up to ${updated.leadsPerRun} business(es) each — about ${perDay} audited a day. ` +
          `Anything scoring under ${updated.minScore} is ${updated.deleteRejected ? "deleted from the pipeline" : "marked disqualified"}.`
        : "Stopped. Nothing further will run on its own; anything already in flight finishes.",
    });
  } catch (err) {
    next(err);
  }
});

/** One cycle, now. Same work the schedule does, with a person behind it. */
huntsRouter.post("/:key/run", async (req, res, next) => {
  try {
    const thesis = await prisma.leadThesis.findUnique({ where: { key: req.params.key } });
    if (!thesis) return res.status(404).json({ error: "There is no hunt with that key." });
    if (!thesis.sourceId) return res.status(400).json({ error: "This hunt has no search attached, so there is nothing to run." });

    // Not awaited. A cycle is a capture, up to five audits and up to five
    // judgements — minutes of work that must survive the tab being closed.
    void hunt(thesis.id, "MANUAL").catch((err) => console.error(`[hunt] "${thesis.name}" failed:`, (err as Error).message));
    res.status(202).json({
      started: true,
      note: `Hunting under "${thesis.name}". It will look at up to ${thesis.leadsPerRun} business(es) and report back on this screen.`,
    });
  } catch (err) {
    if (err instanceof HuntBusyError) return res.status(409).json({ error: err.message });
    if (err instanceof CaptureBusyError || err instanceof CaptureBudgetError || err instanceof ScrapeInProgressError) {
      return res.status(409).json({ error: (err as Error).message });
    }
    next(err);
  }
});

/** Hands a seeded hunt back its shipped wording. Refuses on one nobody shipped. */
huntsRouter.post("/:key/reset", async (req, res, next) => {
  try {
    const thesis = await prisma.leadThesis.findUnique({ where: { key: req.params.key } });
    if (!thesis) return res.status(404).json({ error: "There is no hunt with that key." });
    const shipped = shippedThesis(thesis.key);
    if (!shipped) return res.status(400).json({ error: "This hunt was written here, so there is no shipped wording to go back to." });

    const updated = await prisma.leadThesis.update({
      where: { id: thesis.id },
      data: {
        name: shipped.name,
        target: shipped.target,
        rationale: shipped.rationale,
        offer: shipped.offer,
        qualifiers: shipped.qualifiers,
        disqualifiers: shipped.disqualifiers,
        minScore: shipped.minScore,
        leadsPerRun: shipped.leadsPerRun,
        runTimes: shipped.runTimes,
        routePriority: shipped.routePriority,
        routeAgentKey: shipped.routeAgentKey,
        editedAt: null,
      },
    });
    await syncThesis(updated.id);
    res.json(describe(updated));
  } catch (err) {
    next(err);
  }
});

huntsRouter.delete("/:key", async (req, res, next) => {
  try {
    const thesis = await prisma.leadThesis.findUnique({ where: { key: req.params.key } });
    if (!thesis) return res.status(404).json({ error: "There is no hunt with that key." });
    if (!thesis.custom) {
      return res.status(400).json({ error: "A shipped hunt cannot be deleted. Switch it off instead — its verdicts are what stop those businesses being audited again." });
    }
    // Cascades the verdicts with it, which is the point of refusing above: the
    // tombstones are the only record that a business has already been judged.
    await prisma.leadThesis.delete({ where: { id: thesis.id } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

/** A route to an agent that is not on the roster loses every lead it qualifies. */
async function assertRoutable(key: string | null | undefined) {
  if (!key) return;
  const agent = await prisma.agent.findUnique({ where: { key }, select: { key: true } });
  if (!agent) throw Object.assign(new Error(`There is no agent called ${key}, so qualified leads would go nowhere.`), { status: 400 });
}
