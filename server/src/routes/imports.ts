import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { AnalystError, ANALYST_MODEL, analystConfigured, analyzeGrids, verifyKey } from "../lib/anthropic.js";
import {
  GoogleError,
  buildAuthUrl,
  exchangeCode,
  clearGoogleTokenCache,
  googleConfigured,
  googleConnected,
  getDriveFile,
  listSpreadsheets,
  listTabs,
  readGrids,
  redirectUri,
} from "../lib/google.js";
import { SETTING, deleteSetting, getSetting, isEnvManaged, setSetting } from "../lib/settings.js";
import { maskSecret } from "../lib/secrets.js";
import { detectTables, normalizePlan, type ImportPlan } from "../services/sheetPlan.js";
import { SpreadsheetError, isSpreadsheetName, listWorkbookSheets, parseWorkbook, type SheetGrid } from "../services/spreadsheet.js";
import { buildPreviews, commitPlan } from "../services/leadImport.js";

export const importsRouter = Router();

// Imports create groups, spend Anthropic credits and reach into a Google
// account — Owner-only, like the other integration surfaces.
importsRouter.use(requireRole("OWNER"));

// An uploaded workbook rides in the JSON body as base64, so these routes parse
// bodies far larger than the rest of the API allows. Deliberately after the
// role check: nobody unauthenticated gets to hand us 28 MB to parse.
importsRouter.use(express.json({ limit: "28mb" }));

/**
 * Parsed sheets, kept between "analyse" and "commit" so a 3,000-row workbook
 * isn't re-read on every edit of the plan. Losing the cache is harmless: the
 * commit route re-reads from Drive, or from the file the client still holds.
 */
const gridCache = new Map<string, { grids: SheetGrid[]; at: number }>();
const GRID_CACHE_TTL_MS = 60 * 60_000;
const GRID_CACHE_MAX = 8;

function cacheGrids(importId: string, grids: SheetGrid[]) {
  gridCache.set(importId, { grids, at: Date.now() });
  for (const [key, entry] of gridCache) {
    if (Date.now() - entry.at > GRID_CACHE_TTL_MS) gridCache.delete(key);
  }
  while (gridCache.size > GRID_CACHE_MAX) {
    const oldest = [...gridCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    gridCache.delete(oldest[0]);
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

// --- Connection status -----------------------------------------------------

function origin(req: { protocol: string; get: (name: string) => string | undefined }): string {
  return process.env.APP_URL?.trim() || `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

async function describeConnections(req: Parameters<typeof origin>[0]) {
  const [key, clientId, account] = await Promise.all([
    getSetting(SETTING.ANTHROPIC_KEY),
    getSetting(SETTING.GOOGLE_CLIENT_ID),
    getSetting(SETTING.GOOGLE_ACCOUNT),
  ]);

  return {
    analyst: {
      configured: Boolean(key),
      envManaged: isEnvManaged(SETTING.ANTHROPIC_KEY),
      key: key ? maskSecret(key) : null,
      model: ANALYST_MODEL,
    },
    google: {
      configured: await googleConfigured(),
      connected: await googleConnected(),
      envManaged: isEnvManaged(SETTING.GOOGLE_CLIENT_ID),
      clientId: clientId ? `${clientId.slice(0, 14)}…` : null,
      account,
      /** Paste this into the OAuth client's "Authorised redirect URIs". */
      redirectUri: redirectUri(origin(req)),
    },
  };
}

importsRouter.get("/connections", async (req, res, next) => {
  try {
    res.json(await describeConnections(req));
  } catch (err) {
    next(err);
  }
});

// PUT /api/imports/connections/anthropic — verified against the API before it's stored.
importsRouter.put("/connections/anthropic", async (req, res, next) => {
  try {
    const { key } = z.object({ key: z.string().min(10, "That doesn't look like an Anthropic API key") }).parse(req.body);
    await verifyKey(key.trim());
    await setSetting(SETTING.ANTHROPIC_KEY, key.trim(), { secret: true });
    res.json(await describeConnections(req));
  } catch (err) {
    if (err instanceof AnalystError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

importsRouter.delete("/connections/anthropic", async (req, res, next) => {
  try {
    await deleteSetting(SETTING.ANTHROPIC_KEY);
    res.json(await describeConnections(req));
  } catch (err) {
    next(err);
  }
});

// PUT /api/imports/connections/google — the OAuth client, not the account.
// Connecting the account itself is the redirect dance below.
importsRouter.put("/connections/google", async (req, res, next) => {
  try {
    const { clientId, clientSecret } = z
      .object({
        clientId: z.string().min(10, "That doesn't look like a Google client ID"),
        clientSecret: z.string().min(10, "That doesn't look like a Google client secret"),
      })
      .parse(req.body);

    await setSetting(SETTING.GOOGLE_CLIENT_ID, clientId.trim());
    await setSetting(SETTING.GOOGLE_CLIENT_SECRET, clientSecret.trim(), { secret: true });
    clearGoogleTokenCache();
    res.json(await describeConnections(req));
  } catch (err) {
    next(err);
  }
});

// --- Google OAuth ----------------------------------------------------------

/** Outstanding consent redirects, so a callback can't be forged or replayed. */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60_000;

importsRouter.get("/google/auth-url", async (req, res, next) => {
  try {
    const state = randomUUID();
    pendingStates.set(state, Date.now());
    for (const [key, at] of pendingStates) {
      if (Date.now() - at > STATE_TTL_MS) pendingStates.delete(key);
    }
    res.json({ url: await buildAuthUrl(origin(req), state) });
  } catch (err) {
    if (err instanceof GoogleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * Where Google sends the browser back. It's a page navigation, not an API
 * call, so it answers with a redirect into the import screen either way and
 * carries the outcome in the query string.
 */
importsRouter.get("/google/callback", async (req, res) => {
  const back = (params: Record<string, string>) => {
    const url = new URL("/leads/import", origin(req));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    res.redirect(url.toString());
  };

  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";

  if (typeof req.query.error === "string") return back({ google: "error", message: req.query.error });
  if (!state || !pendingStates.has(state)) return back({ google: "error", message: "That sign-in link had expired. Try again." });
  pendingStates.delete(state);
  if (!code) return back({ google: "error", message: "Google didn't return an authorisation code." });

  try {
    const { email } = await exchangeCode(code, origin(req));
    back({ google: "connected", ...(email ? { account: email } : {}) });
  } catch (err) {
    back({ google: "error", message: err instanceof GoogleError ? err.message : "Could not complete the Google sign-in." });
  }
});

importsRouter.post("/google/disconnect", async (req, res, next) => {
  try {
    await deleteSetting(SETTING.GOOGLE_REFRESH_TOKEN);
    await deleteSetting(SETTING.GOOGLE_ACCOUNT);
    clearGoogleTokenCache();
    res.json(await describeConnections(req));
  } catch (err) {
    next(err);
  }
});

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
    if (record.status === "IMPORTED") {
      return res.status(409).json({ error: "This import has already been run. Start a new one to import the file again." });
    }

    const grids = await grabGrids(req.params.id, input);
    const normalized = normalizePlan(input.plan as ImportPlan, grids);
    if (!normalized.tables.some((table) => table.include !== false)) {
      return res.status(400).json({ error: "No tables are ticked for import." });
    }

    const result = await commitPlan(record.id, grids, normalized);
    const saved = await prisma.leadImport.update({
      where: { id: record.id },
      data: {
        status: "IMPORTED",
        plan: normalized as unknown as Prisma.InputJsonValue,
        groupsCreated: result.groupsCreated,
        leadsCreated: result.leadsCreated,
        leadsUpdated: result.leadsUpdated,
        rowsSkipped: result.rowsSkipped,
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
