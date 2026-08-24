/**
 * Running an import plan.
 *
 * Analysis produces a plan (services/sheetPlan.ts); this is what turns an
 * approved plan into rows in the database. Every table in the plan becomes its
 * own lead group with its own column set, so a workbook holding a table of
 * people and a table of organisations lands as two groups that look nothing
 * alike — which is the point, because forcing them into one shape is exactly
 * what loses the data.
 */

import type { LeadCaptureMethod, LeadGroup, Prisma } from "@prisma/client";
import { enrolNewLeads } from "./emailSequences.js";
import { prisma } from "../lib/prisma.js";
import { builtinField, isBuiltinKey } from "./leadFields.js";
import { extractRows, type ImportPlan, type PlanTable } from "./sheetPlan.js";
import type { SheetGrid } from "./spreadsheet.js";

// --- Preview ---------------------------------------------------------------

export interface TablePreview {
  tableId: string;
  /** The columns this table will create, in order. */
  columns: { key: string; label: string; field: string; type: string; builtin: boolean }[];
  /** First few mapped rows, as `{ column label -> displayed value }`. */
  sample: Record<string, string>[];
  rowCount: number;
  skipped: number;
  /** Rows with something to contact them by — the number that actually matters. */
  reachable: number;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** What the review screen shows: the columns, and the first rows through them. */
export function buildPreviews(grids: SheetGrid[], plan: ImportPlan, sampleSize = 6): TablePreview[] {
  const byName = new Map(grids.map((grid) => [grid.name, grid]));

  return plan.tables.map((table) => {
    const grid = byName.get(table.sheet) ?? grids[0];
    const { rows, skipped } = grid ? extractRows(grid, table) : { rows: [], skipped: 0 };

    const columns = table.columns
      .filter((column) => column.field !== "ignore")
      .map((column) => ({
        key: column.field === "custom" ? (column.key ?? column.label) : column.field,
        label: column.label,
        field: column.field,
        type: column.type,
        builtin: column.field !== "custom",
      }));

    const sample = rows.slice(0, sampleSize).map((row) => {
      const cells: Record<string, string> = {};
      for (const column of table.columns) {
        if (column.field === "ignore") continue;
        const value = column.field === "custom" ? row.custom[column.key ?? column.label] : row.lead[column.field];
        cells[column.label] = displayValue(value);
      }
      return cells;
    });

    return {
      tableId: table.id,
      columns,
      sample,
      rowCount: rows.length,
      skipped,
      reachable: rows.filter((row) => row.lead.contactEmail || row.lead.contactPhone).length,
    };
  });
}

// --- Scoring and de-duplication -------------------------------------------

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\da-z]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The same reachability-weighted idea the scrapers use: a lead you can't
 * contact isn't worth a pipeline slot, however impressive the row looks.
 */
function scoreRow(lead: Record<string, unknown>): number {
  let score = 20;
  if (lead.contactEmail) score += 25;
  if (lead.contactPhone) score += 15;
  if (lead.website) score += 15;
  if (lead.address || lead.city) score += 3;
  if (lead.companyName) score += 5;
  if (lead.category) score += 2;
  return Math.max(0, Math.min(100, score));
}

/**
 * A stable identity, in falling order of trust, so re-importing an updated
 * sheet refreshes the same leads instead of doubling the pipeline.
 */
function dedupeKeyFor(lead: Record<string, unknown>): string | null {
  const email = typeof lead.contactEmail === "string" ? lead.contactEmail : null;
  if (email) return `email:${email}`;

  const website = typeof lead.website === "string" ? lead.website : null;
  if (website) {
    try {
      return `domain:${new URL(website).hostname.replace(/^www\./i, "").toLowerCase()}`;
    } catch {
      /* fall through to the phone and name keys */
    }
  }

  const digits = typeof lead.contactPhone === "string" ? lead.contactPhone.replace(/\D/g, "") : "";
  if (digits.length >= 9) return `phone:${digits.slice(-9)}`;

  const name = slug(String(lead.contactName ?? ""));
  if (!name) return null;
  const city = lead.city ? `:${slug(String(lead.city))}` : "";
  return `name:${name}${city}`;
}

// --- Groups and columns ----------------------------------------------------

/** Slugs are unique across all groups, so a repeat import gets " 2", " 3", … */
async function uniqueSlug(base: string): Promise<string> {
  const root = slug(base).slice(0, 70) || "imported-leads";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const clash = await prisma.leadGroup.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!clash) return candidate;
  }
  return `${root}-${Date.now()}`;
}

/**
 * The column set for an imported group: the sheet's own columns in the sheet's
 * own order, plus the few built-ins the pipeline needs to work at all (status
 * to move a lead along, score to sort by, added-date for context).
 */
function fieldsForTable(table: PlanTable): Prisma.LeadFieldCreateManyInput[] {
  const rows: Prisma.LeadFieldCreateManyInput[] = [];
  const used = new Set<string>();

  for (const column of table.columns) {
    if (column.field === "ignore") continue;
    const key = column.field === "custom" ? (column.key ?? column.label) : column.field;
    if (!key || used.has(key)) continue;
    used.add(key);
    rows.push({
      groupId: undefined,
      key,
      label: column.label,
      type: column.type,
      builtin: isBuiltinKey(key),
      hidden: false,
      position: rows.length,
      meta: column.header ? ({ sourceHeader: column.header, sourceColumn: column.index } as Prisma.InputJsonValue) : undefined,
    });
  }

  for (const key of ["status", "leadScore", "createdAt"]) {
    if (used.has(key)) continue;
    const field = builtinField(key);
    if (!field) continue;
    rows.push({
      groupId: undefined,
      key,
      label: field.label,
      type: field.type,
      builtin: true,
      hidden: false,
      position: rows.length,
    });
  }

  return rows;
}

// --- Commit ----------------------------------------------------------------

export interface CommitResult {
  status: "IMPORTING" | "IMPORTED";
  groupsCreated: number;
  leadsCreated: number;
  leadsUpdated: number;
  rowsSkipped: number;
  groups: { id: string; name: string; leads: number }[];
}

export interface ImportCheckpoint {
  tableIndex: number;
  chunkIndex: number;
  currentGroupId: string | null;
  result: {
    groupsCreated: number;
    leadsCreated: number;
    leadsUpdated: number;
    rowsSkipped: number;
    groups: { id: string; name: string; leads: number }[];
  };
  startedAt: string;
}

const CHUNK = 200;

export async function loadCheckpoint(importId: string): Promise<ImportCheckpoint | null> {
  const record = await prisma.leadImport.findUnique({
    where: { id: importId },
    select: { commitState: true, status: true },
  });
  if (!record?.commitState || record.status !== "IMPORTING") return null;
  return record.commitState as unknown as ImportCheckpoint;
}

async function saveCheckpoint(importId: string, checkpoint: ImportCheckpoint) {
  await prisma.leadImport.update({
    where: { id: importId },
    data: {
      status: "IMPORTING",
      commitState: checkpoint as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * The tag these rows will carry on the Leads page. A native Google Sheet is
 * its own route in; everything else is named after the file, because "Excel"
 * and "CSV" are what the Owner recognises — an `.xlsx` fetched from Drive is
 * still an Excel file, and where it was stored isn't the interesting part.
 */
async function captureMethodFor(importId: string): Promise<LeadCaptureMethod> {
  const record = await prisma.leadImport.findUnique({
    where: { id: importId },
    select: { source: true, fileName: true },
  });
  if (!record) return "OTHER";
  if (record.source === "GOOGLE_SHEET") return "GOOGLE_SHEET";
  return /\.(csv|tsv)$/i.test(record.fileName ?? "") ? "CSV" : "EXCEL";
}

/**
 * Writes an approved plan. Each table gets a group, that group's columns, and
 * its rows; rows whose identity already exists are refreshed rather than
 * duplicated, and only where the sheet actually has a value — an import must
 * never blank out a field somebody filled in by hand.
 *
 * Long worksheets are processed in checkpoints so a timeout or error can be
 * resumed from where it stopped rather than re-doing everything.
 */
export async function commitPlan(importId: string, grids: SheetGrid[], plan: ImportPlan, existingCheckpoint?: ImportCheckpoint): Promise<CommitResult> {
  const byName = new Map(grids.map((grid) => [grid.name, grid]));
  const result: CommitResult = {
    status: "IMPORTING",
    groupsCreated: existingCheckpoint?.result.groupsCreated ?? 0,
    leadsCreated: existingCheckpoint?.result.leadsCreated ?? 0,
    leadsUpdated: existingCheckpoint?.result.leadsUpdated ?? 0,
    rowsSkipped: existingCheckpoint?.result.rowsSkipped ?? 0,
    groups: existingCheckpoint?.result.groups ?? [],
  };
  const startedAt = new Date(existingCheckpoint?.startedAt ?? Date.now());
  const captureMethod = await captureMethodFor(importId);

  const tables = plan.tables.filter((table) => table.include !== false);
  const startTableIndex = existingCheckpoint?.tableIndex ?? 0;

  for (let t = startTableIndex; t < tables.length; t++) {
    const table = tables[t];
    if (table.include === false) continue;
    const grid = byName.get(table.sheet) ?? (grids.length === 1 ? grids[0] : undefined);
    if (!grid) continue;

    const { rows, skipped } = extractRows(grid, table);
    result.rowsSkipped += skipped;
    if (!rows.length) {
      await saveCheckpoint(importId, {
        tableIndex: t + 1,
        chunkIndex: 0,
        currentGroupId: null,
        result: { ...result, groups: [...result.groups] },
        startedAt: startedAt.toISOString(),
      });
      continue;
    }

    let group: LeadGroup;
    const existingGroupId = existingCheckpoint?.currentGroupId;
    if (existingGroupId) {
      group = await prisma.leadGroup.findUnique({ where: { id: existingGroupId } }) ?? (() => { throw new Error(`Group ${existingGroupId} missing`); })();
    } else {
      try {
        group = await prisma.leadGroup.create({
          data: {
            name: table.title.slice(0, 80),
            slug: await uniqueSlug(table.title),
            description: table.notes?.slice(0, 300) || null,
            autoCreated: true,
            sourceLabel: `${table.sheet}!${table.firstDataRow + 1}-${table.lastDataRow + 1}`,
            leadImportId: importId,
          },
        });
        result.groupsCreated += 1;
      } catch (err) {
        if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2002") {
          group = await prisma.leadGroup.findFirst({ where: { leadImportId: importId, name: table.title.slice(0, 80) } }) ??
                  await prisma.leadGroup.findFirst({ where: { slug: await uniqueSlug(table.title) } }) ??
                  (() => { throw err; })();
        } else {
          throw err;
        }
      }
    }

    const wasTableProcessed = (existingCheckpoint?.tableIndex ?? 0) > t ||
      (existingCheckpoint?.tableIndex === t && (existingCheckpoint?.chunkIndex ?? 0) > 0);
    if (!wasTableProcessed) {
      const fields = fieldsForTable(table).map((field) => ({ ...field, groupId: group.id }));
      if (fields.length) await prisma.leadField.createMany({ data: fields });
    }

    const seen = new Set<string>();
    const prepared = rows
      .map((row) => ({ ...row, dedupeKey: dedupeKeyFor(row.lead) }))
      .filter((row) => {
        if (!row.dedupeKey) return true;
        if (seen.has(row.dedupeKey)) {
          result.rowsSkipped += 1;
          return false;
        }
        seen.add(row.dedupeKey);
        return true;
      });

    const startChunk = (existingCheckpoint?.tableIndex === t) ? (existingCheckpoint?.chunkIndex ?? 0) : 0;

    for (let offset = startChunk; offset < prepared.length; offset += CHUNK) {
      const batch = prepared.slice(offset, offset + CHUNK);
      const keys = batch.map((row) => row.dedupeKey).filter((key): key is string => Boolean(key));

    const existing: { id: string; dedupeKey: string; customFields: unknown; groupId: string | null }[] = [];
    for (let k = 0; k < keys.length; k += CHUNK) {
      const keyBatch = keys.slice(k, k + CHUNK);
      const found = await prisma.lead.findMany({
        where: { dedupeKey: { in: keyBatch } },
        select: { id: true, dedupeKey: true, customFields: true, groupId: true },
      });
      existing.push(...(found as typeof existing));
    }
    const existingByKey = new Map(existing.map((lead) => [lead.dedupeKey as string, lead]));

      const toCreate: Prisma.LeadCreateManyInput[] = [];
      const toUpdate: { where: { id: string }; data: Prisma.LeadUncheckedUpdateInput }[] = [];

      for (const row of batch) {
        const scalars = row.lead as Prisma.LeadUncheckedCreateInput & Record<string, unknown>;
        const base = {
          ...scalars,
          contactName: String(row.lead.contactName),
          source: (row.lead.source as Prisma.LeadCreateManyInput["source"]) ?? (table.leadSource as Prisma.LeadCreateManyInput["source"]),
          status: (row.lead.status as Prisma.LeadCreateManyInput["status"]) ?? (table.status as Prisma.LeadCreateManyInput["status"]),
          leadScore: typeof row.lead.leadScore === "number" ? row.lead.leadScore : scoreRow(row.lead),
          captureMethod,
          groupId: group.id,
          dedupeKey: row.dedupeKey,
          customFields: Object.keys(row.custom).length ? (row.custom as Prisma.InputJsonValue) : undefined,
          enrichment: { importId, sheet: table.sheet, row: row.rowIndex + 1, raw: row.raw } as Prisma.InputJsonValue,
        };

        const match = row.dedupeKey ? existingByKey.get(row.dedupeKey) : undefined;
        if (!match) {
          toCreate.push(base);
          continue;
        }

        const update: Prisma.LeadUncheckedUpdateInput = {};
        for (const [key, value] of Object.entries(scalars)) {
          if (value === null || value === undefined || value === "") continue;
          if (key === "contactName" && !value) continue;
          (update as Record<string, unknown>)[key] = value;
        }
        if (Object.keys(row.custom).length) {
          const previous = (match.customFields as Record<string, unknown> | null) ?? {};
          update.customFields = { ...previous, ...row.custom } as Prisma.InputJsonValue;
        }
        if (!match.groupId) update.groupId = group.id;

        toUpdate.push({ where: { id: match.id }, data: update });
        result.leadsUpdated += 1;
      }

      for (let c = 0; c < toCreate.length; c += CHUNK) {
        const createBatch = toCreate.slice(c, c + CHUNK);
        const created = await prisma.lead.createMany({ data: createBatch, skipDuplicates: true });
        result.leadsCreated += created.count;
      }

      for (let u = 0; u < toUpdate.length; u += 50) {
        const updateBatch = toUpdate.slice(u, u + 50);
        await Promise.all(updateBatch.map((op) => prisma.lead.update(op)));
      }

      await saveCheckpoint(importId, {
        tableIndex: t,
        chunkIndex: offset + CHUNK,
        currentGroupId: group.id,
        result: { ...result, groups: [...result.groups] },
        startedAt: startedAt.toISOString(),
      });
    }

    result.groups.push({ id: group.id, name: group.name, leads: prepared.length });

    await saveCheckpoint(importId, {
      tableIndex: t + 1,
      chunkIndex: 0,
      currentGroupId: null,
      result: { ...result, groups: [...result.groups] },
      startedAt: startedAt.toISOString(),
    });
  }

  if (result.leadsCreated > 0) {
    const allGroupIds = result.groups.map((group) => group.id);
    const created = await prisma.lead.findMany({
      where: { groupId: { in: allGroupIds }, createdAt: { gte: startedAt } },
      select: { id: true },
    });
    await enrolNewLeads(created.map((lead) => lead.id));
  }

  result.status = "IMPORTED";
  return result;
}
