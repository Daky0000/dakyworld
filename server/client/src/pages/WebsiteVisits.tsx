import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { setPageTitle } from "../lib/surface";
import { useWebsiteSites } from "../components/WebsiteGuard";
import { EmptyState, PageHeader } from "../components/ui";

/**
 * How many people visit a website DakyX hosts, and where they came from
 * (server: services/websiteVisits.ts). Counted as pages are served, so there
 * is no script on the customer's page and no cookie banner to add for it.
 */
type Visits = {
  days: number;
  totals: { views: number; visitors: number; phoneShare: number };
  series: Array<{ day: string; views: number; visitors: number }>;
  pages: Array<{ path: string; views: number }>;
  sources: Array<{ source: string; views: number }>;
};

const RANGES = [7, 30, 90] as const;
const count = (value: number) => value.toLocaleString();
const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

function Bars({ series }: { series: Visits["series"] }) {
  const max = Math.max(1, ...series.map((point) => point.views));
  return (
    <figure className="rounded-2xl border border-line bg-white p-5">
      <figcaption className="mb-3 flex items-baseline justify-between text-xs text-muted">
        <span>Page views a day</span>
        <span>{shortDay(series[0]!.day)} – {shortDay(series[series.length - 1]!.day)}</span>
      </figcaption>
      <div className="flex h-40 items-end gap-[2px]" aria-hidden>
        {series.map((point) => (
          <div key={point.day} className="group relative flex-1">
            <div className="w-full rounded-t-[3px] bg-blue/80 transition group-hover:bg-blue" style={{ height: `${Math.max(point.views ? 4 : 0, (point.views / max) * 160)}px` }} />
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-[11px] text-white group-hover:block">
              {shortDay(point.day)}: {count(point.views)} views · {count(point.visitors)} visitors
            </span>
          </div>
        ))}
      </div>
      {/* The same numbers for somebody who cannot see the bars. */}
      <table className="sr-only">
        <caption>Page views and visitors by day</caption>
        <thead><tr><th>Day</th><th>Views</th><th>Visitors</th></tr></thead>
        <tbody>{series.map((point) => <tr key={point.day}><td>{point.day}</td><td>{point.views}</td><td>{point.visitors}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

function Ranked({ title, rows, empty }: { title: string; rows: Array<{ label: string; views: number }>; empty: string }) {
  const max = Math.max(1, ...rows.map((row) => row.views));
  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <h2 className="font-display text-base text-ink">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.label} className="relative overflow-hidden rounded-lg px-2 py-1.5 text-sm">
              <span aria-hidden className="absolute inset-y-0 left-0 rounded-lg bg-sunken" style={{ width: `${(row.views / max) * 100}%` }} />
              <span className="relative flex items-center justify-between gap-3">
                <span className="truncate text-ink">{row.label}</span>
                <span className="shrink-0 text-xs text-muted">{count(row.views)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function WebsiteVisits() {
  const [params, setParams] = useSearchParams();
  const sites = useWebsiteSites();
  const all = useMemo(() => sites.data ?? [], [sites.data]);
  const siteId = all.some((site) => site.id === params.get("site")) ? params.get("site")! : all[0]?.id;
  const site = all.find((item) => item.id === siteId);
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  useEffect(() => setPageTitle("Visitors"), []);

  const visits = useQuery({
    queryKey: ["website", "visits", siteId, days],
    enabled: Boolean(siteId && site?.hosted),
    queryFn: ({ signal }) => api.get<Visits>(`/website/sites/${encodeURIComponent(siteId!)}/visits?days=${days}`, signal),
    refetchInterval: 60_000,
  });

  if (sites.isLoading) return <p className="text-sm text-muted" role="status">Loading…</p>;
  if (!site) return <div><PageHeader title="Visitors" /><EmptyState message="Your websites will appear here once one is added." /></div>;

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Visitors"
        eyebrow={site.name}
        subtitle="Counted on our server as your pages are served: no cookies, no tracking script on your website, and no visitor's address kept."
      />
      <div className="flex flex-wrap items-center gap-3">
        {all.length > 1 && (
          <label className="text-xs text-muted">
            <span className="sr-only">Website</span>
            <select className="input" value={siteId} onChange={(event) => setParams({ site: event.target.value })}>
              {all.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        )}
        <div role="group" aria-label="Period" className="flex gap-1 rounded-xl border border-line bg-white p-1">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={days === range}
              onClick={() => setDays(range)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${days === range ? "bg-ink text-cream" : "text-muted hover:text-ink"}`}
            >
              {range} days
            </button>
          ))}
        </div>
      </div>

      {!site.hosted ? (
        <EmptyState message="Visits are counted for websites DakyX hosts. This one is served from somewhere else — its developer's host or GitHub — so its visitors never reach us to be counted." />
      ) : visits.isLoading ? (
        <p className="text-sm text-muted" role="status">Loading visits…</p>
      ) : visits.error ? (
        <p role="alert" className="rounded-xl border border-danger-line bg-danger-surface p-3 text-sm text-danger-text">{visits.error instanceof ApiError ? visits.error.message : "The visits could not be loaded."}</p>
      ) : visits.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "Page views", value: count(visits.data.totals.views) },
              { label: "Visitors", value: count(visits.data.totals.visitors), hint: "Each counted once a day, however many pages they saw." },
              { label: "On a phone", value: `${visits.data.totals.phoneShare}%`, hint: "Of page views." },
            ].map((card) => (
              <div key={card.label} className="rounded-2xl border border-line bg-white p-5">
                <p className="text-xs text-muted">{card.label}</p>
                <p className="mt-1 font-display text-3xl font-semibold tracking-[-.03em] text-ink">{card.value}</p>
                {card.hint && <p className="mt-1 text-[11px] text-muted">{card.hint}</p>}
              </div>
            ))}
          </div>
          {visits.data.totals.views === 0 ? (
            <EmptyState message="No visits yet in this period. Share your website's address — counts appear here within a minute of somebody opening a page." />
          ) : (
            <>
              <Bars series={visits.data.series} />
              <div className="grid gap-5 lg:grid-cols-2">
                <Ranked title="Most-viewed pages" rows={visits.data.pages.map((row) => ({ label: row.path, views: row.views }))} empty="No pages viewed yet." />
                <Ranked title="Where visitors came from" rows={visits.data.sources.map((row) => ({ label: row.source, views: row.views }))} empty="Nobody has arrived from anywhere yet." />
              </div>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
