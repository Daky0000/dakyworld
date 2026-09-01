import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { GroupedLeads, Lead, LeadFieldDef, LeadGroupBlock, LeadStats } from "../lib/types";
import { LeadDrawer } from "../components/LeadDrawer";
import { EmailComposer, type ComposerTarget } from "../components/EmailComposer";
import { MessageComposer, type MessageTarget } from "../components/MessageComposer";
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
import { Button, Card, EmptyState, Field, Modal, Money, PageHeader, RelativeTime, StatTile } from "../components/ui";
import { TagChip, TagManager, TagPicker, useLeadTags, useTagLookup } from "../components/LeadTags";

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

/**
 * How many rows a list opens with.
 *
 * Enough to judge a capture by — who is in it, how reachable they are, whether
 * the scrape found the right kind of business — and few enough that six lists
 * are still one screen. The rest of a list is one click away, and the block
 * header always says how many there really are.
 */
const PER_GROUP = 25;

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
  /** Tag slugs. */
  tags: string[];
  /** "any" (either tag) or "all" (both). Any is what people mean nine times in ten. */
  tagMatch: "any" | "all";
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
  tags: [],
  tagMatch: "any",
  sort: "newest",
  scraperSourceId: "",
  scraperRunId: "",
};

/**
 * The filter as the bulk endpoints take it.
 *
 * Built from `toQuery` and parsed back rather than written out again, so "act
 * on everything matching" is provably the same filter the list is showing. A
 * second serialiser here is a second thing that has to agree with `buildWhere`
 * for ever, and the day it stops agreeing is the day a bulk delete removes a
 * different set of leads from the one on screen.
 */
function toFilterObject(filters: Filters): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(toQuery(filters)));
}

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
  if (filters.tags.length) {
    params.set("tags", filters.tags.join(","));
    // Only sent when it changes the answer, so the query string stays readable.
    if (filters.tagMatch === "all" && filters.tags.length > 1) params.set("tagMatch", "all");
  }
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.scraperSourceId) params.set("scraperSourceId", filters.scraperSourceId);
  if (filters.scraperRunId) params.set("scraperRunId", filters.scraperRunId);
  return params.toString();
}

export function Leads() {
  const qc = useQueryClient();
  const { user, can } = useAuth();
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
  /**
   * "Everything matching", rather than the rows that happen to be ticked.
   *
   * A tick list cannot express forty-six thousand leads — the page holds a few
   * hundred of them and the request body would hold the rest. In this mode the
   * bulk actions send the filter itself and the count the screen is showing,
   * and the server refuses if that count has moved since.
   */
  const [allMatching, setAllMatching] = useState(false);
  /**
   * Lists ticked for removal.
   *
   * A workbook import opens one list per worksheet, so a bad import is
   * thirty-nine lists and thirty-nine confirmations for a single decision.
   */
  const [pickedLists, setPickedLists] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  // null = editing the default set; a group id = editing that list's own set.
  // `undefined` means the editor is closed.
  const [columnsFor, setColumnsFor] = useState<string | null | undefined>(undefined);

  const [emailing, setEmailing] = useState<ComposerTarget | null>(null);
  const [messaging, setMessaging] = useState<MessageTarget | null>(null);
  const [managingTags, setManagingTags] = useState(false);

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

  // And so does the open list, for the same reason: "look at this list" is a
  // thing somebody says to somebody else, and it should be a link.
  const openList = searchParams.get("list");
  const setOpenList = (id: string | null) => {
    setSearchParams(
      (params) => {
        if (id) params.set("list", id);
        else params.delete("list");
        return params;
      },
      { replace: true },
    );
  };

  const query = toQuery(filters);

  /**
   * Lists are grouped by the server, everything else in the browser.
   *
   * Bucketing a flat page of rows was only ever right when there were fewer
   * leads than fit in one: a list of 400 rendered as a block of 300 with "300"
   * in its header, and the list underneath it did not appear at all. Grouping
   * by *list* is the case where each block is a real thing with a real count,
   * so it asks for lists rather than rows. The other groupings — status, city,
   * category — are views over the same page and stay where they were.
   */
  const grouping = groupBy === "group";

  const { data, isLoading } = useQuery({
    queryKey: ["leads", query],
    queryFn: () => api.get<{ items: Lead[]; total: number }>(`/leads?${query}`),
    enabled: !grouping,
  });
  /**
   * A list opened on its own is not previewed.
   *
   * Filtering to one list is what "open this list" does, and answering that
   * with the same 25 rows would make the link a lie. 200 is the server's
   * ceiling; past it the block says how many it is showing.
   */
  const perGroup = filters.groupId ? 200 : PER_GROUP;

  const { data: grouped, isLoading: loadingGroups } = useQuery({
    queryKey: ["leads-grouped", query, perGroup],
    queryFn: () => api.get<GroupedLeads>(`/leads/grouped?${query}&perGroup=${perGroup}`),
    enabled: grouping,
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
    void qc.invalidateQueries({ queryKey: ["leads-grouped"] });
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
    mutationFn: (body: Record<string, unknown>) => api.patch("/leads/bulk", body),
    onSuccess: () => {
      invalidate();
      // A bulk retag can coin a tag, so the vocabulary is stale too.
      void qc.invalidateQueries({ queryKey: ["lead-tags"] });
      setSelected(new Set());
      setAllMatching(false);
    },
  });

  const [deleteResult, setDeleteResult] = useState<string | null>(null);

  /**
   * Lists with nothing in them.
   *
   * Its own request rather than counted off `stats.groups`, because that count
   * would include the lists a capture source still writes into — which are
   * empty every time before a source's first run — and a button offering to
   * remove eleven that removes eight is a button nobody trusts twice.
   */
  const { data: emptyLists } = useQuery({
    queryKey: ["empty-lists"],
    queryFn: () => api.get<{ removable: { id: string; name: string }[]; keptFeeding: { id: string; name: string }[] }>("/leads/groups/empty"),
  });

  const sweepEmpty = useMutation({
    mutationFn: () => api.post<{ listsRemoved: number; keptFeeding: { name: string }[] }>("/leads/groups/empty/delete", {}),
    onMutate: () => setDeleteResult(null),
    onSuccess: (result) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ["empty-lists"] });
      setDeleteResult(
        `Removed ${result.listsRemoved} empty list${result.listsRemoved === 1 ? "" : "s"}.` +
          (result.keptFeeding.length
            ? ` Kept ${result.keptFeeding.length}: a capture source still writes into ${result.keptFeeding.length === 1 ? "it" : "them"} ` +
              `(${result.keptFeeding.map((list) => list.name).join(", ")}).`
            : ""),
      );
    },
    onError: (err: Error) => setDeleteResult(err.message),
  });

  const deleteLists = useMutation({
    mutationFn: (body: { ids: string[]; withLeads: boolean; expect?: number }) =>
      api.post<{ listsRemoved: number; leadsUngrouped?: number; deleted: number; keptWithProposals: { name: string }[] }>(
        "/leads/groups/bulk/delete",
        body,
      ),
    onMutate: () => setDeleteResult(null),
    onSuccess: (result) => {
      invalidate();
      setPickedLists(new Set());
      setDeleteResult(
        `Removed ${result.listsRemoved} list${result.listsRemoved === 1 ? "" : "s"}.` +
          (result.leadsUngrouped ? ` ${result.leadsUngrouped} lead(s) came out ungrouped.` : "") +
          (result.deleted ? ` ${result.deleted} lead(s) deleted.` : "") +
          (result.keptWithProposals.length
            ? ` ${result.keptWithProposals.length} lead(s) kept because they carry a proposal, and their list with them.`
            : ""),
      );
    },
    onError: (err: Error) => setDeleteResult(err.message),
  });
  const bulkDelete = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ deleted: number; keptWithProposals: { name: string }[]; detached: { emails: number; messages: number; tasks: number } }>(
        "/leads/bulk/delete",
        body,
      ),
    onMutate: () => setDeleteResult(null),
    onSuccess: (result) => {
      invalidate();
      setSelected(new Set());
      setAllMatching(false);
      // Said out loud rather than left to a silent refresh. A delete that keeps
      // some rows back is the interesting case, and one that quietly removed
      // fewer than somebody asked for is how a list looks cleared and is not.
      const kept = result.keptWithProposals.length;
      const detached = result.detached.emails + result.detached.messages + result.detached.tasks;
      setDeleteResult(
        `Deleted ${result.deleted} lead${result.deleted === 1 ? "" : "s"}.` +
          (kept
            ? ` Kept ${kept} that ${kept === 1 ? "has a proposal" : "have proposals"}: ${result.keptWithProposals
                .slice(0, 5)
                .map((lead) => lead.name)
                .join(", ")}${kept > 5 ? `, and ${kept - 5} more` : ""}.`
            : "") +
          (detached ? ` ${detached} email, message and task record${detached === 1 ? "" : "s"} were kept and unlinked.` : ""),
      );
    },
    onError: (err: Error) => setDeleteResult(err.message),
  });

  /**
   * Who a bulk action is about, in the shape the endpoints take.
   *
   * One place, so the six call sites cannot disagree about whether they are
   * acting on the ticks or on the filter.
   */
  const bulkTarget = () =>
    allMatching ? { filter: toFilterObject(filters), expect: matching } : { ids: [...selected] };

  /**
   * Look at a whole selection at once.
   *
   * Worth its own action rather than looping the single one: the screenshots
   * are batched into as few Apify runs as possible, and the run boot is nearly
   * all of the cost. Sixty leads one at a time is sixty browsers starting up.
   */
  const [lookedResult, setLookedResult] = useState<string | null>(null);
  const bulkLook = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ prepared: unknown[]; failed: unknown[]; skipped: number; screenshotRuns: number; screenshotsTaken: number; costUsd: number }>(
        "/leads/prepare-many",
        { ids },
      ),
    onMutate: () => setLookedResult(null),
    onSuccess: (result) => {
      invalidate();
      setSelected(new Set());
      setLookedResult(
        `Looked at ${result.prepared.length}${result.skipped ? `, skipped ${result.skipped} already fresh` : ""}${
          result.failed.length ? `, ${result.failed.length} failed` : ""
        } — ${result.screenshotsTaken} screenshot${result.screenshotsTaken === 1 ? "" : "s"} in ${result.screenshotRuns} run${
          result.screenshotRuns === 1 ? "" : "s"
        }, $${result.costUsd.toFixed(3)}.`,
      );
    },
    onError: (err: Error) => setLookedResult(err.message),
  });

  // What is on screen, whichever way it was fetched. Under "List" that is the
  // preview of each list; otherwise it is the page of rows being bucketed.
  const leads = grouping ? (grouped?.groups ?? []).flatMap((group) => group.leads) : (data?.items ?? []);
  const matching = grouping ? (grouped?.totalLeads ?? 0) : (data?.total ?? 0);

  /**
   * Searching keeps the lists rather than dissolving them.
   *
   * It used to flatten to one ranked run of rows, on the reasoning that a
   * search is a question about everything. The first half of that is right and
   * the conclusion does not follow: "which of my lists is this business in" is
   * most of what somebody is asking, and a flat run of rows is the one answer
   * that cannot say. Lists with no match drop out on the server, so what is
   * left *is* the answer — and the search reaches every list's own columns,
   * which is what makes dropping the rest safe.
   */
  const blocks: RenderGroup[] = useMemo(
    () =>
      grouping
        ? (grouped?.groups ?? []).map((group) => ({
            key: group.id,
            label: group.name,
            leads: group.leads,
            total: group.total,
            list: group,
          }))
        : groupLeads(leads, groupBy),
    [grouping, grouped, leads, groupBy],
  );
  // Looked up rather than stored: the blocks are refetched constantly, and a
  // copy taken when the popup opened would go stale the moment a row is edited.
  const openBlock = openList === null ? null : (blocks.find((block) => block.key === openList) ?? null);

  const activeFilterCount =
    (filters.q ? 1 : 0) +
    filters.status.length +
    filters.has.length +
    filters.tags.length +
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
            {can("leads.tags") && (
              <Button variant="ghost" size="sm" onClick={() => setManagingTags(true)}>
                Tags
              </Button>
            )}
            <ExportMenu query={query} count={matching} />
            {/* Importing reaches into Google and spends Anthropic credits, and
                configuring capture spends on Apify. Both are their own
                permission now, so this asks the same question the API will. */}
            {can("leads.import") && (
              <Link
                to="/leads/import"
                className="inline-flex items-center gap-2 border border-ink/20 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition hover:border-ink"
              >
                Import sheet
              </Link>
            )}
            {can("leads.sources") && (
              <Link
                to="/lead-sources"
                className="inline-flex items-center gap-2 border border-ink/20 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition hover:border-ink"
              >
                Capture leads
              </Link>
            )}
            {can("leads.create") && (
              <Button onClick={() => setShowForm((open) => !open)}>{showForm ? "Cancel" : "New lead"}</Button>
            )}
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
        resultCount={matching}
      />

      {managingTags && <TagManager onClose={() => setManagingTags(false)} />}

      {(selected.size > 0 || allMatching) && (
        <BulkBar
          count={allMatching ? matching : selected.size}
          total={matching}
          allMatching={allMatching}
          onSelectAllMatching={() => setAllMatching(true)}
          groups={stats?.groups ?? []}
          pending={bulkUpdate.isPending || bulkDelete.isPending}
          error={bulkDelete.error}
          onStatus={(status) => bulkUpdate.mutate({ ...bulkTarget(), status })}
          onGroup={(groupId) => bulkUpdate.mutate({ ...bulkTarget(), groupId })}
          onTags={(addTags, removeTags) => bulkUpdate.mutate({ ...bulkTarget(), addTags, removeTags })}
          onDelete={() => {
            const count = allMatching ? matching : selected.size;
            // Typing the number is the guard on the destructive half. A
            // confirm() somebody has clicked forty times is not a decision, and
            // this is the one action on the screen with nothing behind it.
            const answer = prompt(
              `Delete ${count.toLocaleString()} lead${count === 1 ? "" : "s"}? This cannot be undone.\n\n` +
                `Leads carrying a proposal are kept back and named. Emails, phone messages and agent tasks are kept and unlinked.\n\n` +
                `Type ${count} to confirm.`,
            );
            if (answer?.trim() === String(count)) bulkDelete.mutate(bulkTarget());
          }}
          onLook={() => {
            if (
              confirm(
                `Research ${selected.size} business(es), check their sites and photograph their homepages? The screenshots go into as few Apify runs as possible, but this costs real money and takes a few minutes.`,
              )
            ) {
              bulkLook.mutate([...selected]);
            }
          }}
          looking={bulkLook.isPending}
          onClear={() => {
            setSelected(new Set());
            setAllMatching(false);
          }}
        />
      )}

      {/* The grouped view pages at twenty-five blocks and has no pager, so on a
          database carrying a bad import's residue the tickboxes can only ever
          reach the first twenty-five. This one acts on all of them. */}
      {emptyLists && emptyLists.removable.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink/70">
          <span>
            {emptyLists.removable.length} list{emptyLists.removable.length === 1 ? "" : "s"} {emptyLists.removable.length === 1 ? "has" : "have"} nothing in
            {emptyLists.removable.length === 1 ? " it" : " them"}.
            {emptyLists.keptFeeding.length > 0 && (
              <> Another {emptyLists.keptFeeding.length} {emptyLists.keptFeeding.length === 1 ? "is" : "are"} empty and being captured into, so {emptyLists.keptFeeding.length === 1 ? "it stays" : "they stay"}.</>
            )}
          </span>
          <Button
            variant="ghost"
            disabled={sweepEmpty.isPending}
            onClick={() => {
              if (confirm(`Remove ${emptyLists.removable.length} empty list(s)? No leads are deleted — there are none in them.`)) sweepEmpty.mutate();
            }}
          >
            {sweepEmpty.isPending ? "Removing…" : "Remove them"}
          </Button>
        </div>
      )}

      {pickedLists.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 border border-ink bg-ink px-4 py-3 text-cream">
          <span className="font-mono text-[11px] uppercase tracking-[.14em]">
            {pickedLists.size} list{pickedLists.size === 1 ? "" : "s"} picked
          </span>
          {/* Emptying is the default and stays it: a list is a way of
              organising leads, and deleting one is usually a tidy-up. */}
          <button
            type="button"
            disabled={deleteLists.isPending}
            onClick={() => deleteLists.mutate({ ids: [...pickedLists], withLeads: false })}
            className="border border-cream/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-cream hover:bg-cream/10 disabled:text-cream/40"
          >
            Remove, keep the leads
          </button>
          <button
            type="button"
            disabled={deleteLists.isPending}
            onClick={() => {
              const count = blocks
                .filter((block) => pickedLists.has(block.key))
                .reduce((sum, block) => sum + (block.total ?? block.leads.length), 0);
              const answer = prompt(
                `Remove ${pickedLists.size} list${pickedLists.size === 1 ? "" : "s"} and delete the ${count.toLocaleString()} lead` +
                  `${count === 1 ? "" : "s"} in them? This cannot be undone.\n\nType ${count} to confirm.`,
              );
              if (answer?.trim() === String(count)) deleteLists.mutate({ ids: [...pickedLists], withLeads: true, expect: count });
            }}
            className="border border-red-300/50 px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-red-300 hover:bg-red-300/10 disabled:text-cream/40"
          >
            Remove and delete their leads
          </button>
          <button
            type="button"
            onClick={() => setPickedLists(new Set())}
            className="font-mono text-[10px] uppercase tracking-[.14em] text-cream/60 hover:text-cream"
          >
            Clear
          </button>
        </div>
      )}

      {deleteResult && (
        <p className="mb-4 rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink/70">
          {deleteResult}{" "}
          <button type="button" onClick={() => setDeleteResult(null)} className="text-blue hover:underline">
            Dismiss
          </button>
        </p>
      )}

      {lookedResult && (
        <p className="mb-4 rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink/70">
          {lookedResult}{" "}
          <button type="button" onClick={() => setLookedResult(null)} className="text-blue hover:underline">
            dismiss
          </button>
        </p>
      )}

      {/* The columns arrive on their own request, so wait for them too rather
          than flashing a table with no columns in it. */}
      {(grouping ? loadingGroups : isLoading) || !fieldSet ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : blocks.length === 0 ? (
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
                className="inline-flex items-center gap-2 bg-ink px-4 py-2 font-mono text-xs uppercase tracking-[.12em] text-cream"
              >
                Set up lead capture
              </Link>
            )
          }
        />
      ) : (
        <div className="space-y-6">
          {/*
            Grouping by list is the one view where a block is a real thing with
            a name, a size and its own columns, so it gets the card. Every other
            grouping is a bucket the browser made up out of the rows in hand —
            there is nothing to open, so those stay as tables.
          */}
          {grouping ? (
            <LeadListCards
              blocks={blocks}
              pickedLists={pickedLists}
              onPickList={(id) =>
                setPickedLists((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              selected={selected}
              onOpenList={(block) => setOpenList(block.key)}
              onFilterToList={(id) => setFilters({ ...filters, groupId: id })}
              onEditColumns={setColumnsFor}
              onToggleAll={toggleMany}
            />
          ) : (
            blocks.map((block) => (
            <LeadListBlock
              key={block.key}
              label={block.label}
              leads={block.leads}
              total={block.total ?? block.leads.length}
              // Grouping by list is the one view where each block can
              // legitimately have its own columns, so each block asks for them.
              groupId={grouping && block.key !== "none" ? block.key : null}
              list={block.list ?? null}
              fallbackColumns={columns}
              selected={selected}
              onToggle={toggleSelected}
              onToggleAll={toggleMany}
              onOpen={setOpenLeadId}
              onSave={(id, body) => updateLead.mutate({ id, body })}
              savingId={updateLead.isPending ? updateLead.variables?.id : undefined}
              saveError={updateLead.error}
              onEditColumns={setColumnsFor}
              showGroupHeader={groupBy !== "none"}
              // Opening a list is a filter, not a second screen: the columns,
              // the tags and every bulk action are already here.
              onOpenList={grouping && block.key !== "none" ? () => setFilters({ ...filters, groupId: block.key }) : undefined}
            />
            ))
          )}
          {grouping
            ? grouped &&
              grouped.totalGroups > grouped.groups.length && (
                <p className="text-center text-xs text-ink/40">
                  Showing {grouped.groups.length} of {grouped.totalGroups} lists. Narrow the filters to see the rest.
                </p>
              )
            : data &&
              data.total > leads.length && (
                <p className="text-center text-xs text-ink/40">
                  Showing the first {leads.length} of {data.total}. Narrow the filters to see the rest.
                </p>
              )}
        </div>
      )}

      {/*
        Opening a list is a popup rather than a second screen, because
        everything that makes it useful is already on this one: the columns,
        the tags, the selection and every bulk action underneath it.
      */}
      <Modal
        open={openList !== null}
        onClose={() => setOpenList(null)}
        size="full"
        title={openBlock?.label ?? "List"}
        subtitle={
          openBlock && (
            <span className="flex flex-wrap items-center gap-2">
              <span>
                {(openBlock.total ?? openBlock.leads.length).toLocaleString()} leads ·{" "}
                {(openBlock.list?.withEmail ?? openBlock.leads.filter((lead) => lead.contactEmail).length).toLocaleString()} with email
              </span>
              {openBlock.list?.sourceLabel && <span className="text-ink/40">· {openBlock.list.sourceLabel}</span>}
              {/* Only when there are some. The picker's own empty state reads
                  "+ tag list", which in a subtitle looks like a broken label. */}
              {openBlock.list && openBlock.list.tags.length > 0 && <GroupTags group={openBlock.list} />}
            </span>
          )
        }
        footer={
          openBlock && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">
                {openBlock.leads.length < (openBlock.total ?? 0)
                  ? `Showing the first ${openBlock.leads.length} of ${openBlock.total}`
                  : `All ${openBlock.leads.length} shown`}
              </span>
              <span className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setColumnsFor(openBlock.key === "none" ? null : openBlock.key)}>
                  Edit columns
                </Button>
                {openBlock.key !== "none" && (
                  <Button
                    size="sm"
                    onClick={() => {
                      // Filtering the page to this list is how you reach the
                      // rows past the preview, and the bulk bar with them.
                      setFilters({ ...filters, groupId: openBlock.key });
                      setOpenList(null);
                    }}
                  >
                    Work the whole list
                  </Button>
                )}
              </span>
            </div>
          )
        }
      >
        {openBlock && (
          <LeadListBlock
            label={openBlock.label}
            leads={openBlock.leads}
            total={openBlock.total ?? openBlock.leads.length}
            groupId={openBlock.key !== "none" ? openBlock.key : null}
            list={openBlock.list ?? null}
            fallbackColumns={columns}
            selected={selected}
            onToggle={toggleSelected}
            onToggleAll={toggleMany}
            onOpen={(id) => {
              // One panel at a time: a lead drawer over a list popup is a maze.
              setOpenList(null);
              setOpenLeadId(id);
            }}
            onSave={(id, body) => updateLead.mutate({ id, body })}
            savingId={updateLead.isPending ? updateLead.variables?.id : undefined}
            saveError={updateLead.error}
            onEditColumns={setColumnsFor}
            showGroupHeader={false}
          />
        )}
      </Modal>

      <LeadDrawer
        leadId={openLeadId}
        groups={stats?.groups ?? []}
        onClose={() => setOpenLeadId(null)}
        onEmail={(leadId) => {
          // Close the drawer first: one slide-over on top of another is a maze.
          setOpenLeadId(null);
          setEmailing({ leadId, purpose: "COLD_OUTREACH" });
        }}
        onMessage={(leadId) => {
          setOpenLeadId(null);
          setMessaging({ leadId, channel: "WHATSAPP", purpose: "COLD_OUTREACH" });
        }}
      />

      <EmailComposer target={emailing} open={emailing !== null} onClose={() => setEmailing(null)} />
      <MessageComposer target={messaging} open={messaging !== null} onClose={() => setMessaging(null)} />

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
  /** What is rendered — a preview under "List", the whole bucket otherwise. */
  leads: Lead[];
  /**
   * Every lead in this block that matches, which is not the same number as
   * `leads.length` when the block is a list bigger than one preview. The whole
   * point of the grouped endpoint: a header count that is the truth about the
   * list rather than about what was fetched.
   */
  total?: number;
  /** The list itself, when the block is one. Carries its tags. */
  list?: LeadGroupBlock;
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

/**
 * The lists, as a list.
 *
 * Every list used to render its whole table inline, one under another. With
 * four lists that is a page; with thirty-nine — which is what one workbook
 * import produces — it is a mile of scrolling in which no two lists can be
 * compared, because they are never on screen together. So the lists became
 * rows: name, size, how many can actually be contacted, tags, where they came
 * from. Opening one is a popup with the table in it.
 *
 * Grouped by when the list arrived, because that is the question actually
 * being asked of a screen full of lists — "what came in today" — and because
 * a flat run of thirty-nine rows has the same problem as a flat run of
 * thirty-nine tables, just shorter.
 */
function LeadListCards({
  blocks,
  selected,
  pickedLists,
  onPickList,
  onOpenList,
  onFilterToList,
  onEditColumns,
  onToggleAll,
}: {
  blocks: RenderGroup[];
  selected: Set<string>;
  /** Lists ticked for removal. */
  pickedLists: Set<string>;
  onPickList: (id: string) => void;
  onOpenList: (block: RenderGroup) => void;
  onFilterToList: (id: string) => void;
  onEditColumns: (groupId: string | null) => void;
  onToggleAll: (ids: string[], select: boolean) => void;
}) {
  const sections = useMemo(() => groupListsByPeriod(blocks), [blocks]);

  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <section key={section.label}>
          <div className="mb-3 flex items-baseline gap-3">
            <h3 className="font-display text-lg tracking-[-.02em]">{section.label}</h3>
            <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/35">
              {section.blocks.length} {section.blocks.length === 1 ? "list" : "lists"} ·{" "}
              {section.blocks.reduce((sum, block) => sum + (block.total ?? block.leads.length), 0).toLocaleString()} leads
            </span>
            <span className="h-px flex-1 bg-ink/10" />
          </div>

          <div className="overflow-hidden rounded-2xl border border-line bg-white">
            {section.blocks.map((block) => {
              const total = block.total ?? block.leads.length;
              const withEmail = block.list?.withEmail ?? block.leads.filter((lead) => lead.contactEmail).length;
              // The number that decides whether a list is worth an afternoon:
              // a list you cannot contact is not a list, however long it is.
              const reachable = total ? Math.round((withEmail / total) * 100) : 0;
              const chosen = block.leads.filter((lead) => selected.has(lead.id)).length;

              return (
                <div
                  key={block.key}
                  className="group flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-ink/5 px-4 py-4 transition last:border-0 hover:bg-cream/60 sm:flex-nowrap"
                >
                  {block.list && (
                    <label className="shrink-0 cursor-pointer" title="Pick this list for removal">
                      <input type="checkbox" checked={pickedLists.has(block.key)} onChange={() => onPickList(block.key)} />
                    </label>
                  )}

                  {/* Size first, the way the reference puts the document first:
                      it is the thing you scan down the column for. */}
                  <button
                    type="button"
                    onClick={() => onOpenList(block)}
                    className="flex w-[4.5rem] shrink-0 flex-col items-center justify-center rounded-xl border border-line py-2 transition group-hover:border-ink/25"
                  >
                    <span className="font-display text-lg leading-none tracking-[-.02em]">{total.toLocaleString()}</span>
                    <span className="mt-0.5 font-mono text-[9px] uppercase tracking-[.12em] text-ink/40">leads</span>
                  </button>

                  <button type="button" onClick={() => onOpenList(block)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate font-medium">{block.label}</span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-[.1em] text-ink/40">
                      {block.list?.sourceLabel ?? (block.key === "none" ? "not in a list" : "added by hand")}
                      {block.list?.createdAt && <> · {new Date(block.list.createdAt).toLocaleDateString()}</>}
                    </span>
                  </button>

                  {block.list && block.list.tags.length > 0 && (
                    <div className="hidden shrink-0 lg:block">
                      <GroupTags group={block.list} />
                    </div>
                  )}

                  <div className="hidden w-28 shrink-0 text-right md:block">
                    <span className="font-mono text-[10px] uppercase tracking-[.1em] text-ink/40">
                      {block.list?.createdAt ? <RelativeTime value={block.list.createdAt} /> : "—"}
                    </span>
                  </div>

                  {/* Lime is the positive-status colour and nothing else, so it
                      appears here only when a list really is ready to work. */}
                  {/* Lime is the positive-status colour and is meant to be
                      1–5% of a surface, so it is a 3rem bar and only at the top
                      band — a page of lists all reading "good" in full lime is
                      the rule broken fifteen times over. */}
                  <div className="w-32 shrink-0 text-right">
                    <span className="block font-mono text-[11px] tracking-[.06em] text-ink/70">
                      {withEmail.toLocaleString()} with email
                    </span>
                    <span className="mt-1 flex items-center justify-end gap-1.5">
                      <span className="h-1 w-12 overflow-hidden rounded-full bg-ink/10">
                        <span
                          className={`block h-full ${reachable >= 80 ? "bg-lime" : reachable >= 25 ? "bg-blue" : "bg-ink/25"}`}
                          style={{ width: `${Math.max(2, reachable)}%` }}
                        />
                      </span>
                      <span className="font-mono text-[9px] uppercase tracking-[.1em] text-ink/40">{reachable}%</span>
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {chosen > 0 && (
                      <span className="rounded-full bg-blue/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-blue">
                        {chosen} picked
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenList(block)}
                      className="rounded-full bg-ink px-4 py-2 font-mono text-[10px] uppercase tracking-[.12em] text-cream transition hover:bg-ink/85"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleAll(block.leads.map((lead) => lead.id), true)}
                      title={`Select the ${block.leads.length} shown from this list`}
                      aria-label={`Select leads from ${block.label}`}
                      className="rounded-full border border-line px-2.5 py-2 font-mono text-[10px] text-ink/40 transition hover:border-ink/30 hover:text-ink"
                    >
                      ✓
                    </button>
                    {block.key !== "none" && (
                      <button
                        type="button"
                        onClick={() => onFilterToList(block.key)}
                        title="Filter the whole screen to this list"
                        aria-label={`Filter to ${block.label}`}
                        className="rounded-full border border-line px-2.5 py-2 font-mono text-[10px] text-ink/40 transition hover:border-ink/30 hover:text-ink"
                      >
                        ⌖
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onEditColumns(block.key === "none" ? null : block.key)}
                      title="Edit this list's columns"
                      aria-label={`Edit columns for ${block.label}`}
                      className="rounded-full border border-line px-2.5 py-2 font-mono text-[10px] text-ink/40 transition hover:border-ink/30 hover:text-ink"
                    >
                      ⚙
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Lists under the day, week or month they arrived.
 *
 * A list with no date — the "not in a list" bucket, and anything grouped in the
 * browser — sits under "Lists" at the top rather than being dropped or filed
 * under an invented date.
 */
function groupListsByPeriod(blocks: RenderGroup[]): { label: string; blocks: RenderGroup[] }[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;

  const sections = new Map<string, RenderGroup[]>();
  const order: string[] = [];
  const push = (label: string, block: RenderGroup) => {
    if (!sections.has(label)) {
      sections.set(label, []);
      order.push(label);
    }
    sections.get(label)!.push(block);
  };

  for (const block of blocks) {
    const created = block.list?.createdAt ? new Date(block.list.createdAt).getTime() : null;
    if (created === null || Number.isNaN(created)) {
      push("Lists", block);
      continue;
    }
    if (created >= startOfToday) push("Today", block);
    else if (created >= startOfToday - dayMs) push("Yesterday", block);
    else if (created >= startOfToday - 6 * dayMs) push("Earlier this week", block);
    else push(new Date(created).toLocaleDateString(undefined, { month: "long", year: "numeric" }), block);
  }

  // Newest first inside a section, biggest first where there are no dates.
  for (const [, group] of sections) {
    group.sort((a, b) => {
      const at = a.list?.createdAt ? Date.parse(a.list.createdAt) : 0;
      const bt = b.list?.createdAt ? Date.parse(b.list.createdAt) : 0;
      if (at !== bt) return bt - at;
      return (b.total ?? b.leads.length) - (a.total ?? a.leads.length);
    });
  }

  return order.map((label) => ({ label, blocks: sections.get(label)! }));
}

function LeadListBlock({
  label,
  leads,
  total,
  groupId,
  list,
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
  onOpenList,
}: {
  label: string;
  /** What is rendered. A preview of the list, when the list is a long one. */
  leads: Lead[];
  /** Every matching lead in this block — see `RenderGroup.total`. */
  total: number;
  /** Set only when this block is one list, which may own its columns. */
  groupId: string | null;
  /** The list itself, when this block is one. Carries its tags. */
  list: LeadGroupBlock | null;
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
  /** Filters the whole screen to this list. Absent when the block isn't one. */
  onOpenList?: () => void;
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
  // Counted over the whole list by the server where there is one, because
  // counting a 25-row preview would answer a different question from the one
  // the header appears to be answering. Falls back to the rows in hand for the
  // groupings that are still bucketed in the browser.
  const withEmail = list?.withEmail ?? leads.filter((lead) => lead.contactEmail).length;
  // A list longer than its preview. Every number below has to say which of the
  // two it is about, or the header quietly reports the preview as the list.
  const previewing = total > leads.length;

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
            {total} · {withEmail} with email
            {previewing && ` · showing ${leads.length}`}
          </span>
          {list && <GroupTags group={list} />}
          <span className="h-px flex-1 bg-ink/10" />
          {previewing && onOpenList && (
            <button type="button" onClick={onOpenList} className="font-mono text-[10px] uppercase tracking-[.14em] text-blue">
              Open this list
            </button>
          )}
          <button
            type="button"
            onClick={() => onToggleAll(ids, !allSelected)}
            title={previewing ? "Selects the rows shown here — open the list to select the rest" : undefined}
            className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40 transition hover:text-ink"
          >
            {allSelected ? "Deselect" : previewing ? `Select these ${leads.length}` : "Select all"}
          </button>
        </header>
      )}

      {!collapsed && (
        <div className="overflow-x-auto rounded-2xl border border-line bg-white">
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
                      editing ? "bg-blue/10" : `cursor-pointer hover:bg-cream/60 ${selected.has(lead.id) ? "bg-blue/5" : ""}`
                    }`}
                    onClick={() => !editing && onOpen(lead.id)}
                  >
                    <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => onToggle(lead.id)}
                        className="h-3.5 w-3.5 accent-blue"
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
                          <button type="button" onClick={() => commit(lead)} className="text-blue hover:underline">
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
          {previewing && (
            <p className="border-t border-ink/5 px-4 py-3 text-center text-xs text-ink/40">
              {leads.length} of {total} in this list.{" "}
              {onOpenList && (
                <button type="button" onClick={onOpenList} className="text-blue hover:underline">
                  Open the list
                </button>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// --- Filters ---------------------------------------------------------------

/**
 * A list's own tags.
 *
 * Separate from the tags on the leads inside it, because they answer different
 * questions: a lead is tagged with what the business is ("dental clinic"), and
 * a list with what the batch is for ("cold outreach", "Q4 push", "do not
 * contact until March"). Merging the two would mean tagging a batch put the
 * label on two hundred businesses it is not true of.
 */
function GroupTags({ group }: { group: { id: string; tags: string[] } }) {
  const qc = useQueryClient();
  const lookup = useTagLookup();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(group.tags ?? []);

  const save = useMutation({
    mutationFn: (tags: string[]) => api.patch(`/leads/groups/${group.id}`, { tags }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["lead-stats"] });
      void qc.invalidateQueries({ queryKey: ["lead-tags"] });
      setEditing(false);
    },
  });

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        {(group.tags ?? []).map((tag) => (
          <TagChip key={tag} slug={tag} lookup={lookup} />
        ))}
        <button
          type="button"
          onClick={() => {
            setDraft(group.tags ?? []);
            setEditing(true);
          }}
          className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/30 transition hover:text-blue"
          title="Tag this list"
        >
          {(group.tags ?? []).length > 0 ? "edit" : "+ tag list"}
        </button>
      </span>
    );
  }

  return (
    <span className="flex min-w-[18rem] flex-wrap items-start gap-2 rounded-lg border border-blue/30 bg-blue/5 p-2">
      <span className="min-w-[14rem] flex-1">
        <TagPicker value={draft} onChange={setDraft} placeholder="Tag this list…" />
      </span>
      <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/45"
      >
        Cancel
      </button>
    </span>
  );
}

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
    <div className="mb-6 rounded-2xl border border-line bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink/5 px-4 py-3">
        <input
          value={filters.q}
          onChange={(event) => set({ q: event.target.value })}
          // Says what it actually reaches now: every list, and inside each
          // list the columns that list has of its own.
          placeholder="Search every list — name, company, email, place, or any column…"
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

      <TagFilterRow filters={filters} onChange={onChange} />

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
            className="font-mono text-[10px] uppercase tracking-[.14em] text-blue"
          >
            Clear ({activeFilterCount})
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Filter by tag.
 *
 * Its own row rather than another dropdown, because a tag list is unbounded —
 * a capture coins one per business category, so a select would be three hundred
 * options long — and because the useful gesture is clicking two of them, not
 * picking one. The most-used tags come first; the rest are behind "all".
 *
 * The any/all switch only appears once two tags are chosen, since with one
 * selected it would change nothing.
 */
function TagFilterRow({ filters, onChange }: { filters: Filters; onChange: (filters: Filters) => void }) {
  const { data } = useLeadTags();
  const lookup = useTagLookup();
  const [showAll, setShowAll] = useState(false);

  const tags = data?.tags ?? [];
  if (tags.length === 0) return null;

  // Ranked by use: what somebody filters by is almost always what most of the
  // pipeline carries.
  const ranked = [...tags].sort((a, b) => b.leads - a.leads);
  const shown = showAll ? ranked : ranked.slice(0, 10);
  const toggle = (slug: string) =>
    onChange({
      ...filters,
      tags: filters.tags.includes(slug) ? filters.tags.filter((entry) => entry !== slug) : [...filters.tags, slug],
    });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-ink/5 px-4 py-3">
      <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/35">Tags</span>
      {shown.map((tag) => (
        <TagChip
          key={tag.slug}
          slug={tag.slug}
          lookup={lookup}
          active={filters.tags.includes(tag.slug)}
          onClick={() => toggle(tag.slug)}
        />
      ))}
      {ranked.length > shown.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40 transition hover:text-ink"
        >
          + {ranked.length - shown.length} more
        </button>
      )}
      {showAll && ranked.length > 10 && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40 transition hover:text-ink"
        >
          Fewer
        </button>
      )}

      {filters.tags.length > 1 && (
        <label className="ml-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">
          Match
          <select
            value={filters.tagMatch}
            onChange={(event) => onChange({ ...filters, tagMatch: event.target.value as "any" | "all" })}
            className="filter-select"
          >
            <option value="any">Any of them</option>
            <option value="all">All of them</option>
          </select>
        </label>
      )}
      {filters.tags.length > 0 && (
        <button
          type="button"
          onClick={() => onChange({ ...filters, tags: [] })}
          className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40 transition hover:text-ink"
        >
          Clear tags
        </button>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] transition ${
        active ? "bg-ink text-cream" : "bg-ink/5 text-ink/50 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function BulkBar({
  count,
  total,
  allMatching,
  onSelectAllMatching,
  groups,
  pending,
  error,
  onStatus,
  onGroup,
  onTags,
  onDelete,
  onLook,
  looking,
  onClear,
}: {
  count: number;
  /** Everything the current filter matches, not just what is on this page. */
  total: number;
  /** True when the actions apply to the filter rather than to the ticks. */
  allMatching: boolean;
  onSelectAllMatching: () => void;
  groups: LeadStats["groups"];
  pending: boolean;
  error: unknown;
  onStatus: (status: string) => void;
  onGroup: (groupId: string | null) => void;
  /** Adds and removes in one call, so tagging a segment is one action. */
  onTags: (add: string[], remove: string[]) => void;
  onDelete: () => void;
  /** Research, audit and photograph the whole selection, screenshots batched. */
  onLook: () => void;
  looking: boolean;
  onClear: () => void;
}) {
  const [tagging, setTagging] = useState(false);
  const [add, setAdd] = useState<string[]>([]);
  const [strip, setStrip] = useState<string[]>([]);

  return (
    <div className="mb-4 border border-ink bg-ink px-4 py-3 text-cream">
      <div className="flex flex-wrap items-center gap-3">
      <span className="font-mono text-[11px] uppercase tracking-[.14em]">
        {count.toLocaleString()} selected{allMatching ? " — everything matching" : ""}
      </span>
      {/*
        The step from "the rows I ticked" to "all of them". Without it the
        largest thing this screen can act on is one page, and clearing a
        46,110-lead import means ticking a few hundred rows at a time.
        Offered only when there is more to reach, so it never appears saying
        the same number twice.
      */}
      {!allMatching && total > count && (
        <button
          type="button"
          onClick={onSelectAllMatching}
          className="border border-cream/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-cream hover:bg-cream/10"
        >
          Select all {total.toLocaleString()} matching
        </button>
      )}
      <select
        defaultValue=""
        disabled={pending}
        onChange={(event) => event.target.value && onStatus(event.target.value)}
        className="bg-cream px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-ink"
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
        className="bg-cream px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-ink"
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
        onClick={() => setTagging((open) => !open)}
        disabled={pending}
        className={`font-mono text-[10px] uppercase tracking-[.14em] transition ${tagging ? "text-lime" : "text-cream/70 hover:text-cream"}`}
      >
        Tags…
      </button>
      <button
        type="button"
        onClick={onLook}
        // Off in select-all-matching mode, deliberately. Looking at a business
        // spends real money per lead — research, an audit and two screenshots —
        // so "all 46,110 matching" is not a thing to make one click away. Tick
        // the ones you mean.
        disabled={pending || looking || allMatching}
        title={allMatching ? "Tick the leads you want looked at — this one spends money per business." : undefined}
        className="font-mono text-[10px] uppercase tracking-[.14em] text-lime transition hover:text-lime/80 disabled:text-cream/40"
      >
        {looking ? "Looking…" : "Look at them"}
      </button>
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
      <button type="button" onClick={onClear} className="font-mono text-[10px] uppercase tracking-[.14em] text-cream/60">
        Clear
      </button>
      </div>

      {/* Add and remove together, because retagging a segment is normally both:
          the leads that stop being "to-call" are the ones that become "called". */}
      {tagging && (
        <div className="mt-3 grid gap-4 border-t border-cream/15 pt-3 sm:grid-cols-2">
          <div className="rounded-lg bg-cream p-3 text-ink">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-ink/45">Add to all {count}</p>
            <TagPicker value={add} onChange={setAdd} placeholder="Type a tag, or pick one…" />
          </div>
          <div className="rounded-lg bg-cream p-3 text-ink">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-ink/45">Take off all {count}</p>
            <TagPicker value={strip} onChange={setStrip} placeholder="Tags to remove…" />
          </div>
          <div className="sm:col-span-2 flex items-center gap-3">
            <Button
              size="sm"
              disabled={pending || (add.length === 0 && strip.length === 0)}
              onClick={() => {
                onTags(add, strip);
                setAdd([]);
                setStrip([]);
                setTagging(false);
              }}
            >
              {pending ? "Applying…" : "Apply"}
            </Button>
            <button
              type="button"
              onClick={() => setTagging(false)}
              className="font-mono text-[10px] uppercase tracking-[.14em] text-cream/60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
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
