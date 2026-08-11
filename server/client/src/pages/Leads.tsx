import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Lead, LeadFieldDef, LeadStats } from "../lib/types";
import { LeadDrawer } from "../components/LeadDrawer";
import { EmailComposer, type ComposerTarget } from "../components/EmailComposer";
import {
  CAPTURE_METHODS,
  ColumnManager,
  LeadCell,
  LeadCellEditor,
  buildLeadPatch,
  captureMethodLabel,
  editableText,
  isEditableField,
  useLeadFields,
  visibleFields,
} from "../components/LeadColumns";
import { Button, Card, EmptyState, Field, Money, PageHeader, StatTile } from "../components/ui";

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

// Lists first, and the default: a lead belongs to the list it arrived in, and
// that's how it should read. Bucketing everything by status instead throws
// away which sheet or scrape it came from, and quietly implies a judgement
// ("qualified") that nobody has actually made yet.
const GROUP_BY = [
  { value: "group", label: "List" },
  { value: "status", label: "Status" },
  { value: "city", label: "City" },
  { value: "category", label: "Category" },
  { value: "source", label: "Source" },
  { value: "method", label: "How it got in" },
  { value: "none", label: "One flat list" },
] as const;

type GroupBy = (typeof GROUP_BY)[number]["value"];

interface Filters {
  q: string;
  status: string[];
  source: string;
  /** How the lead got in — APIFY, EXCEL, GOOGLE_SHEET, MANUAL… */
  captureMethod: string;
  groupId: string;
  city: string;
  category: string;
  has: string[];
  sort: string;
  /** Set by the "view what this run captured" links on the Lead capture page. */
  scraperSourceId: string;
  scraperRunId: string;
}

const EMPTY_FILTERS: Filters = {
  q: "",
  status: [],
  source: "",
  captureMethod: "",
  groupId: "",
  city: "",
  category: "",
  has: [],
  sort: "newest",
  scraperSourceId: "",
  scraperRunId: "",
};

function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status.length) params.set("status", filters.status.join(","));
  if (filters.source) params.set("source", filters.source);
  if (filters.captureMethod) params.set("captureMethod", filters.captureMethod);
  if (filters.groupId) params.set("groupId", filters.groupId);
  if (filters.city) params.set("city", filters.city);
  if (filters.category) params.set("category", filters.category);
  if (filters.has.length) params.set("has", filters.has.join(","));
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.scraperSourceId) params.set("scraperSourceId", filters.scraperSourceId);
  if (filters.scraperRunId) params.set("scraperRunId", filters.scraperRunId);
  return params.toString();
}

export function Leads() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // Arriving from "view what this run captured" lands here pre-filtered.
  const [filters, setFilters] = useState<Filters>(() => ({
    ...EMPTY_FILTERS,
    captureMethod: searchParams.get("captureMethod") ?? "",
    scraperSourceId: searchParams.get("scraperSourceId") ?? "",
    scraperRunId: searchParams.get("scraperRunId") ?? "",
  }));
  const [groupBy, setGroupBy] = useState<GroupBy>("group");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  // null = editing the default set; a group id = editing that list's own set.
  // `undefined` means the editor is closed.
  const [columnsFor, setColumnsFor] = useState<string | null | undefined>(undefined);

  const [emailing, setEmailing] = useState<ComposerTarget | null>(null);

  // The open lead lives in the URL, so a lead can be linked to directly.
  const openLeadId = searchParams.get("lead");
  const setOpenLeadId = (id: string | null) => {
    setSearchParams(
      (params) => {
        if (id) params.set("lead", id);
        else params.delete("lead");
        return params;
      },
      { replace: true },
    );
  };

  const query = toQuery(filters);

  const { data, isLoading } = useQuery({
    queryKey: ["leads", query],
    queryFn: () => api.get<{ items: Lead[]; total: number }>(`/leads?${query}`),
  });
  const { data: stats } = useQuery({
    queryKey: ["lead-stats", query],
    queryFn: () => api.get<LeadStats>(`/leads/stats?${query}`),
  });
  // The columns for whatever is being looked at: a batch's own set when one
  // batch is filtered to, the default set otherwise.
  const { data: fieldSet } = useLeadFields(filters.groupId || null);
  const columns = visibleFields(fieldSet);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["leads"] });
    void qc.invalidateQueries({ queryKey: ["lead-stats"] });
  };

  const createLead = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Lead>("/leads", body),
    onSuccess: () => {
      invalidate();
      setShowForm(false);
    },
  });

  const updateLead = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<Lead>(`/leads/${id}`, body),
    onSuccess: invalidate,
  });

  const bulkUpdate = useMutation({
    mutationFn: (body: { ids: string[]; status?: string; groupId?: string | null }) => api.patch("/leads/bulk", body),
    onSuccess: () => {
      invalidate();
      setSelected(new Set());
    },
  });

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => api.post("/leads/bulk/delete", { ids }),
    onSuccess: () => {
      invalidate();
      setSelected(new Set());
    },
  });

  const leads = data?.items ?? [];
  // Searching is a question about every lead you have, not about one list, so
  // the answer comes back as one ranked set rather than re-bucketed by list.
  const searching = filters.q.trim().length > 0;
  const effectiveGroupBy: GroupBy = searching && groupBy === "group" ? "none" : groupBy;
  const grouped = useMemo(() => groupLeads(leads, effectiveGroupBy), [leads, effectiveGroupBy]);
  const activeFilterCount =
    (filters.q ? 1 : 0) +
    filters.status.length +
    filters.has.length +
    (filters.source ? 1 : 0) +
    (filters.captureMethod ? 1 : 0) +
    (filters.groupId ? 1 : 0) +
    (filters.city ? 1 : 0) +
    (filters.category ? 1 : 0) +
    (filters.scraperSourceId ? 1 : 0) +
    (filters.scraperRunId ? 1 : 0);

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMany = (ids: string[], select: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  return (
    <div>
      <PageHeader
        title="Lead & Pipeline"
        subtitle="Every prospect from first contact through close — captured by hand or by the scrapers."
        action={
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => setColumnsFor(filters.groupId || null)}>
              Columns
            </Button>
            <ExportMenu query={query} count={data?.total ?? 0} />
            {/* Importing reaches into Google and spends Anthropic credits, so
                the API restricts it to the Owner — don't offer it to anyone else. */}
            {user?.role === "OWNER" && (
              <Link
                to="/leads/import"
                className="inline-flex items-center gap-2 border border-ink/20 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition hover:border-ink"
              >
                Import sheet
              </Link>
            )}
            <Link
              to="/lead-sources"
              className="inline-flex items-center gap-2 border border-ink/20 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition hover:border-ink"
            >
              Capture leads
            </Link>
            <Button onClick={() => setShowForm((open) => !open)}>{showForm ? "Cancel" : "New lead"}</Button>
          </div>
        }
      />

      {stats && (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile label="Leads" value={stats.total} sub={`${stats.newThisWeek} added this week`} />
          <StatTile
            label="Reachable"
            value={stats.reachable}
            sub={stats.total ? `${Math.round((stats.reachable / stats.total) * 100)}% have an email or phone` : "—"}
          />
          <StatTile label="Average score" value={stats.averageScore} sub="0–100, weighted on reachability" />
          <StatTile
            label="Qualified"
            value={stats.byStatus.find((row) => row.status === "QUALIFIED")?._count ?? 0}
            sub={`${stats.byStatus.find((row) => row.status === "QUALIFYING")?._count ?? 0} being qualified`}
          />
          <StatTile label="Estimated value" value={<Money amount={stats.pipelineValue} />} sub="Sum of deal sizes" />
        </div>
      )}

      {showForm && <NewLeadForm onSubmit={(body) => createLead.mutate(body)} pending={createLead.isPending} />}

      <FilterBar
        filters={filters}
        stats={stats}
        groupBy={groupBy}
        onGroupBy={setGroupBy}
        onChange={setFilters}
        activeFilterCount={activeFilterCount}
        resultCount={data?.total ?? 0}
      />

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          groups={stats?.groups ?? []}
          pending={bulkUpdate.isPending || bulkDelete.isPending}
          error={bulkDelete.error}
          onStatus={(status) => bulkUpdate.mutate({ ids: [...selected], status })}
          onGroup={(groupId) => bulkUpdate.mutate({ ids: [...selected], groupId })}
          onDelete={() => {
            if (confirm(`Delete ${selected.size} lead(s)? This cannot be undone.`)) bulkDelete.mutate([...selected]);
          }}
          onClear={() => setSelected(new Set())}
        />
      )}

      {/* The columns arrive on their own request, so wait for them too rather
          than flashing a table with no columns in it. */}
      {isLoading || !fieldSet ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : leads.length === 0 ? (
        <EmptyState
          message={
            activeFilterCount > 0
              ? "No leads match these filters."
              : "No leads yet. Add one by hand, or set up a scraper to capture them automatically."
          }
          action={
            activeFilterCount > 0 ? (
              <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear filters
              </Button>
            ) : (
              <Link
                to="/lead-sources"
                className="inline-flex items-center gap-2 bg-ink px-4 py-2 font-mono text-xs uppercase tracking-[.12em] text-ivory"
              >
                Set up lead capture
              </Link>
            )
          }
        />
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <LeadGroupBlock
              key={group.key}
              label={group.label}
              leads={group.leads}
              // Grouping by capture batch is the one view where each block can
              // legitimately have its own columns, so each block asks for them.
              groupId={effectiveGroupBy === "group" && group.key !== "none" ? group.key : null}
              fallbackColumns={columns}
              selected={selected}
              onToggle={toggleSelected}
              onToggleAll={toggleMany}
              onOpen={setOpenLeadId}
              onSave={(id, body) => updateLead.mutate({ id, body })}
              savingId={updateLead.isPending ? updateLead.variables?.id : undefined}
              saveError={updateLead.error}
              onEditColumns={setColumnsFor}
              showGroupHeader={effectiveGroupBy !== "none"}
            />
          ))}
          {data && data.total > leads.length && (
            <p className="text-center text-xs text-ink/40">
              Showing the first {leads.length} of {data.total}. Narrow the filters to see the rest.
            </p>
          )}
        </div>
      )}

      <LeadDrawer
        leadId={openLeadId}
        groups={stats?.groups ?? []}
        onClose={() => setOpenLeadId(null)}
        onEmail={(leadId) => {
          // Close the drawer first: one slide-over on top of another is a maze.
          setOpenLeadId(null);
          setEmailing({ leadId, purpose: "COLD_OUTREACH" });
        }}
      />

      <EmailComposer target={emailing} open={emailing !== null} onClose={() => setEmailing(null)} />

      <ColumnManager
        open={columnsFor !== undefined}
        onClose={() => setColumnsFor(undefined)}
        groupId={columnsFor ?? null}
        groupName={stats?.groups.find((group) => group.id === columnsFor)?.name}
      />
    </div>
  );
}

// --- Export ----------------------------------------------------------------

/**
 * Downloads whatever the table is currently showing. A plain link rather than
 * a fetch: the session cookie rides along, the browser handles the save
 * dialog, and a 5,000-row workbook never has to exist in memory here.
 */
function ExportMenu({ query, count }: { query: string; count: number }) {
  const base = import.meta.env.VITE_API_BASE ?? "/api";
  const href = (format: string) => `${base}/leads/export?format=${format}${query ? `&${query}` : ""}`;

  return (
    <span className="flex items-center gap-1">
      <a
        href={href("xlsx")}
        title={`Export ${count} lead${count === 1 ? "" : "s"} to Excel, with every column`}
        className="inline-flex items-center gap-2 border border-ink/20 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] transition hover:border-ink"
      >
        Excel
      </a>
      <a
        href={href("pdf")}
        title={`Export ${count} lead${count === 1 ? "" : "s"} to a printable PDF`}
        className="inline-flex items-center gap-2 border border-ink/20 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] transition hover:border-ink"
      >
        PDF
      </a>
    </span>
  );
}

// --- Grouping --------------------------------------------------------------

interface RenderGroup {
  key: string;
  label: string;
  leads: Lead[];
}

function groupLeads(leads: Lead[], groupBy: GroupBy): RenderGroup[] {
  if (groupBy === "none") return [{ key: "all", label: "All leads", leads }];

  const buckets = new Map<string, RenderGroup>();
  for (const lead of leads) {
    let key: string;
    let label: string;
    switch (groupBy) {
      case "group":
        key = lead.groupId ?? "none";
        label = lead.group?.name ?? "Ungrouped";
        break;
      case "city":
        key = lead.city ?? "none";
        label = lead.city ?? "No city";
        break;
      case "category":
        key = lead.category ?? "none";
        label = lead.category ?? "Uncategorised";
        break;
      case "source":
        key = lead.source;
        label = lead.source.replace(/_/g, " ");
        break;
      case "method":
        key = lead.captureMethod;
        label = captureMethodLabel(lead.captureMethod);
        break;
      default:
        key = lead.status;
        label = lead.status;
    }
    const bucket = buckets.get(key) ?? { key, label, leads: [] };
    bucket.leads.push(lead);
    buckets.set(key, bucket);
  }

  const groups = [...buckets.values()];
  // Status is a pipeline, so it reads in pipeline order; everything else reads
  // biggest-first, which is what you want when scanning a fresh capture.
  if (groupBy === "status") {
    return groups.sort((a, b) => STATUSES.indexOf(a.key) - STATUSES.indexOf(b.key));
  }
  return groups.sort((a, b) => b.leads.length - a.leads.length);
}

function LeadGroupBlock({
  label,
  leads,
  groupId,
  fallbackColumns,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onSave,
  savingId,
  saveError,
  onEditColumns,
  showGroupHeader,
}: {
  label: string;
  leads: Lead[];
  /** Set only when this block is one capture batch, which may own its columns. */
  groupId: string | null;
  fallbackColumns: LeadFieldDef[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], select: boolean) => void;
  onOpen: (id: string) => void;
  /** Any edit to a lead — a status change, or a whole row typed over. */
  onSave: (id: string, body: Record<string, unknown>) => void;
  savingId?: string;
  saveError: unknown;
  /** Opens the column editor for whichever set this block is rendering. */
  onEditColumns: (groupId: string | null) => void;
  showGroupHeader: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { data: ownFields } = useLeadFields(groupId);
  // Only a batch with its own set overrides the page's columns; a batch on the
  // defaults renders exactly like everything else.
  const columns = groupId && ownFields?.scope === "group" ? visibleFields(ownFields) : fallbackColumns;
  const ids = leads.map((lead) => lead.id);
  const allSelected = ids.every((id) => selected.has(id));
  const withEmail = leads.filter((lead) => lead.contactEmail).length;

  const startEditing = (lead: Lead) => {
    setEditingId(lead.id);
    setDraft(Object.fromEntries(columns.filter(isEditableField).map((field) => [field.key, editableText(lead, field)])));
  };

  const commit = (lead: Lead) => {
    const patch = buildLeadPatch(columns, draft);
    setEditingId(null);
    // Nothing changed is a perfectly ordinary outcome of opening a row.
    if (Object.keys(patch).length) onSave(lead.id, patch);
  };

  return (
    <section>
      {showGroupHeader && (
        <header className="mb-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCollapsed((open) => !open)}
            className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[.14em] text-ink/60 transition hover:text-ink"
          >
            <span className={`text-[9px] transition ${collapsed ? "" : "rotate-90"}`}>▶</span>
            {label}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/35">
            {leads.length} · {withEmail} with email
          </span>
          <span className="h-px flex-1 bg-ink/10" />
          <button
            type="button"
            onClick={() => onToggleAll(ids, !allSelected)}
            className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40 transition hover:text-ink"
          >
            {allSelected ? "Deselect" : "Select all"}
          </button>
        </header>
      )}

      {!collapsed && (
        <div className="overflow-x-auto border border-ink/10 bg-white">
          {saveError instanceof Error && (
            <p className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{saveError.message}</p>
          )}
          <table className="w-full text-left text-sm" style={{ minWidth: `${Math.max(640, columns.length * 150)}px` }}>
            <thead>
              <tr className="border-b border-ink/10 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
                <th className="w-8 px-3 py-3" />
                {columns.map((column) => (
                  <th key={column.key} className="px-4 py-3 whitespace-nowrap" style={column.width ? { width: column.width } : undefined}>
                    {/* The header is the way into renaming, reordering and
                        hiding this column — the place you're already looking
                        when you decide the name is wrong. */}
                    <button
                      type="button"
                      onClick={() => onEditColumns(groupId)}
                      title={`Edit columns${column.builtin ? "" : " · custom column"}`}
                      className="group flex items-center gap-1 uppercase tracking-[.12em] transition hover:text-ink"
                    >
                      {column.label}
                      <span className="opacity-0 transition group-hover:opacity-60">✎</span>
                    </button>
                  </th>
                ))}
                <th className="w-20 px-3 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onEditColumns(groupId)}
                    title="Add a column"
                    className="font-mono text-[13px] leading-none text-ink/40 transition hover:text-ink"
                  >
                    +
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const editing = editingId === lead.id;
                return (
                  <tr
                    key={lead.id}
                    className={`group border-b border-ink/5 transition last:border-0 ${
                      editing ? "bg-gold/10" : `cursor-pointer hover:bg-ivory/60 ${selected.has(lead.id) ? "bg-gold/5" : ""}`
                    }`}
                    onClick={() => !editing && onOpen(lead.id)}
                  >
                    <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => onToggle(lead.id)}
                        className="h-3.5 w-3.5 accent-[#0B0B0C]"
                        aria-label={`Select ${lead.contactName}`}
                      />
                    </td>
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className="px-4 py-3 align-top"
                        onClick={(event) => editing && event.stopPropagation()}
                      >
                        {editing && isEditableField(column) ? (
                          <LeadCellEditor
                            field={column}
                            value={draft[column.key] ?? ""}
                            onChange={(next) => setDraft((current) => ({ ...current, [column.key]: next }))}
                            onCommit={() => commit(lead)}
                            onCancel={() => setEditingId(null)}
                            autoFocus={column.key === columns.find(isEditableField)?.key}
                          />
                        ) : (
                          <LeadCell lead={lead} field={column} onStatus={(status) => onSave(lead.id, { status })} />
                        )}
                      </td>
                    ))}
                    <td className="px-3 py-3 text-right" onClick={(event) => event.stopPropagation()}>
                      {editing ? (
                        <span className="flex justify-end gap-2 font-mono text-[10px] uppercase tracking-[.1em]">
                          <button type="button" onClick={() => commit(lead)} className="text-bronze hover:underline">
                            {savingId === lead.id ? "Saving…" : "Save"}
                          </button>
                          <button type="button" onClick={() => setEditingId(null)} className="text-ink/40 hover:text-ink">
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEditing(lead)}
                          title="Edit this row"
                          aria-label={`Edit ${lead.contactName}`}
                          className="font-mono text-xs text-ink/25 opacity-0 transition hover:text-ink group-hover:opacity-100"
                        >
                          ✎
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// --- Filters ---------------------------------------------------------------

function FilterBar({
  filters,
  stats,
  groupBy,
  onGroupBy,
  onChange,
  activeFilterCount,
  resultCount,
}: {
  filters: Filters;
  stats?: LeadStats;
  groupBy: GroupBy;
  onGroupBy: (value: GroupBy) => void;
  onChange: (filters: Filters) => void;
  activeFilterCount: number;
  resultCount: number;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  return (
    <div className="mb-6 border border-ink/10 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink/5 px-4 py-3">
        <input
          value={filters.q}
          onChange={(event) => set({ q: event.target.value })}
          placeholder="Search name, company, email, city…"
          className="min-w-[16rem] flex-1 border border-ink/15 px-3 py-1.5 text-sm outline-none transition focus:border-ink/50"
        />
        <select value={filters.source} onChange={(event) => set({ source: event.target.value })} className="filter-select">
          <option value="">Any source</option>
          {SOURCES.map((source) => (
            <option key={source} value={source}>
              {source.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {/* How it got in, next to where it was found — the two questions that
            sound alike and aren't. */}
        <select
          value={filters.captureMethod}
          onChange={(event) => set({ captureMethod: event.target.value })}
          className="filter-select"
        >
          <option value="">Any method</option>
          {CAPTURE_METHODS.map((method) => {
            const count = stats?.byMethod?.find((row) => row.captureMethod === method.value)?._count ?? 0;
            // Methods nothing has ever arrived by would only be noise, unless
            // that's what's currently filtered to.
            if (!count && filters.captureMethod !== method.value) return null;
            return (
              <option key={method.value} value={method.value}>
                {method.label} ({count})
              </option>
            );
          })}
        </select>
        <select value={filters.groupId} onChange={(event) => set({ groupId: event.target.value })} className="filter-select">
          <option value="">Any batch</option>
          <option value="none">Ungrouped</option>
          {stats?.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name} ({group._count?.leads ?? 0})
            </option>
          ))}
        </select>
        <select value={filters.city} onChange={(event) => set({ city: event.target.value })} className="filter-select">
          <option value="">Any city</option>
          {stats?.cities.map((row) => (
            <option key={row.city} value={row.city ?? ""}>
              {row.city} ({row._count})
            </option>
          ))}
        </select>
        <select value={filters.category} onChange={(event) => set({ category: event.target.value })} className="filter-select">
          <option value="">Any category</option>
          {stats?.categories.map((row) => (
            <option key={row.category} value={row.category ?? ""}>
              {row.category} ({row._count})
            </option>
          ))}
        </select>
        <select value={filters.sort} onChange={(event) => set({ sort: event.target.value })} className="filter-select">
          <option value="newest">Newest first</option>
          <option value="score">Highest score</option>
          <option value="reviews">Most reviews</option>
          <option value="rating">Best rated</option>
          <option value="name">A–Z</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {STATUSES.map((status) => (
          <FilterChip
            key={status}
            active={filters.status.includes(status)}
            onClick={() => set({ status: toggleIn(filters.status, status) })}
          >
            {status}
            <span className="ml-1 text-ink/30">{stats?.byStatus.find((row) => row.status === status)?._count ?? 0}</span>
          </FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-ink/10" />
        <FilterChip active={filters.has.includes("email")} onClick={() => set({ has: toggleIn(filters.has, "email") })}>
          Has email
        </FilterChip>
        <FilterChip active={filters.has.includes("phone")} onClick={() => set({ has: toggleIn(filters.has, "phone") })}>
          Has phone
        </FilterChip>
        <FilterChip
          active={filters.has.includes("noWebsite")}
          onClick={() => set({ has: toggleIn(filters.has.filter((entry) => entry !== "website"), "noWebsite") })}
        >
          No website
        </FilterChip>

        <span className="flex-1" />
        <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">{resultCount} matching</span>
        <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">
          Group by
          <select value={groupBy} onChange={(event) => onGroupBy(event.target.value as GroupBy)} className="filter-select">
            {GROUP_BY.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="font-mono text-[10px] uppercase tracking-[.14em] text-bronze"
          >
            Clear ({activeFilterCount})
          </button>
        )}
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] transition ${
        active ? "bg-ink text-ivory" : "bg-ink/5 text-ink/50 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function BulkBar({
  count,
  groups,
  pending,
  error,
  onStatus,
  onGroup,
  onDelete,
  onClear,
}: {
  count: number;
  groups: LeadStats["groups"];
  pending: boolean;
  error: unknown;
  onStatus: (status: string) => void;
  onGroup: (groupId: string | null) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 border border-ink bg-ink px-4 py-3 text-ivory">
      <span className="font-mono text-[11px] uppercase tracking-[.14em]">{count} selected</span>
      <select
        defaultValue=""
        disabled={pending}
        onChange={(event) => event.target.value && onStatus(event.target.value)}
        className="bg-ivory px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-ink"
      >
        <option value="">Set status…</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
      <select
        defaultValue=""
        disabled={pending}
        onChange={(event) => event.target.value && onGroup(event.target.value === "none" ? null : event.target.value)}
        className="bg-ivory px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-ink"
      >
        <option value="">Move to batch…</option>
        <option value="none">Ungrouped</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        className="font-mono text-[10px] uppercase tracking-[.14em] text-red-300 transition hover:text-red-200"
      >
        Delete
      </button>
      {error instanceof Error && <span className="text-xs text-red-300">{error.message}</span>}
      <span className="flex-1" />
      <button type="button" onClick={onClear} className="font-mono text-[10px] uppercase tracking-[.14em] text-ivory/60">
        Clear
      </button>
    </div>
  );
}

// --- Manual entry ----------------------------------------------------------

function NewLeadForm({ onSubmit, pending }: { onSubmit: (body: Record<string, unknown>) => void; pending: boolean }) {
  const [form, setForm] = useState({
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    companyName: "",
    city: "",
    source: "OUTREACH",
    estimatedDealSize: "",
    discoveryNotes: "",
  });

  return (
    <Card className="mb-8">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            ...form,
            contactEmail: form.contactEmail || undefined,
            contactPhone: form.contactPhone || undefined,
            companyName: form.companyName || undefined,
            city: form.city || undefined,
            discoveryNotes: form.discoveryNotes || undefined,
            estimatedDealSize: form.estimatedDealSize ? Number(form.estimatedDealSize) : undefined,
          });
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Contact name">
          <input
            required
            value={form.contactName}
            onChange={(event) => setForm({ ...form, contactName: event.target.value })}
            className="input"
          />
        </Field>
        <Field label="Contact email">
          <input
            type="email"
            value={form.contactEmail}
            onChange={(event) => setForm({ ...form, contactEmail: event.target.value })}
            className="input"
          />
        </Field>
        <Field label="Phone">
          <input
            value={form.contactPhone}
            onChange={(event) => setForm({ ...form, contactPhone: event.target.value })}
            className="input"
          />
        </Field>
        <Field label="Company">
          <input
            value={form.companyName}
            onChange={(event) => setForm({ ...form, companyName: event.target.value })}
            className="input"
          />
        </Field>
        <Field label="City">
          <input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} className="input" />
        </Field>
        <Field label="Source">
          <select value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} className="input">
            {SOURCES.map((source) => (
              <option key={source} value={source}>
                {source.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Estimated deal size (GHS)">
          <input
            type="number"
            min="0"
            value={form.estimatedDealSize}
            onChange={(event) => setForm({ ...form, estimatedDealSize: event.target.value })}
            className="input"
          />
        </Field>
        <Field label="Discovery notes" full>
          <textarea
            rows={3}
            value={form.discoveryNotes}
            onChange={(event) => setForm({ ...form, discoveryNotes: event.target.value })}
            className="input"
          />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save lead"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
