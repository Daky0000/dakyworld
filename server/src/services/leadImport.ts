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

import type { Prisma } from "@prisma/client";
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
  groupsCreated: number;
  leadsCreated: number;
  leadsUpdated: number;
  rowsSkipped: number;
  groups: { id: string; name: string; leads: number }[];
}

const CHUNK = 200;

/**
 * Writes an approved plan. Each table gets a group, that group's columns, and
 * its rows; rows whose identity already exists are refreshed rather than
 * duplicated, and only where the sheet actually has a value — an import must
 * never blank out a field somebody filled in by hand.
 */
export async function commitPlan(importId: string, grids: SheetGrid[], plan: ImportPlan): Promise<CommitResult> {
  const byName = new Map(grids.map((grid) => [grid.name, grid]));
  const result: CommitResult = { groupsCreated: 0, leadsCreated: 0, leadsUpdated: 0, rowsSkipped: 0, groups: [] };
  // createMany can't return ids, so the leads this import actually created are
  // found afterwards by the groups it wrote into and the moment it started.
  const startedAt = new Date();

  for (const table of plan.tables) {
    if (table.include === false) continue;
    const grid = byName.get(table.sheet) ?? (grids.length === 1 ? grids[0] : undefined);
    if (!grid) continue;

    const { rows, skipped } = extractRows(grid, table);
    result.rowsSkipped += skipped;
    if (!rows.length) continue;

    const group = await prisma.leadGroup.create({
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

    const fields = fieldsForTable(table).map((field) => ({ ...field, groupId: group.id }));
    if (fields.length) await prisma.leadField.createMany({ data: fields });

    // Two rows in the same sheet can share an identity; keep the first.
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

    const keys = prepared.map((row) => row.dedupeKey).filter((key): key is string => Boolean(key));
    const existing = keys.length
      ? await prisma.lead.findMany({
          where: { dedupeKey: { in: keys } },
          select: { id: true, dedupeKey: true, customFields: true, groupId: true },
        })
      : [];
    const existingByKey = new Map(existing.map((lead) => [lead.dedupeKey as string, lead]));

    const toCreate: Prisma.LeadCreateManyInput[] = [];

    for (const row of prepared) {
      const scalars = row.lead as Prisma.LeadUncheckedCreateInput & Record<string, unknown>;
      const base = {
        ...scalars,
        contactName: String(row.lead.contactName),
        source: (row.lead.source as Prisma.LeadCreateManyInput["source"]) ?? (table.leadSource as Prisma.LeadCreateManyInput["source"]),
        status: (row.lead.status as Prisma.LeadCreateManyInput["status"]) ?? (table.status as Prisma.LeadCreateManyInput["status"]),
        leadScore: typeof row.lead.leadScore === "number" ? row.lead.leadScore : scoreRow(row.lead),
        groupId: group.id,
        dedupeKey: row.dedupeKey,
        customFields: Object.keys(row.custom).length ? (row.custom as Prisma.InputJsonValue) : undefined,
        enrichment: { importId, sheet: table.sheet, row: row.rowIndex + 1, raw: row.raw } as Prisma.InputJsonValue,
      } satisfies Prisma.LeadCreateManyInput;

      const match = row.dedupeKey ? existingByKey.get(row.dedupeKey) : undefined;
      if (!match) {
        toCreate.push(base);
        continue;
      }

      // Refresh, don't overwrite: only fields the sheet actually filled in,
      // and custom values merged on top of whatever the lead already carried.
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

      await prisma.lead.update({ where: { id: match.id }, data: update });
      result.leadsUpdated += 1;
    }

    for (let offset = 0; offset < toCreate.length; offset += CHUNK) {
      const batch = toCreate.slice(offset, offset + CHUNK);
      // skipDuplicates covers a dedupeKey another import created in between.
      const created = await prisma.lead.createMany({ data: batch, skipDuplicates: true });
      result.leadsCreated += created.count;
    }

    result.groups.push({ id: group.id, name: group.name, leads: prepared.length });
  }

  // Anything new goes to whichever email sequences are watching for it.
  if (result.leadsCreated > 0) {
    const created = await prisma.lead.findMany({
      where: { groupId: { in: result.groups.map((group) => group.id) }, createdAt: { gte: startedAt } },
      select: { id: true },
    });
    await enrolNewLeads(created.map((lead) => lead.id));
  }

  return result;
}
