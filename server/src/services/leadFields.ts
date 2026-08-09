/**
 * The shape of the leads table.
 *
 * A lead has two kinds of column. **Built-in** columns address a Lead scalar
 * directly (`contactName`, `city`, …) — they drive filtering, scoring and the
 * conversion to a Client, so they can't be invented. **Custom** columns live in
 * `Lead.customFields` under their own key, which is how a spreadsheet whose
 * columns are "Alternate Phone" and "Call outcome" keeps them instead of
 * dropping the ones the fixed schema has no home for.
 *
 * Which columns are shown, in what order, and under what label is a LeadField
 * row. With no rows, the defaults below apply; a lead group with its own rows
 * overrides the defaults completely, so two groups imported from one workbook
 * can look nothing like each other.
 */

import type { LeadField, LeadFieldType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const LEAD_FIELD_TYPES = [
  "TEXT",
  "LONG_TEXT",
  "NUMBER",
  "CURRENCY",
  "DATE",
  "BOOLEAN",
  "EMAIL",
  "PHONE",
  "URL",
  "SELECT",
] as const;

export const LEAD_SOURCES = [
  "REFERRAL",
  "LINKEDIN",
  "COLD_EMAIL",
  "OUTREACH",
  "CONTENT",
  "WARM_NETWORK",
  "GOOGLE_MAPS",
  "WEB_SCRAPE",
  "DIRECTORY",
  "SOCIAL",
  "OTHER",
] as const;

export const LEAD_STATUSES = ["NEW", "QUALIFYING", "QUALIFIED", "DISQUALIFIED", "CONVERTED", "LOST"] as const;

export interface BuiltinField {
  key: string;
  label: string;
  type: LeadFieldType;
  /** False for derived/system columns an import must never write to. */
  writable: boolean;
  /** In the default column set out of the box. */
  visible: boolean;
  /** What this column is for — sent to the analyst so it maps sheet headers sensibly. */
  hint: string;
}

/**
 * Every Lead scalar a column can point at, in the order the table shows them.
 * `hint` is written for the analyst model, not for the UI.
 */
export const BUILTIN_FIELDS: BuiltinField[] = [
  {
    key: "contactName",
    label: "Name",
    type: "TEXT",
    writable: true,
    visible: true,
    hint: "The person or business this lead is about. Required — a row with no usable name is skipped. For a sheet of companies rather than people, the company name goes here too.",
  },
  {
    key: "companyName",
    label: "Company",
    type: "TEXT",
    writable: true,
    visible: true,
    hint: "The organisation, when the sheet names a person and their employer separately.",
  },
  { key: "contactEmail", label: "Email", type: "EMAIL", writable: true, visible: true, hint: "Primary email address." },
  {
    key: "contactPhone",
    label: "Phone",
    type: "PHONE",
    writable: true,
    visible: true,
    hint: "Primary phone number. A second or alternate number belongs in a custom column, not here.",
  },
  { key: "website", label: "Website", type: "URL", writable: true, visible: false, hint: "Company website or profile URL." },
  { key: "address", label: "Address", type: "TEXT", writable: true, visible: false, hint: "Street address or full location line." },
  { key: "city", label: "City", type: "TEXT", writable: true, visible: true, hint: "City or town." },
  { key: "region", label: "Region", type: "TEXT", writable: true, visible: false, hint: "State, province or region." },
  { key: "country", label: "Country", type: "TEXT", writable: true, visible: false, hint: "Country." },
  {
    key: "category",
    label: "Category",
    type: "TEXT",
    writable: true,
    visible: false,
    hint: "Line of business or sector — 'Dental clinic', 'Law firm', 'Retail'.",
  },
  {
    key: "source",
    label: "Source",
    type: "SELECT",
    writable: true,
    visible: false,
    hint: `How the lead was found. Must be one of: ${LEAD_SOURCES.join(", ")}.`,
  },
  {
    key: "status",
    label: "Status",
    type: "SELECT",
    writable: true,
    visible: true,
    hint: `Pipeline stage. Must be one of: ${LEAD_STATUSES.join(", ")}.`,
  },
  { key: "leadScore", label: "Score", type: "NUMBER", writable: true, visible: true, hint: "Quality score, 0-100." },
  {
    key: "estimatedDealSize",
    label: "Deal size",
    type: "CURRENCY",
    writable: true,
    visible: false,
    hint: "Expected value of the deal, as a number.",
  },
  {
    key: "discoveryNotes",
    label: "Notes",
    type: "LONG_TEXT",
    writable: true,
    visible: false,
    hint: "Free-text notes about the lead. Use a custom column instead when the sheet's notes column has a specific meaning worth keeping separate.",
  },
  { key: "discoveryCallAt", label: "Discovery call", type: "DATE", writable: true, visible: false, hint: "Date of the discovery call." },
  { key: "rating", label: "Rating", type: "NUMBER", writable: true, visible: false, hint: "Star rating, 0-5." },
  { key: "reviewsCount", label: "Reviews", type: "NUMBER", writable: true, visible: false, hint: "Number of public reviews." },
  { key: "winLossReason", label: "Win / loss reason", type: "TEXT", writable: true, visible: false, hint: "Why the deal was won or lost." },
  {
    key: "tags",
    label: "Tags",
    type: "TEXT",
    writable: true,
    visible: false,
    hint: "Free labels. A comma- or semicolon-separated cell becomes several tags.",
  },
  { key: "createdAt", label: "Added", type: "DATE", writable: false, visible: true, hint: "When the lead was added. Set by the system." },
];

const BUILTIN_BY_KEY = new Map(BUILTIN_FIELDS.map((field) => [field.key, field]));

export function isBuiltinKey(key: string): boolean {
  return BUILTIN_BY_KEY.has(key);
}

export function builtinField(key: string): BuiltinField | undefined {
  return BUILTIN_BY_KEY.get(key);
}

/** Lead scalars an import is allowed to write. */
export const WRITABLE_BUILTIN_KEYS = BUILTIN_FIELDS.filter((field) => field.writable).map((field) => field.key);

/** A column as the API hands it to the client. Defaults have no `id`. */
export interface ResolvedField {
  id: string | null;
  key: string;
  label: string;
  type: LeadFieldType;
  builtin: boolean;
  hidden: boolean;
  position: number;
  width: number | null;
  meta: unknown;
}

function defaultFieldSet(): ResolvedField[] {
  return BUILTIN_FIELDS.map((field, index) => ({
    id: null,
    key: field.key,
    label: field.label,
    type: field.type,
    builtin: true,
    hidden: !field.visible,
    position: index,
    width: null,
    meta: null,
  }));
}

function toResolved(row: LeadField): ResolvedField {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    builtin: row.builtin,
    hidden: row.hidden,
    position: row.position,
    width: row.width,
    meta: row.meta,
  };
}

/**
 * The columns a given view should render: the group's own set when it has one,
 * otherwise the saved default set, otherwise the built-in defaults. `scope`
 * tells the UI which of the three it is looking at, so "Edit columns" can say
 * whether a change affects one batch or every batch.
 */
export async function resolveFields(groupId?: string | null): Promise<{ scope: "group" | "default" | "builtin"; fields: ResolvedField[] }> {
  if (groupId) {
    const own = await prisma.leadField.findMany({ where: { groupId }, orderBy: { position: "asc" } });
    if (own.length) return { scope: "group", fields: own.map(toResolved) };
  }
  const global = await prisma.leadField.findMany({ where: { groupId: null }, orderBy: { position: "asc" } });
  if (global.length) return { scope: "default", fields: global.map(toResolved) };
  return { scope: "builtin", fields: defaultFieldSet() };
}

// --- Writing ---------------------------------------------------------------

export interface FieldInput {
  key: string;
  label: string;
  type?: LeadFieldType;
  hidden?: boolean;
  width?: number | null;
  meta?: Prisma.InputJsonValue | null;
}

export function slugifyKey(label: string): string {
  const base = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\da-z]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
  // A custom key must never collide with a Lead scalar, or writes would fight
  // over the same column.
  if (!base || /^\d/.test(base)) return `field_${base || "1"}`;
  return isBuiltinKey(base) ? `${base}_custom` : base;
}

/**
 * Replaces a scope's column set wholesale — the shape the column editor sends,
 * where reorder, rename, hide and delete all arrive as one new list. Built-in
 * keys keep their `builtin` flag whatever the caller claims, so a custom column
 * can never masquerade as a Lead scalar.
 */
export async function replaceFields(groupId: string | null, fields: FieldInput[]): Promise<ResolvedField[]> {
  const seen = new Set<string>();
  const rows = fields
    .map((field, index) => {
      const key = field.key.trim();
      if (!key || seen.has(key)) return null;
      seen.add(key);
      const builtin = isBuiltinKey(key);
      return {
        groupId,
        key,
        label: field.label.trim() || key,
        type: field.type ?? builtinField(key)?.type ?? "TEXT",
        builtin,
        hidden: field.hidden ?? false,
        position: index,
        width: field.width ?? null,
        meta: (field.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  await prisma.$transaction([
    prisma.leadField.deleteMany({ where: { groupId } }),
    ...(rows.length ? [prisma.leadField.createMany({ data: rows })] : []),
  ]);

  const saved = await prisma.leadField.findMany({ where: { groupId }, orderBy: { position: "asc" } });
  return saved.map(toResolved);
}

// --- Value coercion --------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  // "GHS 12,500.00" / "1 200" / "(45)" all appear in real sheets.
  const cleaned = value.replace(/[^\d.,\-]/g, "").replace(/,(?=\d{3}\b)/g, "");
  const parsed = Number(cleaned.replace(/,/g, "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    // Excel serial dates, when a cell escaped the parser as a raw number.
    if (value > 20_000 && value < 60_000) return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (["yes", "y", "true", "1", "✓", "x", "done"].includes(text)) return true;
  if (["no", "n", "false", "0", "-"].includes(text)) return false;
  return null;
}

/**
 * Turns one raw cell into the value a Lead column should hold. Built-in
 * columns get the type the schema demands; custom columns keep the cell's own
 * shape so nothing about the original sheet is lost.
 */
export function coerceValue(key: string, type: LeadFieldType, raw: unknown): unknown {
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === null || text === undefined || text === "") return null;

  switch (key) {
    case "tags": {
      const list = String(text)
        .split(/[,;|]/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      return list.length ? list : null;
    }
    case "source": {
      const candidate = String(text).trim().toUpperCase().replace(/[\s-]+/g, "_");
      return (LEAD_SOURCES as readonly string[]).includes(candidate) ? candidate : null;
    }
    case "status": {
      const candidate = String(text).trim().toUpperCase().replace(/[\s-]+/g, "_");
      return (LEAD_STATUSES as readonly string[]).includes(candidate) ? candidate : null;
    }
    case "leadScore": {
      const score = toNumber(text);
      return score === null ? null : Math.max(0, Math.min(100, Math.round(score)));
    }
    case "reviewsCount": {
      const count = toNumber(text);
      return count === null ? null : Math.max(0, Math.round(count));
    }
    case "rating": {
      const rating = toNumber(text);
      return rating === null || rating < 0 || rating > 5 ? null : rating;
    }
  }

  switch (type) {
    case "NUMBER":
    case "CURRENCY":
      return toNumber(text);
    case "DATE":
      return toDate(text);
    case "BOOLEAN":
      return toBoolean(text);
    case "EMAIL": {
      const email = String(text).toLowerCase().replace(/^mailto:/, "").split(/[\s,;]/)[0];
      return EMAIL_PATTERN.test(email) ? email : null;
    }
    case "URL": {
      const url = String(text).trim();
      if (/^(n\/?a|none|null|-)$/i.test(url)) return null;
      const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      try {
        const parsed = new URL(withScheme);
        return parsed.hostname.includes(".") ? parsed.toString().replace(/\/$/, "") : null;
      } catch {
        return null;
      }
    }
    case "PHONE": {
      const phone = String(text).trim().replace(/^tel:/, "");
      // Under 7 digits is a reference number or a price, not something dialable.
      return phone.replace(/\D/g, "").length >= 7 ? phone : null;
    }
    default:
      return String(text);
  }
}
