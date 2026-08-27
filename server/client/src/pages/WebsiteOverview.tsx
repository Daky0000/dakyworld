import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { WebsiteOverviewData } from "../lib/types";
import { Card, EmptyState, PageHeader, RelativeTime, StatTile } from "../components/ui";

/**
 * Where the Website Builder opens.
 *
 * Two questions and nothing else: is anything waiting, and did anything just go
 * out. Both are things somebody wants to know before they start rather than
 * after — unpublished work on a page they are about to open, or a publish a
 * colleague made an hour ago that explains what they are looking at.
 *
 * There is deliberately no field count. Counting fields means fetching and
 * parsing every page of every site from its repository, which is a minute of
 * network calls to put a number on a card nobody acts on.
 */
export function WebsiteOverview() {
  const overview = useQuery({
    queryKey: ["website", "overview"],
    queryFn: () => api.get<WebsiteOverviewData>("/website/overview"),
  });

  if (overview.isLoading) return <div className="text-sm text-muted">Loading…</div>;
  if (!overview.data) return <EmptyState message="The builder could not be read just now." />;

  const { counts, recent } = overview.data;

  return (
    <div>
      <PageHeader
        title="Website Builder"
        subtitle="Client-editable websites, published from their own repositories."
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Sites"
          value={counts.sites}
          sub={
            counts.unconnected > 0 ? (
              // Said here rather than at the moment somebody presses Publish and
              // is told it cannot happen.
              <span className="text-amber-700">
                {counts.unconnected} cannot publish yet — no repository
              </span>
            ) : (
              "all connected to a repository"
            )
          }
        />
        <StatTile label="Pages" value={counts.pages} sub={counts.hidden > 0 ? `${counts.hidden} not listed publicly` : "all publicly listed"} />
        <StatTile
          label="Waiting to publish"
          value={counts.drafts}
          sub={counts.drafts === 0 ? "nothing unpublished" : "pages with unpublished changes"}
        />
        <StatTile label="Recent publishes" value={recent.length} sub={recent.length === 0 ? "nothing yet" : "most recent first"} />
      </div>

      <h2 className="mb-3 font-display text-lg tracking-[-.02em]">What went out recently</h2>
      {recent.length === 0 ? (
        <EmptyState message="Nothing has been published from here yet. Open a site, pick a page, and change something." />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {recent.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3.5 text-sm">
                <Link to={`/website/pages/${entry.page.id}`} className="font-semibold text-ink hover:underline">
                  {entry.page.title}
                </Link>
                <span className="font-mono text-xs text-muted">{entry.page.path}</span>
                <span className="text-xs text-muted">
                  {entry.changed} change{entry.changed === 1 ? "" : "s"} · version {entry.number}
                </span>
                <span className="ml-auto text-xs text-muted">
                  {entry.publishedBy?.name ? `${entry.publishedBy.name} · ` : ""}
                  <RelativeTime value={entry.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
