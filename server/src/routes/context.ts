import { Router } from "express";
import { z } from "zod";
import { MemoryRefused, upsertLivingContext } from "../services/agents/memory.js";
import { appendNote, deleteNote, editNote, gatherEntries, listLivingContext, listNotes, parseSubject, renderDossier } from "../services/context/dossier.js";
import { renderMarkdownPdf } from "../services/markdownPdf.js";
import { gateBy } from "../middleware/permissionGate.js";

/**
 * A company's history — what happened, as opposed to what an agent concluded.
 *
 * Mounted at `/api/context/:subject`, where a subject is `lead:abc123`,
 * `client:xyz`, `project:123` or `company` — the same vocabulary agent memory
 * files against, so one spelling answers both questions.
 *
 * **Two formats, one source.** The Markdown is what the agents read; the PDF
 * renders that same Markdown onto the letterhead rather than assembling a
 * second version of it. Two renderers over one set of facts is how a document
 * and its summary end up disagreeing.
 */
export const contextRouter = Router();

contextRouter.use(
  gateBy({
    // The company dossier is what every agent writes from, so everybody who can
    // open the app can read it; changing it is a settings decision.
    view: "dashboard.view",
    create: "settings.company",
    edit: "settings.company",
    remove: "settings.company",
  }),
);

const NOTE_KINDS = ["NOTE", "CALL", "MEETING", "REPLY", "DECISION", "OUTCOME", "RISK"] as const;

/** The dossier, as structured entries + active living context for the panel to draw. */
contextRouter.get("/:subject", async (req, res, next) => {
  try {
    const subject = parseSubject(req.params.subject);
    if (!subject) return res.status(400).json({ error: "Use company, lead:<id>, client:<id> or project:<id>." });

    const { header, entries } = await gatherEntries(subject);
    if (!header.found) return res.status(404).json({ error: "No record found for that." });

    const livingContext = await listLivingContext(subject.key, subject.kind !== "company");
    const limit = Number.parseInt(String(req.query.limit ?? "60"), 10);
    res.json({
      subject: subject.key,
      header,
      livingContext,
      entries: entries.slice(0, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 60),
      total: entries.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Reads or updates the Dynamic Living Context whiteboard (`kind: "living_context"`)
 * for `company`, `lead:<id>`, `client:<id>` or `project:<id>`.
 */
contextRouter.get("/:subject/living", async (req, res, next) => {
  try {
    const subject = parseSubject(req.params.subject);
    if (!subject) return res.status(400).json({ error: "Use company, lead:<id>, client:<id> or project:<id>." });

    const includeCompany = req.query.includeCompany !== "false" && subject.kind !== "company";
    const livingContext = await listLivingContext(subject.key, includeCompany);
    res.json({ subject: subject.key, livingContext });
  } catch (err) {
    next(err);
  }
});

contextRouter.put("/:subject/living", async (req, res, next) => {
  try {
    const subject = parseSubject(req.params.subject);
    if (!subject) return res.status(400).json({ error: "Use company, lead:<id>, client:<id> or project:<id>." });

    const input = z
      .object({
        key: z.string().min(2).max(80),
        value: z.string().min(2).max(1200),
        reason: z.string().max(240).optional(),
      })
      .parse(req.body);

    const saved = await upsertLivingContext({
      agentKey: "owner",
      subject: subject.key,
      key: input.key,
      value: input.value,
      reason: input.reason ?? "Owner manual override via Dossier API",
    });
    res.json({ ok: true, subject: subject.key, saved });
  } catch (err) {
    if (err instanceof MemoryRefused) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * The same thing as Markdown, or as a branded PDF.
 *
 * `?format=pdf` renders the Markdown that was just produced — deliberately the
 * identical bytes, so what a person prints is what the agents were reading.
 */
contextRouter.get("/:subject/document", async (req, res, next) => {
  try {
    const subject = parseSubject(req.params.subject);
    if (!subject) return res.status(400).json({ error: "Use company, lead:<id>, client:<id> or project:<id>." });

    const { header } = await gatherEntries(subject);
    if (!header.found) return res.status(404).json({ error: "No record found for that." });

    const markdown = await renderDossier(subject.key, { limit: 200 });
    const safeName = header.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "dossier";

    if (req.query.format === "pdf") {
      const pdf = await renderMarkdownPdf(markdown, {
        kicker: "What we know",
        title: header.name,
        subtitle: `Everything on file, as at ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
      });
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `inline; filename="${safeName}-history.pdf"`);
      return res.send(pdf);
    }

    res.setHeader("content-type", "text/markdown; charset=utf-8");
    res.setHeader("content-disposition", `inline; filename="${safeName}-history.md"`);
    res.send(markdown);
  } catch (err) {
    next(err);
  }
});

/** The notes a person or an agent has added, as opposed to the whole history. */
contextRouter.get("/:subject/notes", async (req, res, next) => {
  try {
    res.json({ notes: await listNotes(req.params.subject) });
  } catch (err) {
    next(err);
  }
});

/**
 * Adding to the history by hand.
 *
 * The obvious use is a call. Nothing in this system dials a phone, so a call
 * reaches a company's history because somebody wrote it down — which is worth
 * saying plainly rather than implying the app was listening.
 */
contextRouter.post("/:subject/notes", async (req, res, next) => {
  try {
    const input = z
      .object({
        kind: z.enum(NOTE_KINDS).default("NOTE"),
        summary: z.string().min(4).max(300),
        body: z.string().max(4000).optional(),
        pinned: z.boolean().default(false),
        occurredAt: z.coerce.date().optional(),
      })
      .parse(req.body);

    const note = await appendNote({
      subject: req.params.subject,
      kind: input.kind,
      summary: input.summary,
      body: input.body ?? null,
      authorKey: "owner",
      pinned: input.pinned,
      occurredAt: input.occurredAt,
    });
    res.status(201).json(note);
  } catch (err) {
    if (err instanceof MemoryRefused) return res.status(400).json({ error: err.message });
    next(err);
  }
});

contextRouter.patch("/notes/:id", async (req, res, next) => {
  try {
    const input = z
      .object({
        summary: z.string().min(4).max(300).optional(),
        body: z.string().max(4000).nullish(),
        pinned: z.boolean().optional(),
        kind: z.enum(NOTE_KINDS).optional(),
      })
      .parse(req.body);

    res.json(await editNote(req.params.id, { ...input, body: input.body ?? undefined }));
  } catch (err) {
    if (err instanceof MemoryRefused) return res.status(400).json({ error: err.message });
    next(err);
  }
});

contextRouter.delete("/notes/:id", async (req, res, next) => {
  try {
    await deleteNote(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
