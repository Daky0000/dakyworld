import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { interpret } from "../services/captureIntent.js";
import { QUICK_ACTORS, quickInput, type QuickActorKind } from "../services/scraperTemplates.js";
import { runSource } from "../services/scraperRunner.js";
import { readCaptureConfig } from "../services/captureConfig.js";

/**
 * Quick capture: paste a link or say what you want, then confirm.
 *
 * Two steps on purpose. `/interpret` reads the request and costs nothing when
 * it is already a link; `/run` spends money. Five pay-per-event actors sit
 * behind this, so the plan is shown before it runs rather than after.
 */
export const captureRouter = Router();

// Same gate as the scrapers router: starting a run spends real money.
captureRouter.use(requireRole("OWNER"));

captureRouter.post("/interpret", async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().max(4000) }).parse(req.body);
    res.json(await interpret(text));
  } catch (err) {
    next(err);
  }
});

const runInput = z.object({
  targets: z
    .array(
      z.object({
        kind: z.enum(Object.keys(QUICK_ACTORS) as [QuickActorKind, ...QuickActorKind[]]),
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
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

    // One source per kind, not per target, so ten pasted URLs are one run.
    const grouped = new Map<QuickActorKind, string[]>();
    for (const t of targets) grouped.set(t.kind, [...(grouped.get(t.kind) ?? []), t.value]);

    const started: Array<{ kind: string; runId: string; count: number }> = [];
    const failed: Array<{ kind: string; reason: string }> = [];

    for (const [kind, values] of grouped) {
      const actor = QUICK_ACTORS[kind];
      try {
        // A throwaway source per paste: two people capturing at once must not
        // overwrite each other's input between the write and the run.
        const source = await prisma.scraperSource.create({
          data: {
            name: `${label ?? "Quick capture"} · ${actor.label} · ${stamp}`,
            actorId: actor.actorId,
            input: quickInput(kind, values) as object,
            preset: actor.preset,
            leadSource: actor.leadSource,
            groupName: `${label ?? "Quick capture"} · {{date}}`,
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
