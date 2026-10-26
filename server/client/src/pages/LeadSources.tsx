import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import type {
  ActorHealthReport,
  ApifyActorSummary,
  AppSettings,
  CaptureConfig,
  ScraperOverview,
  ScraperRun,
  ScraperSource,
  ScraperTemplate,
} from "../lib/types";
import { BLANK_SOURCE, SourceEditor, type SourceDraft } from "../components/SourceEditor";
import { Badge, Button, Card, Drawer, EmptyState, PageHeader, RelativeTime, StatusDot } from "../components/ui";
import { QuickCapture } from "../components/QuickCapture";

type TabKey = "quick" | "sources" | "runs" | "health";

export function LeadSources() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = (searchParams.get("tab") as TabKey) || "quick";

  const setTab = (tab: TabKey) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === "quick") next.delete("tab");
      else next.set("tab", tab);
      return next;
    });
  };

  const [editing, setEditing] = useState<SourceDraft | null>(null);
  const [picking, setPicking] = useState(false);

  // Sources tab filter & view controls
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "scheduled" | "maps" | "web" | "social" | "paused">("all");
  const [showAdhoc, setShowAdhoc] = useState(false);
  const [viewMode, setViewMode] = useState<"cards" | "compact">("cards");

  // Runs tab filter controls
  const [runStatusFilter, setRunStatusFilter] = useState<"ALL" | "RUNNING" | "SUCCEEDED" | "FAILED">("ALL");

  const { data: overview } = useQuery({
    queryKey: ["scraper-overview"],
    queryFn: ({ signal }) => api.get<ScraperOverview>("/scrapers/overview", signal),
    refetchInterval: (query) => ((query.state.data?.runningCount ?? 0) > 0 ? 5000 : false),
  });

  const { data: sources, isLoading: sourcesLoading } = useQuery({
    queryKey: ["scraper-sources"],
    queryFn: ({ signal }) => api.get<ScraperSource[]>("/scrapers/sources", signal),
    refetchInterval: (overview?.runningCount ?? 0) > 0 ? 5000 : false,
  });

  const { data: runs, isLoading: runsLoading } = useQuery({
    queryKey: ["scraper-runs"],
    queryFn: ({ signal }) => api.get<ScraperRun[]>("/scrapers/runs?take=30", signal),
    refetchInterval: (overview?.runningCount ?? 0) > 0 ? 5000 : false,
  });

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.get<AppSettings>("/settings", signal),
  });

  const { data: health } = useQuery({
    queryKey: ["actor-health", 0],
    queryFn: ({ signal }) => api.get<ActorHealthReport>("/scrapers/actors", signal),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["scraper-overview"] });
    void qc.invalidateQueries({ queryKey: ["scraper-sources"] });
    void qc.invalidateQueries({ queryKey: ["scraper-runs"] });
  };

  const runNow = useMutation({
    mutationFn: (id: string) => api.post<ScraperRun>(`/scrapers/sources/${id}/run`),
    onSuccess: refresh,
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<ScraperSource>(`/scrapers/sources/${id}`, { enabled }),
    onSuccess: refresh,
  });

  const removeSource = useMutation({
    mutationFn: (id: string) => api.delete(`/scrapers/sources/${id}`),
    onSuccess: refresh,
  });

  const stop = useMutation({
    mutationFn: (id: string) => api.post(`/scrapers/runs/${id}/stop`),
    onSuccess: refresh,
  });

  // Filter sources
  const filteredSources = useMemo(() => {
    if (!sources) return [];
    return sources.filter((source) => {
      // Ad-hoc quick-capture filter
      if (!showAdhoc && source.adhoc) return false;

      // Category filter
      if (sourceFilter === "scheduled" && (!source.scheduleEnabled || !source.enabled)) return false;
      if (sourceFilter === "paused" && source.enabled) return false;
      if (sourceFilter === "maps" && source.leadSource !== "GOOGLE_MAPS") return false;
      if (sourceFilter === "web" && source.leadSource !== "WEB_SCRAPE") return false;
      if (sourceFilter === "social" && source.leadSource !== "SOCIAL" && source.leadSource !== "LINKEDIN") return false;

      // Text search
      if (sourceSearch.trim()) {
        const query = sourceSearch.toLowerCase().trim();
        const matchesName = source.name.toLowerCase().includes(query);
        const matchesActor = source.actorId.toLowerCase().includes(query);
        const matchesDesc = (source.description ?? "").toLowerCase().includes(query);
        const matchesGroup = (source.groupName ?? "").toLowerCase().includes(query);
        return matchesName || matchesActor || matchesDesc || matchesGroup;
      }

      return true;
    });
  }, [sources, sourceFilter, showAdhoc, sourceSearch]);

  // Filter runs
  const filteredRuns = useMemo(() => {
    if (!runs) return [];
    if (runStatusFilter === "ALL") return runs;
    if (runStatusFilter === "RUNNING") return runs.filter((r) => r.status === "RUNNING" || r.status === "QUEUED");
    return runs.filter((r) => r.status === runStatusFilter);
  }, [runs, runStatusFilter]);

  // Counts for pills
  const counts = useMemo(() => {
    const list = sources ?? [];
    const permanent = list.filter((s) => !s.adhoc);
    return {
      all: list.length,
      permanent: permanent.length,
      scheduled: list.filter((s) => s.scheduleEnabled && s.enabled).length,
      maps: list.filter((s) => s.leadSource === "GOOGLE_MAPS").length,
      web: list.filter((s) => s.leadSource === "WEB_SCRAPE").length,
      social: list.filter((s) => s.leadSource === "SOCIAL" || s.leadSource === "LINKEDIN").length,
      paused: list.filter((s) => !s.enabled).length,
      adhoc: list.filter((s) => s.adhoc).length,
    };
  }, [sources]);

  const spendBlocked = overview?.spend?.blocked;
  const apifyError = settings?.apify?.error;

  return (
    <div>
      <PageHeader
        title="Lead Capture"
        subtitle="Extract leads instantly from any website link or run automated recurring scrapers."
        action={
          <div className="flex items-center gap-3">
            <Link
              to="/leads"
              className="rounded-full inline-flex items-center gap-2 border border-line-strong px-4 py-2 font-sans text-xs uppercase tracking-[.06em] transition hover:border-ink"
            >
              View Pipeline
            </Link>
            <Button
              onClick={() => {
                setTab("sources");
                setPicking(true);
              }}
            >
              + Add Source
            </Button>
          </div>
        }
      />

      {/* Persistent Alert Banner when Apify needs attention */}
      {(spendBlocked || apifyError) && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger-line bg-danger-surface p-4 text-sm text-danger-text">
          <div className="flex items-center gap-2.5">
            <StatusDot tone="bad" />
            <div>
              <span className="font-semibold">Apify Alert: </span>
              {spendBlocked
                ? "Monthly spending ceiling reached. Automatic runs are currently paused."
                : apifyError}
            </div>
          </div>
          <Link
            to="/settings?tab=capture"
            className="rounded-full border border-danger-line bg-white px-3 py-1 font-sans text-xs uppercase tracking-[.06em] text-danger-text transition hover:bg-danger-surface"
          >
            Adjust Budget in Settings →
          </Link>
        </div>
      )}

      {/* Compact Header KPI Metrics Ribbon */}
      {overview && (
        <div className="mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div className="rounded-xl border border-line/70 bg-cream/30 px-3.5 py-2.5">
            <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Captured This Week</span>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="font-display text-lg font-medium text-ink">{overview.capturedThisWeek}</span>
              <span className="text-xs text-muted">({overview.capturedTotal} total)</span>
            </div>
          </div>

          <div className="rounded-xl border border-line/70 bg-cream/30 px-3.5 py-2.5">
            <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Configured Sources</span>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="font-display text-lg font-medium text-ink">
                {overview.enabledCount}/{overview.sourceCount}
              </span>
              <span className="text-xs text-muted">({overview.scheduledCount} daily)</span>
            </div>
          </div>

          <div className="rounded-xl border border-line/70 bg-cream/30 px-3.5 py-2.5">
            <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Running Now</span>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="font-display text-lg font-medium text-ink">
                {overview.concurrency.running}/{overview.concurrency.limit}
              </span>
              <span className="text-xs text-muted">active workers</span>
            </div>
          </div>

          <div className="rounded-xl border border-line/70 bg-cream/30 px-3.5 py-2.5">
            <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Month Spend</span>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="font-display text-lg font-medium text-ink">
                ${overview.spend?.spentUsd != null ? overview.spend.spentUsd.toFixed(2) : "0.00"}
              </span>
              {overview.spend?.budgetUsd != null && (
                <span className="text-xs text-muted">/ ${overview.spend.budgetUsd.toFixed(2)}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Navigation Tabs Bar */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTab("quick")}
            className={`rounded-full px-4 py-2 font-sans text-xs font-semibold uppercase tracking-[.06em] transition ${
              currentTab === "quick"
                ? "bg-ink text-cream shadow-sm"
                : "text-muted hover:bg-cream/60 hover:text-ink"
            }`}
          >
            ⚡ Quick Capture
          </button>

          <button
            type="button"
            onClick={() => setTab("sources")}
            className={`rounded-full px-4 py-2 font-sans text-xs font-semibold uppercase tracking-[.06em] transition flex items-center gap-1.5 ${
              currentTab === "sources"
                ? "bg-ink text-cream shadow-sm"
                : "text-muted hover:bg-cream/60 hover:text-ink"
            }`}
          >
            <span>🎯 Lead Sources</span>
            {sources && (
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                  currentTab === "sources" ? "bg-cream/20 text-cream" : "bg-line/60 text-muted"
                }`}
              >
                {counts.permanent}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setTab("runs")}
            className={`rounded-full px-4 py-2 font-sans text-xs font-semibold uppercase tracking-[.06em] transition flex items-center gap-1.5 ${
              currentTab === "runs"
                ? "bg-ink text-cream shadow-sm"
                : "text-muted hover:bg-cream/60 hover:text-ink"
            }`}
          >
            <span>📜 Recent Runs</span>
            {overview && overview.concurrency.running > 0 && (
              <span className="h-2 w-2 rounded-full bg-blue animate-pulse" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setTab("health")}
            className={`rounded-full px-4 py-2 font-sans text-xs font-semibold uppercase tracking-[.06em] transition flex items-center gap-1.5 ${
              currentTab === "health"
                ? "bg-ink text-cream shadow-sm"
                : "text-muted hover:bg-cream/60 hover:text-ink"
            }`}
          >
            <span>⚙️ Connection & Health</span>
            <StatusDot tone={spendBlocked ? "bad" : settings?.apify?.connected ? "ok" : "idle"} />
          </button>
        </div>

        {currentTab === "sources" && (
          <div className="flex items-center gap-2">
            <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">View:</span>
            <button
              type="button"
              onClick={() => setViewMode("cards")}
              className={`rounded px-2.5 py-1 text-xs transition ${
                viewMode === "cards" ? "bg-ink text-cream" : "text-muted hover:text-ink"
              }`}
            >
              Cards
            </button>
            <button
              type="button"
              onClick={() => setViewMode("compact")}
              className={`rounded px-2.5 py-1 text-xs transition ${
                viewMode === "compact" ? "bg-ink text-cream" : "text-muted hover:text-ink"
              }`}
            >
              Compact
            </button>
          </div>
        )}
      </div>

      {/* TAB 1: QUICK CAPTURE */}
      {currentTab === "quick" && (
        <div className="space-y-6">
          <QuickCapture />

          {/* Quick guide tips */}
          <div className="rounded-2xl border border-line bg-cream/20 p-5">
            <h3 className="font-display text-base font-medium text-ink">How Quick Capture Works</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-line/60 bg-white p-3.5">
                <span className="font-sans text-xs font-semibold uppercase tracking-[.06em] text-ink">
                  1. Paste Any Link
                </span>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Paste a company website URL like <span className="font-mono text-ink">restaurantlogic.com</span>. The
                  system extracts emails, phone numbers, and socials in ~1 second.
                </p>
              </div>

              <div className="rounded-xl border border-line/60 bg-white p-3.5">
                <span className="font-sans text-xs font-semibold uppercase tracking-[.06em] text-ink">
                  2. Search Google Maps
                </span>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Type search phrases like <span className="font-mono text-ink">dental clinics in Kumasi</span>. It runs
                  a targeted search and scores places into your pipeline.
                </p>
              </div>

              <div className="rounded-xl border border-line/60 bg-white p-3.5">
                <span className="font-sans text-xs font-semibold uppercase tracking-[.06em] text-ink">
                  3. Automated Scrapers
                </span>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Need recurring daily captures? Switch to the{" "}
                  <button
                    type="button"
                    onClick={() => setTab("sources")}
                    className="text-blue underline font-medium"
                  >
                    Lead Sources
                  </button>{" "}
                  tab to configure scheduled runs.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: LEAD SOURCES (NO SCROLLING DOWN!) */}
      {currentTab === "sources" && (
        <div className="space-y-5">
          {/* Search, Filter Pills & Add Source Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white p-3 shadow-sm">
            <div className="relative min-w-[240px] flex-1">
              <input
                type="text"
                value={sourceSearch}
                onChange={(e) => setSourceSearch(e.target.value)}
                placeholder="Search sources by name, actor, keyword..."
                className="input py-1.5 pl-3 pr-8 text-sm"
              />
              {sourceSearch && (
                <button
                  type="button"
                  onClick={() => setSourceSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-ink"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSourceFilter("all")}
                className={`rounded-full px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition ${
                  sourceFilter === "all" ? "bg-ink text-cream" : "border border-line text-muted hover:text-ink"
                }`}
              >
                All ({counts.permanent})
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("scheduled")}
                className={`rounded-full px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition ${
                  sourceFilter === "scheduled" ? "bg-ink text-cream" : "border border-line text-muted hover:text-ink"
                }`}
              >
                Scheduled ({counts.scheduled})
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("maps")}
                className={`rounded-full px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition ${
                  sourceFilter === "maps" ? "bg-ink text-cream" : "border border-line text-muted hover:text-ink"
                }`}
              >
                Maps ({counts.maps})
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("web")}
                className={`rounded-full px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition ${
                  sourceFilter === "web" ? "bg-ink text-cream" : "border border-line text-muted hover:text-ink"
                }`}
              >
                Web ({counts.web})
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("social")}
                className={`rounded-full px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition ${
                  sourceFilter === "social" ? "bg-ink text-cream" : "border border-line text-muted hover:text-ink"
                }`}
              >
                Social ({counts.social})
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("paused")}
                className={`rounded-full px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition ${
                  sourceFilter === "paused" ? "bg-ink text-cream" : "border border-line text-muted hover:text-ink"
                }`}
              >
                Paused ({counts.paused})
              </button>
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 font-sans text-[11px] text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showAdhoc}
                  onChange={(e) => setShowAdhoc(e.target.checked)}
                  className="rounded border-line"
                />
                <span>Include ad-hoc ({counts.adhoc})</span>
              </label>

              <Button size="sm" onClick={() => setPicking(true)}>
                + New Source
              </Button>
            </div>
          </div>

          {/* Sources List / Cards */}
          {sourcesLoading ? (
            <div className="py-12 text-center text-sm text-muted">Loading configured lead sources…</div>
          ) : filteredSources.length === 0 ? (
            <EmptyState
              message={
                sourceSearch
                  ? `No sources found matching “${sourceSearch}”.`
                  : sourceFilter !== "all"
                    ? `No sources found under the “${sourceFilter}” filter.`
                    : "No lead sources yet. Start from a pre-configured template."
              }
              action={
                sourceSearch || sourceFilter !== "all" ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSourceSearch("");
                      setSourceFilter("all");
                    }}
                  >
                    Reset Filters
                  </Button>
                ) : (
                  <Button onClick={() => setPicking(true)}>Add your first source</Button>
                )
              }
            />
          ) : viewMode === "compact" ? (
            /* High-density compact table view */
            <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-sm">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line font-sans text-[11px] uppercase tracking-[.06em] text-muted">
                    <th className="px-4 py-3">Source Name</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Schedule</th>
                    <th className="px-4 py-3">Last Run</th>
                    <th className="px-4 py-3">Leads</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filteredSources.map((source) => {
                    const lastRun = source.runs?.[0];
                    const isLive = lastRun && (lastRun.status === "RUNNING" || lastRun.status === "QUEUED");
                    return (
                      <tr
                        key={source.id}
                        className={`hover:bg-cream/20 transition ${!source.enabled ? "opacity-60" : ""}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <StatusDot
                              tone={isLive ? "live" : source.enabled ? (source.scheduleEnabled ? "ok" : "idle") : "idle"}
                            />
                            <div>
                              <span className="font-medium text-ink">{source.name}</span>
                              <span className="block font-mono text-[10px] text-muted truncate max-w-[200px]">
                                {source.actorId}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-full border border-line bg-cream px-2 py-0.5 font-sans text-[10px] uppercase tracking-[.06em] text-muted">
                            {source.leadSource.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted">
                          {source.scheduleEnabled && source.scheduleTimes.length > 0 ? (
                            <span>{source.scheduleTimes.join(", ")}</span>
                          ) : (
                            <span className="text-muted">Manual</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {lastRun ? (
                            <span className="flex items-center gap-1.5">
                              <RunStatusBadge status={lastRun.status} />
                              <span className="text-muted">
                                <RelativeTime value={lastRun.startedAt} />
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted">Never</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-semibold">
                          <Link
                            to={`/leads?scraperSourceId=${source.id}`}
                            className="text-ink hover:text-blue hover:underline"
                          >
                            {source._count?.leads ?? 0}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              onClick={() => runNow.mutate(source.id)}
                              disabled={runNow.isPending || isLive}
                            >
                              {isLive ? "Running…" : "Run"}
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setEditing(source)}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => toggleEnabled.mutate({ id: source.id, enabled: !source.enabled })}
                            >
                              {source.enabled ? "Pause" : "Resume"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                if (confirm(`Delete “${source.name}”? Captured leads are kept.`)) {
                                  removeSource.mutate(source.id);
                                }
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            /* Card view */
            <div className="grid gap-3.5">
              {filteredSources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  health={health?.actors.find((actor) => actor.actorId === source.actorId) ?? null}
                  onRun={() => runNow.mutate(source.id)}
                  running={runNow.isPending && runNow.variables === source.id}
                  runError={runNow.variables === source.id && runNow.isError ? (runNow.error as Error).message : null}
                  onToggle={(enabled) => toggleEnabled.mutate({ id: source.id, enabled })}
                  onEdit={() => setEditing(source)}
                  onDelete={() => {
                    if (confirm(`Delete “${source.name}”? Leads it captured are kept.`)) removeSource.mutate(source.id);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: RECENT RUNS */}
      {currentTab === "runs" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted mr-1">Status:</span>
              {(["ALL", "RUNNING", "SUCCEEDED", "FAILED"] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setRunStatusFilter(status)}
                  className={`rounded-full px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition ${
                    runStatusFilter === status ? "bg-ink text-cream" : "border border-line text-muted hover:text-ink"
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted">Showing last 30 execution runs</span>
          </div>

          {runsLoading ? (
            <div className="py-12 text-center text-sm text-muted">Loading runs history…</div>
          ) : (
            <RunsTable runs={filteredRuns} onStop={(id) => stop.mutate(id)} />
          )}
        </div>
      )}

      {/* TAB 4: CONNECTION & HEALTH */}
      {currentTab === "health" && (
        <div className="space-y-6">
          <ApifyConnection settings={settings} overview={overview} />
          <WhyNothingRuns />
        </div>
      )}

      {/* Template picker drawer */}
      <SourcePicker
        open={picking}
        defaults={settings?.capture.config}
        onClose={() => setPicking(false)}
        onPick={(draft) => {
          setPicking(false);
          setEditing(draft);
        }}
      />

      {/* Source editor drawer */}
      <SourceEditor draft={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

// --- Connection ------------------------------------------------------------

function ApifyConnection({ settings, overview }: { settings?: AppSettings; overview?: ScraperOverview }) {
  const apify = settings?.apify;
  const spend = overview?.spend;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <StatusDot tone={spend?.blocked ? "bad" : apify?.connected ? "ok" : apify?.token ? "bad" : "idle"} />
          <h2 className="font-display text-lg">Apify Connection & Budget</h2>
        </div>
        <p className="min-w-[16rem] flex-1 text-sm text-muted">
          {apify?.connected ? (
            <>
              Connected as <strong>{apify.account?.username ?? "your account"}</strong>
              {apify.account?.plan?.id && <> on the {apify.account.plan.id} plan</>}.
              {spend && (
                <>
                  {" "}
                  <span className={spend.blocked ? "text-danger-text font-medium" : "text-muted"}>
                    ${spend.spentUsd.toFixed(2)} spent this month
                    {spend.budgetUsd != null ? ` of a $${spend.budgetUsd.toFixed(2)} ceiling` : ""}.
                  </span>
                </>
              )}
            </>
          ) : apify?.error ? (
            <span className="text-danger-text">{apify.error}</span>
          ) : (
            <>Scrapers can&rsquo;t run until an Apify API token is added.</>
          )}
        </p>
        <Link
          to="/settings?tab=capture"
          className="rounded-full inline-flex items-center gap-2 border border-line-strong px-4 py-2 font-sans text-xs uppercase tracking-[.06em] transition hover:border-ink"
        >
          {apify?.connected ? "Manage in Settings" : "Add a Token"}
        </Link>
      </div>
      {spend?.blocked && (
        <p className="mt-3 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">
          The monthly Apify budget ceiling has been reached, so background runs are paused. Raise it under{" "}
          <Link to="/settings?tab=capture" className="underline font-medium">
            Settings → Lead capture
          </Link>
          , or wait for the billing cycle to reset.
        </p>
      )}
    </Card>
  );
}

// --- Source card -----------------------------------------------------------

function SourceCard({
  source,
  health,
  onRun,
  running,
  runError,
  onToggle,
  onEdit,
  onDelete,
}: {
  source: ScraperSource;
  health: ActorHealthReport["actors"][number] | null;
  onRun: () => void;
  running: boolean;
  runError: string | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const lastRun = source.runs?.[0];
  const isLive = lastRun && (lastRun.status === "RUNNING" || lastRun.status === "QUEUED");
  const unknownKeys = health?.usedBy.find((entry) => entry.id === source.id)?.unknownKeys ?? [];

  return (
    <div
      className={`rounded-2xl border border-line bg-white p-5 transition-all duration-200 hover:border-line-strong ${
        source.enabled ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot tone={isLive ? "live" : source.enabled ? (source.scheduleEnabled ? "ok" : "idle") : "idle"} />
            <h3 className="font-display text-lg font-medium tracking-tight text-ink">{source.name}</h3>
            <span className="rounded-full border border-line bg-cream px-2.5 py-0.5 font-sans text-[11px] uppercase tracking-[.06em] text-muted">
              {source.leadSource.replace(/_/g, " ")}
            </span>
            {source.adhoc && <Badge tone="muted">quick-capture</Badge>}
            {!source.enabled && <Badge tone="muted">paused</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">{source.description || "No description provided"}</p>
          <p className="mt-1 font-mono text-[11px] text-muted">
            <a
              href={`https://apify.com/${source.actorId}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-blue hover:underline"
            >
              {source.actorId} ↗
            </a>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onRun} disabled={running || isLive}>
            {isLive ? "Running…" : running ? "Starting…" : "Run now"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onToggle(!source.enabled)}>
            {source.enabled ? "Pause" : "Resume"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-4">
        <Stat label="Schedule">
          {source.scheduleEnabled && source.scheduleTimes.length > 0 ? (
            <span>
              {source.scheduleTimes.join(", ")}{" "}
              <span className="text-muted">{source.timezone.replace("_", " ")}</span>
            </span>
          ) : (
            <span className="text-muted">Manual trigger</span>
          )}
        </Stat>
        <Stat label="Next run">
          {source.enabled && source.scheduleEnabled ? <RelativeTime value={source.nextRunAt} /> : <span className="text-muted">—</span>}
        </Stat>
        <Stat label="Last run">
          {lastRun ? (
            <span className="flex items-center gap-1.5">
              <RunStatusBadge status={lastRun.status} />
              <RelativeTime value={lastRun.startedAt} />
            </span>
          ) : (
            <span className="text-muted">Never</span>
          )}
        </Stat>
        <Stat label="Leads captured">
          <Link to={`/leads?scraperSourceId=${source.id}`} className="font-semibold hover:text-blue hover:underline">
            {source._count?.leads ?? 0} leads →
          </Link>
        </Stat>
      </dl>

      {runError && <p className="mt-3 text-sm text-danger-text">{runError}</p>}
      {lastRun?.error && (
        <p
          className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
            lastRun.status === "SUCCEEDED"
              ? "border-warn-line bg-warn-surface text-warn-text"
              : "border-danger-line bg-danger-surface text-danger-text"
          }`}
        >
          {lastRun.error}
        </p>
      )}
      {health && !health.reachable && (
        <p className="mt-3 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">
          Apify wouldn&rsquo;t return this actor. It may have been renamed or removed.
        </p>
      )}
      {unknownKeys.length > 0 && (
        <p className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
          The actor doesn&rsquo;t accept {unknownKeys.map((key) => `“${key}”`).join(", ")} — Apify ignores those keys.
        </p>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line/60 bg-cream/40 p-3">
      <dt className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}

// --- Runs ------------------------------------------------------------------

function RunStatusBadge({ status }: { status: ScraperRun["status"] }) {
  const tone = status === "SUCCEEDED" ? "positive" : status === "RUNNING" || status === "QUEUED" ? "default" : "muted";
  return <Badge tone={tone}>{status.replace("_", " ").toLowerCase()}</Badge>;
}

function RunsTable({ runs, onStop }: { runs: ScraperRun[]; onStop: (id: string) => void }) {
  if (runs.length === 0) return <EmptyState message="No runs found." />;

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-sm">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead>
          <tr className="border-b border-line font-sans text-[11px] uppercase tracking-[.06em] text-muted">
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Started</th>
            <th className="px-4 py-3">Trigger</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Found</th>
            <th className="px-4 py-3">New Leads</th>
            <th className="px-4 py-3">Enriched</th>
            <th className="px-4 py-3">Filtered</th>
            <th className="px-4 py-3">Cost</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map((run) => (
            <tr key={run.id} className="align-top hover:bg-cream/20 transition">
              <td className="px-4 py-3">
                <div className="font-medium text-ink">{run.source?.name ?? "Quick capture"}</div>
                {run.error && <div className="mt-0.5 max-w-md text-xs text-danger-text">{run.error}</div>}
              </td>
              <td className="px-4 py-3 text-xs text-muted">
                <RelativeTime value={run.startedAt} />
              </td>
              <td className="px-4 py-3">
                <Badge tone="muted">{run.trigger.toLowerCase()}</Badge>
              </td>
              <td className="px-4 py-3">
                <RunStatusBadge status={run.status} />
              </td>
              <td className="px-4 py-3 font-mono">{run.itemsFetched}</td>
              <td className="px-4 py-3 font-semibold text-emerald-700">
                {run.leadsCreated > 0 ? `+${run.leadsCreated}` : "0"}
              </td>
              <td className="px-4 py-3 text-muted">{run.leadsUpdated}</td>
              <td className="px-4 py-3 text-muted">
                {run.filtered}
                {run.filtered > 0 && run.diagnostics && <WhyDropped diagnostics={run.diagnostics} />}
              </td>
              <td className="px-4 py-3 text-xs text-muted">
                {run.costUsd != null ? (
                  <>
                    <span className="font-medium text-ink">${Number(run.costUsd).toFixed(2)}</span>
                    {run.estimateUsd != null && (
                      <span className="block text-muted">est ${Number(run.estimateUsd).toFixed(2)}</span>
                    )}
                  </>
                ) : run.estimateUsd != null ? (
                  <span className="text-muted">est ${Number(run.estimateUsd).toFixed(2)}</span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                {(run.status === "RUNNING" || run.status === "QUEUED") && (
                  <Button size="sm" variant="ghost" onClick={() => onStop(run.id)}>
                    Stop
                  </Button>
                )}
                {run.status === "SUCCEEDED" && run.leadsCreated > 0 && (
                  <Link
                    to={`/leads?scraperRunId=${run.id}`}
                    className="font-sans text-[11px] uppercase tracking-[.06em] text-blue font-semibold hover:underline"
                  >
                    View {run.leadsCreated} leads →
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WhyDropped({ diagnostics }: { diagnostics: NonNullable<ScraperRun["diagnostics"]> }) {
  const [open, setOpen] = useState(false);
  if (!diagnostics.dropped?.length) return null;

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="font-sans text-[11px] uppercase tracking-[.06em] text-blue hover:underline"
      >
        {open ? "hide" : "why?"}
      </button>
      {open && (
        <ul className="mt-1 max-w-sm space-y-1">
          {diagnostics.dropped.map((entry) => (
            <li key={entry.reason} className="text-xs leading-relaxed text-muted">
              <span className="font-medium text-ink">{entry.count}×</span> {entry.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Add a source ----------------------------------------------------------

function SourcePicker({
  open,
  defaults,
  onClose,
  onPick,
}: {
  open: boolean;
  defaults?: CaptureConfig;
  onClose: () => void;
  onPick: (draft: SourceDraft) => void;
}) {
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");

  const { data: templates } = useQuery({
    queryKey: ["scraper-templates"],
    queryFn: ({ signal }) => api.get<ScraperTemplate[]>("/scrapers/templates", signal),
    enabled: open,
  });

  const { data: catalog, isFetching } = useQuery({
    queryKey: ["scraper-catalog", submitted],
    queryFn: ({ signal }) =>
      api.get<{ store: ApifyActorSummary[]; mine: ApifyActorSummary[] }>(
        `/scrapers/catalog?search=${encodeURIComponent(submitted)}`,
        signal,
      ),
    enabled: open,
  });

  const blank: SourceDraft = {
    ...BLANK_SOURCE,
    ...(defaults && {
      maxItems: defaults.maxItems,
      minScore: defaults.minScore,
      autoQualify: defaults.autoQualify,
      qualifyScore: defaults.qualifyScore,
      timezone: defaults.timezone,
    }),
  };

  const fromTemplate = (template: ScraperTemplate): SourceDraft => ({
    ...blank,
    name: template.name,
    actorId: template.actorId,
    description: template.description,
    input: template.input,
    preset: template.preset,
    leadSource: template.leadSource,
    groupName: template.groupName,
    maxItems: template.maxItems,
    minScore: template.minScore,
  });

  const fromActor = (actor: ApifyActorSummary): SourceDraft => ({
    ...blank,
    name: actor.title ?? actor.name,
    actorId: actor.fullName,
    description: actor.description ?? "",
    preset: "AUTO",
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title="Add a Lead Source"
      subtitle="Start from a pre-configured Ghana/African market template, or pick any Apify actor"
    >
      <div className="space-y-8">
        <section>
          <h3 className="mb-3 font-sans text-[11px] uppercase tracking-[.06em] text-muted">Pre-Built Templates</h3>
          <div className="grid gap-3">
            {templates?.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onPick(fromTemplate(template))}
                className="rounded-2xl border border-line bg-white p-4 text-left transition hover:border-ink/50 hover:bg-cream/20 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{template.name}</span>
                  <Badge tone="positive">{template.headline}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">{template.description}</p>
                <p className="mt-1 font-mono text-[11px] text-muted">{template.actorId}</p>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-3 font-sans text-[11px] uppercase tracking-[.06em] text-muted">Search Any Actor on Apify</h3>
          <form
            className="mb-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(search.trim());
            }}
          >
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search Apify Store — “linkedin”, “instagram”, “yellow pages”…"
              className="input"
            />
            <Button type="submit" variant="secondary">
              {isFetching ? "Searching…" : "Search"}
            </Button>
          </form>

          {catalog?.mine && catalog.mine.length > 0 && (
            <>
              <p className="mb-2 font-sans text-[11px] uppercase tracking-[.06em] text-muted">Your Custom Actors</p>
              <ActorList actors={catalog.mine} onPick={(actor) => onPick(fromActor(actor))} />
            </>
          )}

          <ActorList actors={catalog?.store ?? []} onPick={(actor) => onPick(fromActor(actor))} />

          <button
            type="button"
            onClick={() => onPick(blank)}
            className="mt-4 font-sans text-[11px] uppercase tracking-[.06em] text-blue hover:underline"
          >
            Or enter an actor id by hand →
          </button>
        </section>
      </div>
    </Drawer>
  );
}

function ActorList({ actors, onPick }: { actors: ApifyActorSummary[]; onPick: (actor: ApifyActorSummary) => void }) {
  if (actors.length === 0) return null;
  return (
    <div className="mb-4 grid gap-2">
      {actors.map((actor) => (
        <button
          key={actor.id}
          type="button"
          onClick={() => onPick(actor)}
          className="flex items-start gap-3 rounded-2xl border border-line bg-white p-3 text-left transition hover:border-ink/40"
        >
          {actor.pictureUrl && <img src={actor.pictureUrl} alt="" className="h-8 w-8 shrink-0 object-contain" />}
          <span className="min-w-0">
            <span className="block font-medium text-ink">{actor.title ?? actor.name}</span>
            <span className="mt-0.5 block truncate text-xs text-muted">{actor.description}</span>
            <span className="mt-0.5 block font-mono text-[11px] text-muted">
              {actor.fullName}
              {actor.stats?.totalRuns ? ` · ${Intl.NumberFormat().format(actor.stats.totalRuns)} runs` : ""}
              {actor.pricingModel && actor.pricingModel !== "FREE"
                ? ` · ${actor.pricingModel.replace(/_/g, " ").toLowerCase()}`
                : ""}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

// --- Why nothing runs ------------------------------------------------------

interface CaptureCheck {
  name: string;
  state: "ok" | "warn" | "stop" | "unknown";
  found: string;
  fix: string | null;
}

function WhyNothingRuns() {
  const [asked, setAsked] = useState(false);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["capture-diagnosis"],
    enabled: asked,
    queryFn: ({ signal }) =>
      api.get<{ verdict: string; blocked: boolean; checks: CaptureCheck[] }>("/scrapers/diagnose", signal),
  });

  const tone = (state: CaptureCheck["state"]) =>
    state === "stop" ? "bad" : state === "warn" ? "warn" : state === "unknown" ? "idle" : ("ok" as const);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg">Self-Diagnostics</h2>
          <p className="mt-1 text-sm text-muted">
            Checks the Apify token, balance, spending ceilings, schedules, and active scrapers to identify why runs may be stalled.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={isFetching}
          onClick={() => {
            setAsked(true);
            if (asked) void refetch();
          }}
        >
          {isFetching ? "Checking…" : asked ? "Run Diagnostics Again" : "Check System Health"}
        </Button>
      </div>

      {data && (
        <div className="mt-4 space-y-3">
          <p className={`text-sm ${data.blocked ? "font-medium text-danger-text" : "text-ink"}`}>{data.verdict}</p>
          <ul className="space-y-2">
            {data.checks.map((check) => (
              <li key={check.name} className="flex items-start gap-3 rounded-xl border border-line p-3 text-sm bg-white">
                <span className="pt-1">
                  <StatusDot tone={tone(check.state)} />
                </span>
                <div className="min-w-0">
                  <div className="font-medium text-ink">{check.name}</div>
                  <p className="text-muted text-xs mt-0.5">{check.found}</p>
                  {check.fix && <p className="mt-1 text-xs text-blue font-medium">{check.fix}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
