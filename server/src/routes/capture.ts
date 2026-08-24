import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { interpret } from "../services/captureIntent.js";
import type { QuickActorKind } from "../services/scraperTemplates.js";
import {
  TASK_KINDS,
  actorInput,
  checkForTask,
  describeTasks,
  readActorOverrides,
  resolveActor,
} from "../services/captureActors.js";
import { runSource } from "../services/scraperRunner.js";
import { readCaptureConfig } from "../services/captureConfig.js";
import { estimateCost } from "../services/captureCost.js";
import { getActorSchema } from "../lib/apify.js";
import { gateBy } from "../middleware/permissionGate.js";

/**
 * Quick capture: paste a link or say what you want, then confirm.
 *
 * Two steps on purpose. `/interpret` reads the request and costs nothing when
 * it is already a link; `/run` spends money. Five pay-per-event actors sit
 * behind this, so the plan is shown before it runs rather than after.
 */
export const captureRouter = Router();

captureRouter.use(gateBy({ view: "leads.sources", create: "leads.sources", edit: "leads.sources", remove: "leads.sources" }));

// Same gate as the scrapers router: starting a run spends real money.

captureRouter.post("/interpret", async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().max(4000) }).parse(req.body);
    res.json(await interpret(text));
  } catch (err) {
    next(err);
  }
});

/**
 * The tasks that can be run and the actor behind each. Quick capture offers
 * these when it wants a target's task corrected, or when the words could not be
 * read at all and the person names the task themselves.
 */
captureRouter.get("/tasks", async (_req, res, next) => {
  try {
    res.json({ tasks: await describeTasks() });
  } catch (err) {
    next(err);
  }
});

/**
 * Reads one value against one task without running anything, so the UI can say
 * "that is an Instagram link" while somebody is still typing.
 */
captureRouter.post("/check", async (req, res, next) => {
  try {
    const { kind, value } = z
      .object({ kind: z.enum(TASK_KINDS as [QuickActorKind, ...QuickActorKind[]]), value: z.string().max(500) })
      .parse(req.body);
    res.json(checkForTask(kind, value));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/capture/estimate — what running these targets will cost.
 *
 * The confirmation step already said what would be captured; it could not say
 * what it would cost, which is the other half of the decision when five
 * pay-per-event actors sit behind the button. Grouped exactly the way `/run`
 * groups them, so the number shown is the number billed.
 */
captureRouter.post("/estimate", async (req, res, next) => {
  try {
    const { targets } = z
      .object({
        targets: z
          .array(z.object({ kind: z.enum(TASK_KINDS as [QuickActorKind, ...QuickActorKind[]]), value: z.string().max(500) }))
          .max(50),
      })
      .parse(req.body ?? {});

    const config = await readCaptureConfig();
    const overrides = await readActorOverrides();

    const grouped = new Map<QuickActorKind, string[]>();
    for (const target of targets) {
      const checked = checkForTask(target.kind, target.value);
      if (checked.problem) continue;
      grouped.set(target.kind, [...(grouped.get(target.kind) ?? []), checked.value]);
    }

    const perTask = await Promise.all(
      [...grouped].map(async ([kind, values]) => {
        const actor = await resolveActor(kind, overrides);
        const input = actorInput(actor, values);
        const schema = await getActorSchema(actor.actorId).catch(() => null);
        const estimate = await estimateCost(actor.actorId, input, config.maxItems, schema?.properties ?? null);
        return { kind, label: actor.label, actorId: actor.actorId, count: values.length, estimate };
      }),
    );

    const priced = perTask.filter((task) => task.estimate.totalUsd != null);
    res.json({
      tasks: perTask,
      totalUsd: priced.length ? Number(priced.reduce((sum, task) => sum + (task.estimate.totalUsd ?? 0), 0).toFixed(4)) : null,
      // True when at least one actor couldn't be priced, so the total is a
      // partial figure rather than the whole bill.
      partial: priced.length !== perTask.length,
    });
  } catch (err) {
    next(err);
  }
});

const runInput = z.object({
  targets: z
    .array(
      z.object({
        kind: z.enum(TASK_KINDS as [QuickActorKind, ...QuickActorKind[]]),
        value: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(50),
  /** Names the batch on the Leads screen. */
  label: z.string().max(120).optional(),
});

captureRouter.post("/run", async (req, res, next) => {
  try {
    const { targets, label } = runInput.parse(req.body);
    const config = await readCaptureConfig();
    const overrides = await readActorOverrides();
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

    const started: Array<{ kind: string; runId: string; count: number }> = [];
    const failed: Array<{ kind: string; reason: string }> = [];

    // Every value is checked against the task it was given before a single run
    // starts. These actors bill per event: an Instagram handle sent to the
    // Facebook actor is money spent on nothing, and the person can only be
    // asked which task they meant while it is still free to ask.
    const grouped = new Map<QuickActorKind, string[]>();
    for (const target of targets) {
      const checked = checkForTask(target.kind, target.value);
      if (checked.problem) {
        failed.push({ kind: target.kind, reason: `${target.value} — ${checked.problem}` });
        continue;
      }
      grouped.set(target.kind, [...(grouped.get(target.kind) ?? []), checked.value]);
    }

    for (const [kind, values] of grouped) {
      const actor = await resolveActor(kind, overrides);
      try {
        // A throwaway source per paste: two people capturing at once must not
        // overwrite each other's input between the write and the run.
        const source = await prisma.scraperSource.create({
          data: {
            name: `${label ?? "Quick capture"} · ${actor.label} · ${stamp}`,
            actorId: actor.actorId,
            input: actorInput(actor, values) as object,
            preset: actor.preset,
            leadSource: actor.leadSource,
            // No date in it: a paste labelled the same way tomorrow belongs in
            // the same list as today's, and an ad-hoc source is thrown away
            // after the run so it can never pin one of its own.
            groupName: `${label ?? "Quick capture"}`,
            adhoc: true,
            enabled: true,
            scheduleEnabled: false,
            maxItems: config.maxItems,
            // Quick capture is a person asking for specific things, so the
            // score floor that filters a bulk scrape would just hide them.
            minScore: 0,
          },
        });
        const run = await runSource(source.id, "MANUAL");
        started.push({ kind, runId: run.id, count: values.length });
      } catch (err) {
        // A budget or concurrency guard doing its job is not a server error —
        // it is a sentence the person needs to read.
        failed.push({ kind, reason: (err as Error).message });
      }
    }

    if (started.length === 0 && failed.length > 0) {
      return res.status(409).json({ error: failed[0].reason, failed });
    }
    res.json({ started, failed });
  } catch (err) {
    next(err);
  }
});
