import express, { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { attachUser } from "../middleware/auth.js";
import { AnalystError, analystConfigured, analyzeGrids } from "../lib/anthropic.js";
import { GoogleError, getDriveFile, listSpreadsheets, listTabs, readGrids } from "../lib/google.js";
import { gateBy } from "../middleware/permissionGate.js";
import { handleGoogleCallback } from "./settings.js";
import { detectTables, normalizePlan, type ImportPlan } from "../services/sheetPlan.js";
import {
  MAX_ROWS_PER_SHEET,
  SpreadsheetError,
  isSpreadsheetName,
  listWorkbookSheets,
  parseWorkbook,
  type SheetGrid,
} from "../services/spreadsheet.js";
import { buildPreviews, commitPlan, loadCheckpoint } from "../services/leadImport.js";

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
 * Parsed sheets, kept between "analyse" and "commit" so a 3,000-row workbook
 * isn't re-read on every edit of the plan. Losing the cache is harmless: the
 * commit route re-reads from Drive, or from the file the client still holds.
 */
const gridCache = new Map<string, { grids: SheetGrid[]; at: number; cells: number }>();
const GRID_CACHE_TTL_MS = 60 * 60_000;

/**
 * What the cache may hold, counted in cells rather than in files.
 *
 * Eight entries is a number only until somebody imports eight large workbooks:
 * a full 5,000 × 60 grid is around 40 MB of strings, so the old ceiling was
 * "keep a third of a gigabyte for an hour" written as an 8. Counting cells
 * means one big file evicts as much as it costs and a dozen small ones still
 * all fit.
 */
const GRID_CACHE_MAX_CELLS = 1_200_000;

function countCells(grids: SheetGrid[]): number {
  return grids.reduce((total, grid) => total + grid.rows.length * (grid.rows[0]?.length ?? 0), 0);
}

function cacheGrids(importId: string, grids: SheetGrid[]) {
  gridCache.set(importId, { grids, at: Date.now(), cells: countCells(grids) });
  for (const [key, entry] of gridCache) {
    if (Date.now() - entry.at > GRID_CACHE_TTL_MS) gridCache.delete(key);
  }

  // Oldest first, and never the one just cached — the next request is for it.
  let held = [...gridCache.values()].reduce((total, entry) => total + entry.cells, 0);
  const byAge = [...gridCache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key, entry] of byAge) {
    if (held <= GRID_CACHE_MAX_CELLS || key === importId) continue;
    gridCache.delete(key);
    held -= entry.cells;
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

const analyzeInput = z.object({
  source: z.enum(["UPLOAD", "GOOGLE_SHEET", "GOOGLE_DRIVE_FILE"]).default("UPLOAD"),
  fileName: z.string().optional(),
  dataBase64: z.string().optional(),
  driveFileId: z.string().optional(),
  sheetNames: z.array(z.string()).optional(),
  /** False maps the sheet with the pattern rules only — no Anthropic call. */
  useAi: z.boolean().default(true),
});

async function loadGrids(input: z.infer<typeof analyzeInput>): Promise<{ grids: SheetGrid[]; fileName: string }> {
  if (input.driveFileId) {
    const { file, grids } = await readGrids(input.driveFileId, input.sheetNames);
    return { grids, fileName: file.name };
  }
  if (!input.dataBase64 || !input.fileName) {
    throw new SpreadsheetError("Send a file to import, or pick one from Google Drive.");
  }
  if (!isSpreadsheetName(input.fileName)) throw new SpreadsheetError("Upload an .xlsx, .csv or .tsv file.");
  const grids = await parseWorkbook(decodeUpload(input.dataBase64), input.fileName, input.sheetNames);
  return { grids, fileName: input.fileName };
}

/**
 * POST /api/imports/analyze — reads the file and returns a plan to review.
 *
 * Nothing is written to the pipeline here. The analyst's reading of the file,
 * a preview of the rows it would create, and the record of the attempt are all
 * that come back; the Owner approves it at /commit.
 */
importsRouter.post("/analyze", async (req, res, next) => {
  let record: { id: string } | null = null;
  try {
    const input = analyzeInput.parse(req.body);
    const { grids, fileName } = await loadGrids(input);
    if (!grids.length) return res.status(400).json({ error: "That file has no readable rows." });

    record = await prisma.leadImport.create({
      data: {
        source: input.driveFileId ? "GOOGLE_SHEET" : "UPLOAD",
        status: "ANALYZING",
        fileName,
        driveFileId: input.driveFileId ?? null,
        sheetNames: grids.map((grid) => grid.name),
      },
      select: { id: true },
    });
    cacheGrids(record.id, grids);

    const hints = detectTables(grids);
    let plan: ImportPlan = { tables: hints, summary: "" };
    let analyzedBy = "rules";
    let warning: string | null = null;

    if (input.useAi && (await analystConfigured())) {
      try {
        const analysis = await analyzeGrids(grids, hints);
        plan = analysis.plan;
        analyzedBy = analysis.model;
      } catch (err) {
        // A failed analyst call is a degraded import, not a failed one — the
        // pattern rules still produced something the Owner can correct.
        warning = err instanceof AnalystError ? err.message : "The AI analyst couldn't be reached; used pattern rules instead.";
      }
    } else if (input.useAi) {
      warning = "No Anthropic API key is set, so the sheet was mapped with pattern rules. Add a key for messier files.";
    }

    // A sheet longer than the cap used to be trimmed in silence: 20,000 rows
    // in, 5,000 imported, nothing said. Rows nobody was told about are rows
    // nobody goes looking for, so this is said first and said plainly.
    const trimmed = grids.filter((grid) => grid.truncated);
    if (trimmed.length) {
      const detail = trimmed
        .map((grid) => `"${grid.name}" (${grid.totalRows.toLocaleString()} rows, first ${MAX_ROWS_PER_SHEET.toLocaleString()} read)`)
        .join(", ");
      warning = [`Only part of this file was read — ${detail}. Split the rest into another file and import it after this one.`, warning]
        .filter(Boolean)
        .join(" ");
    }

    const normalized = normalizePlan(plan, grids);
    const saved = await prisma.leadImport.update({
      where: { id: record.id },
      data: {
        status: normalized.tables.length ? "READY" : "FAILED",
        plan: normalized as unknown as Prisma.InputJsonValue,
        analyzedBy,
        notes: normalized.summary || null,
        tablesFound: normalized.tables.length,
        error: normalized.tables.length ? null : "No lead tables were found in this file.",
      },
    });

    res.status(201).json({
      import: saved,
      plan: normalized,
      previews: buildPreviews(grids, normalized),
      sheets: grids.map((grid) => ({ name: grid.name, rows: grid.rows.length, columns: grid.rows[0]?.length ?? 0 })),
      warning,
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
  plan: z.object({ tables: z.array(z.any()), summary: z.string().optional() }),
  /** Re-sent when the server no longer holds the parsed file. */
  dataBase64: z.string().optional(),
  fileName: z.string().optional(),
});

/** The grids for an import: from cache, from Drive, or from the file the client still has. */
async function grabGrids(importId: string, fallback: { dataBase64?: string; fileName?: string }): Promise<SheetGrid[]> {
  const cached = gridCache.get(importId);
  if (cached) {
    cached.at = Date.now();
    return cached.grids;
  }

  const record = await prisma.leadImport.findUnique({ where: { id: importId } });
  if (!record) throw new SpreadsheetError("That import no longer exists. Start again.");

  if (record.driveFileId) {
    const { grids } = await readGrids(record.driveFileId, record.sheetNames);
    cacheGrids(importId, grids);
    return grids;
  }

  const name = fallback.fileName ?? record.fileName;
  if (!fallback.dataBase64 || !name) {
    throw new SpreadsheetError("The uploaded file is no longer in memory. Upload it again to finish the import.");
  }
  const grids = await parseWorkbook(decodeUpload(fallback.dataBase64), name, record.sheetNames);
  cacheGrids(importId, grids);
  return grids;
}

// POST /api/imports/:id/preview — re-run an edited plan without writing anything.
importsRouter.post("/:id/preview", async (req, res, next) => {
  try {
    const input = planInput.parse(req.body);
    const grids = await grabGrids(req.params.id, input);
    const normalized = normalizePlan(input.plan as ImportPlan, grids);

    await prisma.leadImport.update({
      where: { id: req.params.id },
      data: { plan: normalized as unknown as Prisma.InputJsonValue, tablesFound: normalized.tables.length },
    });

    res.json({ plan: normalized, previews: buildPreviews(grids, normalized) });
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

    const grids = await grabGrids(req.params.id, input);
    const normalized = normalizePlan(input.plan as ImportPlan, grids);
    if (!normalized.tables.some((table) => table.include !== false)) {
      return res.status(400).json({ error: "No tables are ticked for import." });
    }

    const { commitPlan } = await import("../services/leadImport.js");
    const result = await commitPlan(record.id, grids, normalized, checkpoint ?? undefined);
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
    gridCache.delete(req.params.id);
    await prisma.leadGroup.updateMany({ where: { leadImportId: req.params.id }, data: { leadImportId: null } });
    await prisma.leadImport.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
