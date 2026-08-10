import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Lead, LeadFieldDef, LeadFieldSet, LeadFieldType } from "../lib/types";
import { Badge, Button, Drawer, Money, RelativeTime, ScoreBar } from "./ui";

const STATUSES = ["NEW", "QUALIFYING", "QUALIFIED", "DISQUALIFIED", "CONVERTED", "LOST"];
const SOURCES = [
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
];

export const FIELD_TYPES: LeadFieldType[] = [
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
];

/**
 * The columns for a view. Passing a group id gets that batch's own columns when
 * it has them — which is how two batches imported from one workbook can show
 * completely different tables.
 */
export function useLeadFields(groupId?: string | null) {
  return useQuery({
    queryKey: ["lead-fields", groupId ?? ""],
    queryFn: () => api.get<LeadFieldSet>(`/leads/fields${groupId ? `?groupId=${groupId}` : ""}`),
    staleTime: 60_000,
  });
}

export function visibleFields(set: LeadFieldSet | undefined): LeadFieldDef[] {
  return (set?.fields ?? []).filter((field) => !field.hidden);
}

/** Reads a column's value off a lead, whether it's a Lead scalar or a custom one. */
export function leadValue(lead: Lead, field: LeadFieldDef): unknown {
  if (field.builtin) return (lead as unknown as Record<string, unknown>)[field.key];
  return lead.customFields?.[field.key];
}

// --- Rendering -------------------------------------------------------------

function Empty() {
  return <span className="text-ink/25">—</span>;
}

/**
 * One table cell. A few columns earn their own treatment — the score reads as a
 * bar, the status as the control that changes it, an email as something you can
 * click — and everything else is rendered from its type.
 */
export function LeadCell({
  lead,
  field,
  onStatus,
}: {
  lead: Lead;
  field: LeadFieldDef;
  onStatus?: (status: string) => void;
}) {
  const value = leadValue(lead, field);

  if (field.key === "leadScore") return <ScoreBar score={lead.leadScore} />;

  if (field.key === "status" && onStatus) {
    return (
      <select
        value={lead.status}
        onChange={(event) => onStatus(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        className="border border-ink/20 bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em]"
      >
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
    );
  }

  if (field.key === "contactName") {
    return <span className="font-medium">{lead.contactName}</span>;
  }

  if (value === null || value === undefined || value === "") return <Empty />;

  if (Array.isArray(value)) {
    return value.length ? (
      <span className="flex flex-wrap gap-1">
        {value.map((entry) => (
          <Badge key={String(entry)} tone="muted">
            {String(entry)}
          </Badge>
        ))}
      </span>
    ) : (
      <Empty />
    );
  }

  switch (field.type) {
    case "EMAIL":
      return (
        <a
          href={`mailto:${value}`}
          onClick={(event) => event.stopPropagation()}
          className="text-bronze hover:underline"
        >
          {String(value)}
        </a>
      );
    case "PHONE":
      return (
        <a
          href={`tel:${String(value).replace(/\s/g, "")}`}
          onClick={(event) => event.stopPropagation()}
          className="whitespace-nowrap text-bronze hover:underline"
        >
          {String(value)}
        </a>
      );
    case "URL":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="text-bronze hover:underline"
        >
          {String(value).replace(/^https?:\/\//, "").replace(/\/$/, "")}
        </a>
      );
    case "CURRENCY":
      return <Money amount={value as string} />;
    case "DATE":
      return field.key === "createdAt" ? (
        <span className="text-xs text-ink/40">
          <RelativeTime value={String(value)} />
        </span>
      ) : (
        <span className="whitespace-nowrap text-xs">{new Date(String(value)).toLocaleDateString()}</span>
      );
    case "BOOLEAN":
      return <span>{value === true || value === "true" ? "Yes" : "No"}</span>;
    case "LONG_TEXT":
      return (
        <span className="block max-w-[22rem] truncate text-ink/70" title={String(value)}>
          {String(value)}
        </span>
      );
    default:
      return <span>{String(value)}</span>;
  }
}

// --- Editing ---------------------------------------------------------------

/** Columns the system owns; everything else on a lead can be typed over. */
const READONLY_KEYS = new Set(["createdAt", "updatedAt", "id"]);

export function isEditableField(field: LeadFieldDef): boolean {
  return !READONLY_KEYS.has(field.key);
}

/** The current value as text, for putting in an input. */
export function editableText(lead: Lead, field: LeadFieldDef): string {
  const value = leadValue(lead, field);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (field.type === "DATE") {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
  }
  return String(value);
}

/**
 * One cell mid-edit. Built-in columns with a fixed vocabulary get a dropdown so
 * a typo can't put a lead into a status that doesn't exist; everything else
 * gets the input its type deserves.
 */
export function LeadCellEditor({
  field,
  value,
  onChange,
  onCommit,
  onCancel,
  autoFocus,
}: {
  field: LeadFieldDef;
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  const shared = "w-full min-w-[6rem] border border-ink/25 bg-white px-2 py-1 text-sm outline-none focus:border-ink";

  if (field.key === "status" || field.key === "source") {
    const options = field.key === "status" ? STATUSES : SOURCES;
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={keys} className={shared} autoFocus={autoFocus}>
        {!options.includes(value) && <option value={value}>{value || "—"}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "BOOLEAN") {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={keys} className={shared} autoFocus={autoFocus}>
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  return (
    <input
      value={value}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={keys}
      type={field.type === "DATE" ? "date" : field.type === "NUMBER" || field.type === "CURRENCY" ? "number" : "text"}
      className={shared}
    />
  );
}

/**
 * A row's edits as a PATCH body. Built-in columns go to their own Lead field;
 * everything else is merged into `customFields`, and each value is turned into
 * the shape the API validates for — an empty box means null, not "".
 */
export function buildLeadPatch(fields: LeadFieldDef[], draft: Record<string, string>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};

  for (const field of fields) {
    if (!isEditableField(field) || !(field.key in draft)) continue;
    const raw = draft[field.key].trim();

    let value: unknown = raw === "" ? null : raw;
    if (raw !== "") {
      if (field.key === "tags") {
        value = raw
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
      } else if (field.type === "NUMBER" || field.type === "CURRENCY") {
        const numeric = Number(raw);
        value = Number.isFinite(numeric) ? numeric : null;
      } else if (field.type === "BOOLEAN") {
        value = raw === "true";
      }
    } else if (field.key === "tags") {
      value = [];
    }

    if (field.builtin) patch[field.key] = value;
    else custom[field.key] = value;
  }

  if (Object.keys(custom).length) patch.customFields = custom;
  return patch;
}

// --- Column editor ---------------------------------------------------------

interface Draft extends LeadFieldDef {
  /** Set on rows the Owner added in this session, so they can be dropped again. */
  isNew?: boolean;
}

/**
 * "Edit columns" — the whole set is edited at once and saved in one go,
 * because reordering, renaming, hiding and adding all happen together and
 * applying them one at a time would leave the table in shapes nobody asked for.
 */
export function ColumnManager({
  open,
  onClose,
  groupId,
  groupName,
}: {
  open: boolean;
  onClose: () => void;
  /** Null edits the default set every batch falls back to. */
  groupId: string | null;
  groupName?: string;
}) {
  const qc = useQueryClient();
  const { data } = useLeadFields(groupId);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [addKey, setAddKey] = useState("");

  const fields = draft ?? (data?.fields as Draft[] | undefined) ?? [];
  const builtins = data?.builtins ?? [];
  const used = new Set(fields.map((field) => field.key));

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["lead-fields"] });
    void qc.invalidateQueries({ queryKey: ["leads"] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.put<LeadFieldSet>("/leads/fields", {
        groupId,
        fields: fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          hidden: field.hidden,
          width: field.width,
        })),
      }),
    onSuccess: () => {
      setDraft(null);
      invalidate();
      onClose();
    },
  });

  const reset = useMutation({
    mutationFn: () => api.delete(`/leads/fields${groupId ? `?groupId=${groupId}` : ""}`),
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
  });

  const update = (index: number, patch: Partial<Draft>) => {
    setDraft(fields.map((field, position) => (position === index ? { ...field, ...patch } : field)));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  };

  const addColumn = () => {
    if (!addKey) return;
    if (addKey === "__custom") {
      setDraft([
        ...fields,
        {
          id: null,
          key: `new_column_${fields.length + 1}`,
          label: "New column",
          type: "TEXT",
          builtin: false,
          hidden: false,
          position: fields.length,
          width: null,
          isNew: true,
        },
      ]);
    } else {
      const builtin = builtins.find((field) => field.key === addKey);
      if (!builtin) return;
      setDraft([
        ...fields,
        {
          id: null,
          key: builtin.key,
          label: builtin.label,
          type: builtin.type,
          builtin: true,
          hidden: false,
          position: fields.length,
          width: null,
          isNew: true,
        },
      ]);
    }
    setAddKey("");
  };

  return (
    <Drawer
      open={open}
      onClose={() => {
        setDraft(null);
        onClose();
      }}
      wide
      title="Edit columns"
      subtitle={
        groupId
          ? `Columns for “${groupName ?? "this batch"}” only — other batches keep theirs`
          : "Default columns, used by every batch that hasn't got its own"
      }
      footer={
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !draft}>
            {save.isPending ? "Saving…" : draft ? "Save columns" : "No changes"}
          </Button>
          {draft && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Discard
            </Button>
          )}
          <span className="flex-1" />
          {data?.scope !== "builtin" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm(groupId ? "Use the default columns for this batch?" : "Restore the built-in columns?")) reset.mutate();
              }}
              disabled={reset.isPending}
            >
              {groupId ? "Use default columns" : "Restore built-in columns"}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {save.isError && (
          <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {save.error instanceof Error ? save.error.message : "Could not save the columns"}
          </p>
        )}

        <p className="text-sm text-ink/60">
          Rename anything, reorder it, hide what you don't need, and add columns of your own. Columns marked{" "}
          <Badge tone="muted">lead field</Badge> feed the pipeline itself — filters, scoring and the conversion to a client — so
          their meaning is fixed even though their label isn't.
        </p>

        <div className="border border-ink/10 bg-white">
          {fields.map((field, index) => (
            <div key={`${field.key}-${index}`} className="flex flex-wrap items-center gap-2 border-b border-ink/5 px-3 py-2 last:border-0">
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="px-1 text-[10px] leading-none text-ink/40 transition hover:text-ink disabled:opacity-20"
                  aria-label={`Move ${field.label} up`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === fields.length - 1}
                  className="px-1 text-[10px] leading-none text-ink/40 transition hover:text-ink disabled:opacity-20"
                  aria-label={`Move ${field.label} down`}
                >
                  ▼
                </button>
              </div>

              <input
                value={field.label}
                onChange={(event) => update(index, { label: event.target.value })}
                className="w-44 border border-ink/15 px-2 py-1 text-sm outline-none transition focus:border-ink/50"
              />

              {field.builtin ? (
                <span className="flex items-center gap-2">
                  <Badge tone="muted">lead field</Badge>
                  <span className="font-mono text-[10px] text-ink/35">{field.key}</span>
                </span>
              ) : (
                <>
                  <input
                    value={field.key}
                    onChange={(event) => update(index, { key: event.target.value })}
                    className="w-36 border border-ink/10 bg-ivory px-2 py-1 font-mono text-[11px] outline-none"
                    title="Storage key — change this and existing values move with it"
                  />
                  <select
                    value={field.type}
                    onChange={(event) => update(index, { type: event.target.value as LeadFieldType })}
                    className="border border-ink/15 bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em]"
                  >
                    {FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <span className="flex-1" />

              <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
                <input
                  type="checkbox"
                  checked={!field.hidden}
                  onChange={(event) => update(index, { hidden: !event.target.checked })}
                  className="h-3.5 w-3.5 accent-[#0B0B0C]"
                />
                Show
              </label>

              <button
                type="button"
                onClick={() => setDraft(fields.filter((_, position) => position !== index))}
                className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40 transition hover:text-red-600"
              >
                Remove
              </button>
            </div>
          ))}
          {fields.length === 0 && <p className="px-3 py-4 text-sm text-ink/50">No columns. Add one below.</p>}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={addKey}
            onChange={(event) => setAddKey(event.target.value)}
            className="border border-ink/15 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">Add a column…</option>
            <option value="__custom">New column of my own</option>
            {builtins
              .filter((builtin) => !used.has(builtin.key))
              .map((builtin) => (
                <option key={builtin.key} value={builtin.key}>
                  {builtin.label} (lead field)
                </option>
              ))}
          </select>
          <Button size="sm" variant="secondary" onClick={addColumn} disabled={!addKey}>
            Add
          </Button>
          {data && (
            <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
              {data.scope === "group" ? "This batch has its own columns" : data.scope === "default" ? "Saved default set" : "Built-in set"}
            </span>
          )}
        </div>

        <p className="text-xs text-ink/40">
          Removing a column only takes it off the table — the values it held stay on the leads, and adding the column back shows them
          again.
        </p>
      </div>
    </Drawer>
  );
}
