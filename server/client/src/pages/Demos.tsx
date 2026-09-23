import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Demo, DemoStatus } from "../lib/types";
import { Badge, Button, Card, CopyButton, EmptyState, Loading, PageHeader, RelativeTime, StatGrid, StatTile } from "../components/ui";

const STATUS_LABEL: Record<DemoStatus, string> = {
  DRAFT: "Draft",
  READY: "Ready to send",
  SENT: "Link sent",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  ARCHIVED: "Archived",
};

const STATUS_TONE: Record<DemoStatus, "default" | "positive" | "muted" | "warn" | "info"> = {
  DRAFT: "muted",
  READY: "info",
  SENT: "default",
  ACCEPTED: "positive",
  DECLINED: "warn",
  ARCHIVED: "muted",
};

const STATUSES: DemoStatus[] = ["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "ARCHIVED"];

export function Demos() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<DemoStatus | "">("");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["demos", filter],
    queryFn: () => api.get<{ demos: Demo[]; base: string }>(`/demos${filter ? `?status=${filter}` : ""}`),
  });

  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: DemoStatus }) => api.patch<Demo>(`/demos/${id}`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["demos"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/demos/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["demos"] }),
  });

  const demos = data?.demos ?? [];

  // Summary Metrics
  const stats = useMemo(() => {
    let opened = 0;
    let accepted = 0;
    let totalViews = 0;

    for (const d of demos) {
      if (d.views > 0) opened++;
      if (d.status === "ACCEPTED") accepted++;
      totalViews += d.views;
    }

    const openRate = demos.length > 0 ? Math.round((opened / demos.length) * 100) : 0;

    return {
      total: demos.length,
      opened,
      accepted,
      totalViews,
      openRate,
    };
  }, [demos]);

  // Search filter
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return demos;
    return demos.filter(
      (d) =>
        d.businessName.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        (d.lead?.contactName && d.lead.contactName.toLowerCase().includes(q)),
    );
  }, [demos, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Demos & Previews"
        subtitle="Landing pages built for prospects. Each one lives at a public unlisted link you can share — allowing prospects to see their own business reimagined."
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile
          label="Total Demos Built"
          value={stats.total}
          sub="Unlisted prospect previews"
        />
        <StatTile
          label="Opened by Prospect"
          value={stats.opened}
          sub={`${stats.openRate}% view engagement rate`}
        />
        <StatTile
          label="Total Views Recorded"
          value={stats.totalViews}
          sub="Prospect interaction counts"
        />
        <StatTile
          label="Accepted"
          value={stats.accepted}
          sub={stats.accepted > 0 ? "Converted to client proposal" : "None converted yet"}
        />
      </StatGrid>

      {/* Search and Status Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <input
            type="search"
            placeholder="Search by business name or contact…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3.5 py-1.5 text-xs text-ink outline-none transition focus:border-blue focus:ring-2 focus:ring-blue/15"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFilter("")}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition  ${
              filter === ""
                ? "bg-ink text-white"
                : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
            }`}
          >
            All Demos
          </button>
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setFilter(status)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition  ${
                filter === status
                  ? "bg-ink text-white"
                  : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              {STATUS_LABEL[status]}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Loading label="Loading demos" rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={
            demos.length === 0
              ? "Nothing built yet. Open a lead with no website — or one whose site is the problem — and click 'Build a demo'."
              : "No demos match your search criteria."
          }
        />
      ) : (
        <div className="space-y-3.5">
          {filtered.map((demo) => (
            <Card key={demo.id} interactive className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-base font-medium text-ink">{demo.businessName}</h3>
                    <Badge tone={STATUS_TONE[demo.status]}>{STATUS_LABEL[demo.status]}</Badge>
                    {demo.version > 1 && <Badge tone="muted">v{demo.version}</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {demo.title}
                    {demo.builtBy && <> · built by <span className="font-medium text-ink">{demo.builtBy}</span></>}
                    {demo.lead && (
                      <>
                        {" · "}
                        <Link to={`/leads?lead=${demo.lead.id}`} className="text-blue hover:underline">
                          {demo.lead.contactName}
                        </Link>
                      </>
                    )}
                  </p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <a
                      href={demo.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-xs font-mono text-blue underline-offset-2 hover:underline max-w-md"
                    >
                      {demo.url.replace(/^https?:\/\//, "")}
                    </a>
                    <CopyButton text={demo.url} label="Copy" />
                  </div>
                </div>

                <div className="text-right text-xs text-muted shrink-0">
                  <div className={`font-mono ${demo.views > 0 ? "font-bold text-ink" : "text-muted"}`}>
                    {demo.views > 0 ? `Opened ${demo.views} time${demo.views === 1 ? "" : "s"}` : "Not yet opened"}
                  </div>
                  {demo.lastViewedAt && (
                    <div className="mt-0.5">
                      last viewed <RelativeTime value={demo.lastViewedAt} />
                    </div>
                  )}
                  {demo.sentAt && (
                    <div className="mt-0.5">
                      sent <RelativeTime value={demo.sentAt} />
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
                <select
                  value={demo.status}
                  onChange={(event) => update.mutate({ id: demo.id, status: event.target.value as DemoStatus })}
                  className="rounded-full border border-line bg-white px-2.5 py-1 font-sans text-[11px] uppercase tracking-[.06em] text-ink outline-none focus:border-blue"
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>

                <a href={demo.url} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="secondary">
                    Open Preview
                  </Button>
                </a>

                <span className="flex-1" />

                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Delete the demo for ${demo.businessName}? The link stops working immediately.`)) {
                      remove.mutate(demo.id);
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
