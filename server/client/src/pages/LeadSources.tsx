import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type {
  ApifyActorSummary,
  AppSettings,
  ScraperOverview,
  ScraperRun,
  ScraperSource,
  ScraperTemplate,
} from "../lib/types";
import { BLANK_SOURCE, SourceEditor, type SourceDraft } from "../components/SourceEditor";
import { Badge, Button, Card, Drawer, EmptyState, Field, PageHeader, RelativeTime, StatTile, StatusDot } from "../components/ui";

/**
 * Lead capture — where the Owner connects Apify, configures which actors run,
 * and sees what each run brought in. Everything on this page is configuration:
 * the leads themselves live on the Leads page.
 */
export function LeadSources() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SourceDraft | null>(null);
  const [picking, setPicking] = useState(false);

  const { data: overview } = useQuery({
    queryKey: ["scraper-overview"],
    queryFn: () => api.get<ScraperOverview>("/scrapers/overview"),
    // While something is scraping, the page is a live view of it.
    refetchInterval: (query) => ((query.state.data?.runningCount ?? 0) > 0 ? 4000 : false),
  });

  const { data: sources, isLoading } = useQuery({
    queryKey: ["scraper-sources"],
    queryFn: () => api.get<ScraperSource[]>("/scrapers/sources"),
    refetchInterval: (overview?.runningCount ?? 0) > 0 ? 4000 : false,
  });

  const { data: runs } = useQuery({
    queryKey: ["scraper-runs"],
    queryFn: () => api.get<ScraperRun[]>("/scrapers/runs?take=15"),
    refetchInterval: (overview?.runningCount ?? 0) > 0 ? 4000 : false,
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

  return (
    <div>
      <PageHeader
        title="Lead capture"
        subtitle="Apify actors that find your kind of business and file them straight into the pipeline."
        action={
          <div className="flex items-center gap-3">
            <Link
              to="/leads"
              className="inline-flex items-center gap-2 border border-ink/20 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition hover:border-ink"
            >
              View leads
            </Link>
            <Button onClick={() => setPicking(true)}>Add source</Button>
          </div>
        }
      />

      <ApifyConnection />

      {overview && (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Captured this week"
            value={overview.capturedThisWeek}
            sub={`${overview.capturedTotal} in total`}
          />
          <StatTile
            label="Sources"
            value={`${overview.enabledCount}/${overview.sourceCount}`}
            sub={`${overview.scheduledCount} on a daily schedule`}
          />
          <StatTile
            label="Next scheduled run"
            value={overview.nextRun ? <RelativeTime value={overview.nextRun.at} /> : "—"}
            sub={overview.nextRun?.name ?? "Nothing scheduled"}
          />
          <StatTile
            label="Running now"
            value={overview.runningCount}
            sub={overview.lastRun ? <>last run <RelativeTime value={overview.lastRun.startedAt} /></> : "No runs yet"}
          />
        </div>
      )}

      <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">Sources</h2>
      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : !sources || sources.length === 0 ? (
        <EmptyState
          message="No lead sources yet. Start from a template — the Google Maps one is set up for exactly the businesses Dakyworld sells to."
          action={<Button onClick={() => setPicking(true)}>Add your first source</Button>}
        />
      ) : (
        <div className="grid gap-3">
          {sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
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

      <h2 className="mb-3 mt-10 font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">Recent runs</h2>
      <RunsTable runs={runs ?? []} onStop={(id) => stop.mutate(id)} />

      <SourcePicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(draft) => {
          setPicking(false);
          setEditing(draft);
        }}
      />
      <SourceEditor draft={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

// --- Connection ------------------------------------------------------------

/**
 * A read-out, not a form. The Apify token is edited on the Settings page along
 * with every other credential — duplicating the form here would mean two places
 * to keep in step and two places to look when something is wrong.
 */
function ApifyConnection() {
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<AppSettings>("/settings"),
  });

  const apify = data?.apify;

  return (
    <Card className="mb-8">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <StatusDot tone={apify?.connected ? "ok" : apify?.token ? "bad" : "idle"} />
          <h2 className="font-serif text-lg">Apify connection</h2>
        </div>
        <p className="min-w-[16rem] flex-1 text-sm text-ink/60">
          {apify?.connected ? (
            <>
              Connected as <strong>{apify.account?.username ?? "your account"}</strong>
              {apify.account?.plan?.id && <> on the {apify.account.plan.id} plan</>}.
            </>
          ) : apify?.error ? (
            <span className="text-red-600">{apify.error}</span>
          ) : (
            <>Scrapers can&rsquo;t run until an Apify API token is added.</>
          )}
        </p>
        <Link
          to="/settings?tab=capture"
          className="inline-flex items-center gap-2 border border-ink/20 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition hover:border-ink"
        >
          {apify?.connected ? "Manage in Settings" : "Add a token"}
        </Link>
      </div>
    </Card>
  );
}

// --- Source card -----------------------------------------------------------

function SourceCard({
  source,
  onRun,
  running,
  runError,
  onToggle,
  onEdit,
  onDelete,
}: {
  source: ScraperSource;
  onRun: () => void;
  running: boolean;
  runError: string | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const lastRun = source.runs?.[0];
  const isLive = lastRun && (lastRun.status === "RUNNING" || lastRun.status === "QUEUED");

  return (
    <div className={`border border-ink/10 bg-white p-5 ${source.enabled ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot tone={isLive ? "live" : source.enabled ? (source.scheduleEnabled ? "ok" : "idle") : "idle"} />
            <h3 className="font-serif text-lg">{source.name}</h3>
            <Badge tone="muted">{source.leadSource.replace(/_/g, " ")}</Badge>
            {!source.enabled && <Badge>paused</Badge>}
          </div>
          <p className="mt-1 text-sm text-ink/60">{source.description || "No description"}</p>
          <p className="mt-1 font-mono text-[11px] text-ink/40">
            <a
              href={`https://apify.com/${source.actorId}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-bronze hover:underline"
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

      <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-ink/5 pt-4 text-sm sm:grid-cols-4">
        <Stat label="Schedule">
          {source.scheduleEnabled && source.scheduleTimes.length > 0 ? (
            <span>
              {source.scheduleTimes.join(", ")}{" "}
              <span className="text-ink/40">{source.timezone.replace("_", " ")}</span>
            </span>
          ) : (
            <span className="text-ink/40">Manual only</span>
          )}
        </Stat>
        <Stat label="Next run">
          {source.enabled && source.scheduleEnabled ? <RelativeTime value={source.nextRunAt} /> : <span className="text-ink/40">—</span>}
        </Stat>
        <Stat label="Last run">
          {lastRun ? (
            <span className="flex items-center gap-2">
              <RunStatusBadge status={lastRun.status} />
              <RelativeTime value={lastRun.startedAt} />
            </span>
          ) : (
            <span className="text-ink/40">Never</span>
          )}
        </Stat>
        <Stat label="Leads captured">
          <Link to={`/leads?scraperSourceId=${source.id}`} className="hover:text-bronze hover:underline">
            {source._count?.leads ?? 0}
          </Link>
        </Stat>
      </dl>

      {runError && <p className="mt-3 text-sm text-red-600">{runError}</p>}
      {lastRun?.error && lastRun.status === "FAILED" && (
        <p className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{lastRun.error}</p>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

// --- Runs ------------------------------------------------------------------

function RunStatusBadge({ status }: { status: ScraperRun["status"] }) {
  const tone = status === "SUCCEEDED" ? "gold" : status === "RUNNING" || status === "QUEUED" ? "default" : "muted";
  return <Badge tone={tone}>{status.replace("_", " ").toLowerCase()}</Badge>;
}

function RunsTable({ runs, onStop }: { runs: ScraperRun[]; onStop: (id: string) => void }) {
  if (runs.length === 0) return <EmptyState message="No runs yet." />;

  return (
    <div className="overflow-x-auto border border-ink/10 bg-white">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead>
          <tr className="border-b border-ink/10 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Started</th>
            <th className="px-4 py-3">Trigger</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Found</th>
            <th className="px-4 py-3">New</th>
            <th className="px-4 py-3">Enriched</th>
            <th className="px-4 py-3">Filtered</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-b border-ink/5 last:border-0 align-top">
              <td className="px-4 py-3">
                <div className="font-medium">{run.source?.name ?? "—"}</div>
                {run.error && <div className="mt-0.5 max-w-md text-xs text-red-600">{run.error}</div>}
              </td>
              <td className="px-4 py-3 text-xs text-ink/50">
                <RelativeTime value={run.startedAt} />
              </td>
              <td className="px-4 py-3">
                <Badge tone="muted">{run.trigger.toLowerCase()}</Badge>
              </td>
              <td className="px-4 py-3">
                <RunStatusBadge status={run.status} />
              </td>
              <td className="px-4 py-3">{run.itemsFetched}</td>
              <td className="px-4 py-3 font-medium">{run.leadsCreated}</td>
              <td className="px-4 py-3 text-ink/60">{run.leadsUpdated}</td>
              <td className="px-4 py-3 text-ink/60">{run.filtered}</td>
              <td className="px-4 py-3">
                {(run.status === "RUNNING" || run.status === "QUEUED") && (
                  <Button size="sm" variant="ghost" onClick={() => onStop(run.id)}>
                    Stop
                  </Button>
                )}
                {run.status === "SUCCEEDED" && run.leadsCreated > 0 && (
                  <Link
                    to={`/leads?scraperRunId=${run.id}`}
                    className="font-mono text-[10px] uppercase tracking-[.12em] text-bronze"
                  >
                    View
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

// --- Add a source ----------------------------------------------------------

function SourcePicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (draft: SourceDraft) => void }) {
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");

  const { data: templates } = useQuery({
    queryKey: ["scraper-templates"],
    queryFn: () => api.get<ScraperTemplate[]>("/scrapers/templates"),
    enabled: open,
  });

  const { data: catalog, isFetching } = useQuery({
    queryKey: ["scraper-catalog", submitted],
    queryFn: () => api.get<{ store: ApifyActorSummary[]; mine: ApifyActorSummary[] }>(
      `/scrapers/catalog?search=${encodeURIComponent(submitted)}`,
    ),
    enabled: open,
  });

  const fromTemplate = (template: ScraperTemplate): SourceDraft => ({
    ...BLANK_SOURCE,
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
    ...BLANK_SOURCE,
    name: actor.title ?? actor.name,
    actorId: actor.fullName,
    description: actor.description ?? "",
    preset: "AUTO",
  });

  return (
    <Drawer open={open} onClose={onClose} wide title="Add a lead source" subtitle="Start from a template, or use any actor on Apify">
      <div className="space-y-8">
        <section>
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">Templates</h3>
          <div className="grid gap-3">
            {templates?.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onPick(fromTemplate(template))}
                className="border border-ink/10 bg-white p-4 text-left transition hover:border-ink/40"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{template.name}</span>
                  <Badge tone="gold">{template.headline}</Badge>
                </div>
                <p className="mt-1 text-sm text-ink/60">{template.description}</p>
                <p className="mt-1 font-mono text-[11px] text-ink/40">{template.actorId}</p>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">Any actor on Apify</h3>
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
              placeholder="Search the Apify Store — “linkedin”, “instagram”, “yellow pages”…"
              className="input"
            />
            <Button type="submit" variant="secondary">
              {isFetching ? "Searching…" : "Search"}
            </Button>
          </form>

          {catalog?.mine && catalog.mine.length > 0 && (
            <>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">Your own actors</p>
              <ActorList actors={catalog.mine} onPick={(actor) => onPick(fromActor(actor))} />
            </>
          )}

          <ActorList actors={catalog?.store ?? []} onPick={(actor) => onPick(fromActor(actor))} />

          <button
            type="button"
            onClick={() => onPick(BLANK_SOURCE)}
            className="mt-4 font-mono text-[11px] uppercase tracking-[.12em] text-bronze"
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
          className="flex items-start gap-3 border border-ink/10 bg-white p-3 text-left transition hover:border-ink/40"
        >
          {actor.pictureUrl && <img src={actor.pictureUrl} alt="" className="h-8 w-8 shrink-0 object-contain" />}
          <span className="min-w-0">
            <span className="block font-medium">{actor.title ?? actor.name}</span>
            <span className="mt-0.5 block truncate text-xs text-ink/50">{actor.description}</span>
            <span className="mt-0.5 block font-mono text-[10px] text-ink/40">
              {actor.fullName}
              {actor.stats?.totalRuns ? ` · ${Intl.NumberFormat().format(actor.stats.totalRuns)} runs` : ""}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
