import express, { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { attachUser } from "../middleware/auth.js";
import { AnalystError, analystConfigured, analyzeGrids } from "../lib/anthropic.js";
import { GoogleError, getDriveFile, listSpreadsheets, listTabs, readGrids } from "../lib/google.js";
import { gateBy } from "../middleware/permissionGate.js";
import { handleGoogleCallback } from "./settings.js";
import { detectTables, normalizePlan, repairPlan, type ImportPlan, type PlanTable } from "../services/sheetPlan.js";
import {
  MAX_ROWS_PER_SHEET,
  SpreadsheetError,
  isSpreadsheetName,
  listWorkbookSheets,
  parseWorkbook,
  type SheetGrid,
} from "../services/spreadsheet.js";
import { buildPreviews, buildPreviewsFrom, commitPlan, loadCheckpoint, normalizePlanFrom, type TablePreview } from "../services/leadImport.js";
import { sourceFromDrive, sourceFromUpload, type GridSource } from "../services/sheetSource.js";

export const importsRouter = Router();

importsRouter.use(attachUser);
importsRouter.use(gateBy({ view: "leads.import", create: "leads.import", edit: "leads.import", remove: "leads.import" }));

// An uploaded workbook rides in the JSON body as base64, so these routes parse
// bodies far larger than the rest of the API allows. Deliberately after the
// role check: nobody unauthenticated gets to hand us 28 MB to parse.
importsRouter.use(express.json({ limit: "28mb" }));

// Google's consent redirect lands here because this is the URI registered on
// the OAuth client. The handler itself belongs with the rest of the settings
// code; only the path is fixed. See lib/google.ts → redirectUri.
importsRouter.get("/google/callback", handleGoogleCallback);

/**
 * The uploaded file, kept for the length of an analysis.
 *
 * What used to be cached here was the *parsed* workbook — every tab of it, as
 * grids. That is the thing a 39-tab file cannot afford: a third of a million
 * cells held between one request and the next, per import. The file itself is
 * at most 20 MB and reading one tab out of it is cheap, so what is kept is the
 * bytes, and each request reads only the tab it needs.
 *
 * Losing this is harmless in every direction: the browser still holds the file
 * and re-sends it, and a Drive import re-reads from Drive.
 */
const fileCache = new Map<string, { buffer: Buffer; fileName: string; at: number }>();
const FILE_CACHE_TTL_MS = 60 * 60_000;
/** Three 20 MB workbooks at once is the most this will hold on to. */
const FILE_CACHE_MAX_BYTES = 60 * 1024 * 1024;

function cacheFile(importId: string, buffer: Buffer, fileName: string) {
  fileCache.set(importId, { buffer, fileName, at: Date.now() });
  for (const [key, entry] of fileCache) {
    if (Date.now() - entry.at > FILE_CACHE_TTL_MS) fileCache.delete(key);
  }

  // Oldest first, and never the one just cached — the next request is for it.
  let held = [...fileCache.values()].reduce((total, entry) => total + entry.buffer.length, 0);
  for (const [key, entry] of [...fileCache.entries()].sort((a, b) => a[1].at - b[1].at)) {
    if (held <= FILE_CACHE_MAX_BYTES || key === importId) continue;
    fileCache.delete(key);
    held -= entry.buffer.length;
  }
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function decodeUpload(dataBase64: string): Buffer {
  // Accepts a bare base64 string or a data: URL, since both are one line of
  // client code away and neither is worth failing over.
  const payload = dataBase64.includes(",") && dataBase64.startsWith("data:") ? dataBase64.slice(dataBase64.indexOf(",") + 1) : dataBase64;
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) throw new SpreadsheetError("That file came through empty.");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new SpreadsheetError("That file is over 20 MB. Split it, or import it from Google Drive instead.");
  }
  return buffer;
}

// --- Google Drive browsing -------------------------------------------------

importsRouter.get("/google/files", async (req, res, next) => {
  try {
    const search = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json({ files: await listSpreadsheets(search) });
  } catch (err) {
    if (err instanceof GoogleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

importsRouter.get("/google/files/:id", async (req, res, next) => {
  try {
    const file = await getDriveFile(req.params.id);
    res.json({ file, sheets: await listTabs(file) });
  } catch (err) {
    if (err instanceof GoogleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// --- Reading a file --------------------------------------------------------

// POST /api/imports/sheets — tab names for an upload, before committing to a full read.
importsRouter.post("/sheets", async (req, res, next) => {
  try {
    const { fileName, dataBase64 } = z.object({ fileName: z.string().min(1), dataBase64: z.string().min(1) }).parse(req.body);
    if (!isSpreadsheetName(fileName)) {
      return res.status(400).json({ error: "Upload an .xlsx, .csv or .tsv file." });
    }
    res.json({ sheets: await listWorkbookSheets(decodeUpload(dataBase64), fileName) });
  } catch (err) {
    if (err instanceof SpreadsheetError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * Analysing is one tab per request, and the request says which.
 *
 * It used to be one request for the whole workbook: read every tab, hand all
 * of them to the analyst in a single prompt, answer with the finished plan.
 * On a real file that is 39 tabs, a third of a million cells held at once and
 * a prompt around 100,000 tokens — a request long enough and heavy enough that
 * what came back was "The server didn't answer (502)", with no way to tell
 * whether it had done any of the work.
 *
 * Splitting it fixes four things rather than one: nothing is held but the tab
 * being read, the analyst sees one sheet and reads it better than it read
 * thirty-nine, no single request is long enough to be cut off, and the person
 * watching gets a count that moves.
 */
const analyzeInput = z.object({
  source: z.enum(["UPLOAD", "GOOGLE_SHEET", "GOOGLE_DRIVE_FILE"]).default("UPLOAD"),
  fileName: z.string().optional(),
  dataBase64: z.string().optional(),
  driveFileId: z.string().optional(),
  /** The tabs to read, in the order they will be read. */
  sheetNames: z.array(z.string()).optional(),
  /** False maps the sheet with the pattern rules only — no model call. */
  useAi: z.boolean().default(true),
  /**
   * Set on every call after the first: which import this belongs to, and which
   * of its tabs to read now. Absent on the first, which opens the import and
   * reads nothing.
   */
  importId: z.string().optional(),
  sheet: z.string().optional(),
});

type AnalyzeInput = z.infer<typeof analyzeInput>;

/** The file, from the cache if it is still there and from the caller if not. */
function sourceFor(record: { id: string; driveFileId: string | null; fileName: string | null }, input: AnalyzeInput): GridSource {
  if (record.driveFileId) return sourceFromDrive(record.driveFileId);

  const cached = fileCache.get(record.id);
  if (cached) {
    cached.at = Date.now();
    return sourceFromUpload(cached.buffer, cached.fileName);
  }

  const name = input.fileName ?? record.fileName;
  if (!input.dataBase64 || !name) {
    throw new SpreadsheetError("The uploaded file is no longer on the server. Choose it again to carry on.");
  }
  const buffer = decodeUpload(input.dataBase64);
  cacheFile(record.id, buffer, name);
  return sourceFromUpload(buffer, name);
}

/** Which tabs are done, which are left, and what that is out of. */
function progressOf(record: { sheetNames: string[]; plan: unknown }) {
  const plan = (record.plan ?? { tables: [] }) as ImportPlan;
  const read = new Set((plan.tables ?? []).map((table) => table.sheet));
  const done = record.sheetNames.filter((name) => read.has(name));
  // Order matters: the client reads the next name off the front of this.
  const remaining = record.sheetNames.filter((name) => !read.has(name));
  return { total: record.sheetNames.length, done, remaining, finished: remaining.length === 0 };
}

/**
 * POST /api/imports/analyze — opens an import, then reads one tab per call.
 *
 * Nothing is written to the pipeline here. The reading of the file, a preview
 * of the rows it would create, and the record of the attempt are all that come
 * back; the Owner approves it at /commit.
 */
importsRouter.post("/analyze", async (req, res, next) => {
  let record: { id: string } | null = null;
  try {
    const input = analyzeInput.parse(req.body);

    // --- Opening an import: name the tabs, keep the file, read nothing ------
    if (!input.importId) {
      if (!input.driveFileId) {
        if (!input.dataBase64 || !input.fileName) {
          throw new SpreadsheetError("Send a file to import, or pick one from Google Drive.");
        }
        if (!isSpreadsheetName(input.fileName)) throw new SpreadsheetError("Upload an .xlsx, .csv or .tsv file.");
      }

      const buffer = input.driveFileId ? null : decodeUpload(input.dataBase64 as string);
      const opening = buffer ? sourceFromUpload(buffer, input.fileName as string) : sourceFromDrive(input.driveFileId as string);

      const available = await opening.names();
      const chosen = input.sheetNames?.length ? input.sheetNames.filter((name) => available.includes(name)) : available;
      if (!chosen.length) return res.status(400).json({ error: "That file has no readable tabs." });

      const fileName = await opening.fileName();
      opening.release();

      const opened = await prisma.leadImport.create({
        data: {
          source: input.driveFileId ? "GOOGLE_SHEET" : "UPLOAD",
          status: "ANALYZING",
          fileName,
          driveFileId: input.driveFileId ?? null,
          sheetNames: chosen,
          plan: { tables: [], summary: "" } as unknown as Prisma.InputJsonValue,
        },
      });
      record = opened;
      if (buffer) cacheFile(opened.id, buffer, fileName);

      return res.status(201).json({
        import: opened,
        sheet: null,
        tables: [],
        previews: [],
        repairs: [],
        analyzedBy: null,
        warnings: [],
        progress: progressOf(opened),
      });
    }

    // --- Reading one tab ----------------------------------------------------
    const existing = await prisma.leadImport.findUnique({ where: { id: input.importId } });
    if (!existing) return res.status(404).json({ error: "That import no longer exists. Start again." });
    record = existing;

    const sheet = input.sheet ?? progressOf(existing).remaining[0];
    if (!sheet) return res.status(400).json({ error: "Every tab in this file has already been read." });
    if (!existing.sheetNames.includes(sheet)) {
      return res.status(400).json({ error: `"${sheet}" is not one of the tabs being imported.` });
    }

    const source = sourceFor(existing, input);
    let grid: SheetGrid | undefined;
    try {
      grid = await source.get(sheet);
    } finally {
      // Held only for the length of this request; the file itself stays cached.
      source.release();
    }

    const warnings: string[] = [];
    let tables: PlanTable[] = [];
    let previews: TablePreview[] = [];
    let analyzedBy = "rules";
    let repairs: string[] = [];

    if (!grid || !grid.rows.length) {
      warnings.push(`"${sheet}" has no readable rows, so nothing was taken from it.`);
    } else {
      const hints = detectTables([grid]);
      let plan: ImportPlan = { tables: hints, summary: "" };

      if (input.useAi && (await analystConfigured())) {
        try {
          const analysis = await analyzeGrids([grid], hints);
          plan = analysis.plan;
          analyzedBy = analysis.model;
        } catch (err) {
          // A failed analyst call is a degraded tab, not a failed import — the
          // pattern rules still produced something the Owner can correct, and
          // the other tabs are unaffected by it.
          // Deliberately not prefixed with the tab name. A key that is refused
          // is refused for all 39 of them, and 39 copies of one sentence with a
          // different tab in front of each is a wall nobody reads — the screen
          // dedupes what it is given, so this has to be the same string twice.
          warnings.push(
            err instanceof AnalystError ? err.message : "The AI analyst couldn't be reached, so pattern rules were used instead.",
          );
        }
      } else if (input.useAi) {
        warnings.push("No model is connected, so tabs are being mapped with pattern rules. Add a key for messier files.");
      }

      // A sheet longer than the cap used to be trimmed in silence: 20,000 rows
      // in, 5,000 imported, nothing said. Rows nobody was told about are rows
      // nobody goes looking for.
      if (grid.truncated) {
        warnings.push(
          `Only part of "${grid.name}" was read — ${grid.totalRows.toLocaleString()} rows, first ${MAX_ROWS_PER_SHEET.toLocaleString()} taken. Split the rest into another file.`,
        );
      }

      // `repairPlan` rather than `normalizePlan`, and this is the difference
      // between a plan that *can* be run and one that makes sense. It undoes
      // the two structural mistakes an analyst makes — a table split at a
      // blank row, two tables claiming the same rows — and until now nothing
      // outside the checks had ever called it: the route went straight to
      // `normalizePlan`, which clamps indices and asks no questions. The
      // failure that reaches a person is quiet. A fragment below the split has
      // no header, so none of its columns are named, so nothing in it is a
      // name, so every row in it is dropped: an empty group beside a full one
      // that stops halfway down their file.
      //
      // Only here. A plan coming back from the review screen goes through
      // `normalizePlan` as before, because a person who split a table there
      // decided to split it.
      const repaired = repairPlan(plan, [grid], hints);
      tables = repaired.plan.tables;
      repairs = repaired.repairs;
      previews = buildPreviews([grid], repaired.plan);
    }

    // Replacing this tab's tables rather than appending them keeps a re-read of
    // the same tab from doubling it — which a retry after a dropped connection
    // would otherwise do, silently, and only to that one tab.
    const heldPlan = (existing.plan ?? { tables: [], summary: "" }) as unknown as ImportPlan;
    const mergedTables = [...(heldPlan.tables ?? []).filter((table) => table.sheet !== sheet), ...tables];
    const mergedPlan: ImportPlan = { ...heldPlan, tables: mergedTables };

    const after = progressOf({ sheetNames: existing.sheetNames, plan: mergedPlan });
    const readers = [...new Set([...(existing.analyzedBy ?? "").split(", ").filter(Boolean), analyzedBy])];

    const saved = await prisma.leadImport.update({
      where: { id: existing.id },
      data: {
        status: after.finished ? (mergedTables.length ? "READY" : "FAILED") : "ANALYZING",
        plan: mergedPlan as unknown as Prisma.InputJsonValue,
        analyzedBy: readers.join(", ").slice(0, 200),
        tablesFound: mergedTables.length,
        error: after.finished && !mergedTables.length ? "No lead tables were found in this file." : null,
      },
    });

    return res.json({
      import: saved,
      sheet,
      tables,
      previews,
      repairs,
      analyzedBy,
      warnings,
      progress: after,
    });
  } catch (err) {
    if (record) {
      await prisma.leadImport
        .update({ where: { id: record.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 500) } })
        .catch(() => undefined);
    }
    if (err instanceof SpreadsheetError) return res.status(err.status).json({ error: err.message });
    if (err instanceof GoogleError) return res.status(err.status).json({ error: err.message });
    if (err instanceof AnalystError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// --- Plans -----------------------------------------------------------------

const planInput = z.object({
  plan: z.object({
    tables: z.array(z.any()),
    summary: z.string().optional(),
    /** One lead list per worksheet, or one per detected table. Absent means per worksheet. */
    grouping: z.enum(["sheet", "table"]).optional(),
  }),
  /** Re-sent when the server no longer holds the parsed file. */
  dataBase64: z.string().optional(),
  fileName: z.string().optional(),
});

/**
 * The file behind an import: from the cache, from Drive, or from the copy the
 * browser still holds. One tab is read at a time out of whichever it is.
 */
async function grabSource(importId: string, fallback: { dataBase64?: string; fileName?: string }): Promise<GridSource> {
  const record = await prisma.leadImport.findUnique({ where: { id: importId } });
  if (!record) throw new SpreadsheetError("That import no longer exists. Start again.");
  return sourceFor(record, { ...fallback, source: "UPLOAD", useAi: false });
}

// POST /api/imports/:id/preview — re-run an edited plan without writing anything.
importsRouter.post("/:id/preview", async (req, res, next) => {
  try {
    const input = planInput.parse(req.body);
    const source = await grabSource(req.params.id, input);
    let normalized: ImportPlan;
    let previews: TablePreview[];
    try {
      normalized = await normalizePlanFrom(source, input.plan as ImportPlan);
      previews = await buildPreviewsFrom(source, normalized);
    } finally {
      source.release();
    }

    await prisma.leadImport.update({
      where: { id: req.params.id },
      data: { plan: normalized as unknown as Prisma.InputJsonValue, tablesFound: normalized.tables.length },
    });

    res.json({ plan: normalized, previews });
  } catch (err) {
    if (err instanceof SpreadsheetError) return res.status(err.status).json({ error: err.message });
    if (err instanceof GoogleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/imports/:id/commit — writes the approved plan into the pipeline.
importsRouter.post("/:id/commit", async (req, res, next) => {
  try {
    const input = planInput.parse(req.body);
    const record = await prisma.leadImport.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ error: "Import not found" });

    let checkpoint = null;
    if (record.status === "IMPORTING" && record.commitState) {
      checkpoint = record.commitState as unknown as Awaited<ReturnType<typeof import("../services/leadImport.js")["loadCheckpoint"]>>;
    }

    if (record.status === "IMPORTED") {
      return res.status(409).json({ error: "This import has already been run. Start a new one to import the file again." });
    }

    const source = await grabSource(req.params.id, input);
    const normalized = await normalizePlanFrom(source, input.plan as ImportPlan);
    if (!normalized.tables.some((table) => table.include !== false)) {
      source.release();
      return res.status(400).json({ error: "No tables are ticked for import." });
    }

    const { commitPlan } = await import("../services/leadImport.js");
    let result: Awaited<ReturnType<typeof commitPlan>>;
    try {
      result = await commitPlan(record.id, source, normalized, checkpoint ?? undefined);
    } finally {
      source.release();
    }
    const importedAt = result.status === "IMPORTED" ? new Date() : null;
    const saved = await prisma.leadImport.update({
      where: { id: record.id },
      data: {
        status: result.status,
        plan: normalized as unknown as Prisma.InputJsonValue,
        groupsCreated: result.groupsCreated,
        leadsCreated: result.leadsCreated,
        leadsUpdated: result.leadsUpdated,
        rowsSkipped: result.rowsSkipped,
        importedAt: importedAt ?? undefined,
        commitState: result.status === "IMPORTED" ? Prisma.JsonNull : undefined,
        error: result.status === "IMPORTING" ? null : undefined,
      },
      include: { groups: { include: { _count: { select: { leads: true } } } } },
    });

    res.json({ import: saved, result });
  } catch (err) {
    if (err instanceof SpreadsheetError) return res.status(err.status).json({ error: err.message });
    if (err instanceof GoogleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// --- History ---------------------------------------------------------------

importsRouter.get("/", async (_req, res, next) => {
  try {
    const imports = await prisma.leadImport.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { groups: { select: { id: true, name: true, _count: { select: { leads: true } } } } },
    });
    res.json(imports);
  } catch (err) {
    next(err);
  }
});

importsRouter.get("/:id", async (req, res, next) => {
  try {
    const record = await prisma.leadImport.findUnique({
      where: { id: req.params.id },
      include: { groups: { select: { id: true, name: true, _count: { select: { leads: true } } } } },
    });
    if (!record) return res.status(404).json({ error: "Import not found" });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

// Deleting the record keeps the leads — they belong to the pipeline now.
importsRouter.delete("/:id", async (req, res, next) => {
  try {
    fileCache.delete(req.params.id);
    await prisma.leadGroup.updateMany({ where: { leadImportId: req.params.id }, data: { leadImportId: null } });
    await prisma.leadImport.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
