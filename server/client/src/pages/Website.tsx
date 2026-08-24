import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { SitePageRow, SiteSummary } from "../lib/types";
import { Badge, Button, EmptyState, PageHeader, RelativeTime, Table } from "../components/ui";

/**
 * Choose a page to edit.
 *
 * The whole screen is one decision, so it is one list. No site switcher appears
 * until there is a second site to switch to — a dropdown with one entry is a
 * control that teaches somebody the wrong thing about how many sites they have.
 *
 * Hidden pages are hidden by default and counted rather than listed. They are
 * the files a site's own sitemap does not mention — an archived draft, a plan
 * document, the 404 — and putting them in front of a client alongside the real
 * pages is how somebody ends up editing a page nobody can reach.
 */
export function Website() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [siteId, setSiteId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: () => api.get<SiteSummary[]>("/website/sites") });

  const current = sites.data?.find((site) => site.id === siteId) ?? sites.data?.[0] ?? null;

  const pages = useQuery({
    queryKey: ["website", "pages", current?.id],
    enabled: Boolean(current),
    queryFn: () => api.get<{ site: SiteSummary; pages: SitePageRow[] }>(`/website/sites/${current!.id}/pages`),
  });

  const scan = useMutation({
    mutationFn: () => api.post<{ found: number; added: number; missing: string[] }>(`/website/sites/${current!.id}/scan`),
    onSuccess: (result) => {
      setScanError(null);
      setScanResult(
        result.added > 0
          ? `Found ${result.found} page${result.found === 1 ? "" : "s"}, ${result.added} of them new.`
          : `Found ${result.found} page${result.found === 1 ? "" : "s"}. Nothing new.`,
      );
      void qc.invalidateQueries({ queryKey: ["website"] });
    },
    onError: (err) => {
      setScanResult(null);
      setScanError(err instanceof ApiError ? err.message : "The scan did not finish.");
    },
  });

  if (sites.isLoading) return <div className="text-sm text-muted">Loading…</div>;

  if (!current) {
    return (
      <div>
        <PageHeader title="Edit website" subtitle="The websites this system can publish to." />
        <EmptyState message="No website has been added yet." />
      </div>
    );
  }

  const all = pages.data?.pages ?? [];
  const visible = all.filter((page) => showHidden || page.status === "LIVE");
  const hiddenCount = all.length - all.filter((page) => page.status === "LIVE").length;
  const draftCount = all.filter((page) => page.hasDraft).length;

  return (
    <div>
      <PageHeader
        title="Edit website"
        eyebrow={current.name}
        subtitle={`Choose a page and change its words, links and pictures. ${
          current.repo ? "Publishing commits the page and the live site rebuilds." : "No repository is connected, so pages can be edited but not published."
        }`}
        action={
          can("website.manage") ? (
            <Button variant="secondary" onClick={() => scan.mutate()} disabled={scan.isPending}>
              {scan.isPending ? "Looking…" : "Look for new pages"}
            </Button>
          ) : undefined
        }
      />

      {(sites.data?.length ?? 0) > 1 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {sites.data!.map((site) => (
            <button
              key={site.id}
              type="button"
              onClick={() => setSiteId(site.id)}
              className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] ${
                site.id === current.id ? "border-ink bg-ink text-cream" : "border-ink/20 text-ink/60 hover:border-ink/40"
              }`}
            >
              {site.name}
            </button>
          ))}
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted">
        <span>
          <a href={current.publicUrl} target="_blank" rel="noreferrer" className="text-ink underline-offset-2 hover:underline">
            {current.publicUrl.replace(/^https?:\/\//, "")}
          </a>
        </span>
        <span>{current.repo ? `${current.repo} · ${current.branch}` : "No repository connected"}</span>
        {draftCount > 0 && <span className="text-ink">{draftCount} page{draftCount === 1 ? "" : "s"} with unpublished changes</span>}
      </div>

      {scanResult && <p className="mb-4 rounded-2xl border border-line bg-white p-4 text-sm text-ink">{scanResult}</p>}
      {scanError && <p className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">{scanError}</p>}

      {pages.isLoading ? (
        <div className="text-sm text-muted">Loading pages…</div>
      ) : all.length === 0 ? (
        <EmptyState
          message="No pages here yet. Looking for pages reads the site's repository — or its sitemap — and lists what it finds."
          action={
            can("website.manage") ? (
              <Button onClick={() => scan.mutate()} disabled={scan.isPending}>
                {scan.isPending ? "Looking…" : "Look for pages"}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[.1em] text-muted">
                <th className="px-5 py-3 font-bold">Page</th>
                <th className="px-5 py-3 font-bold">Address</th>
                <th className="px-5 py-3 font-bold">State</th>
                <th className="px-5 py-3 font-bold">Last published</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {visible.map((page) => (
                <tr key={page.id} className="border-b border-line/60 last:border-0">
                  <td className="px-5 py-4">
                    <Link to={`/website/pages/${page.id}`} className="font-semibold text-ink hover:underline">
                      {page.title}
                    </Link>
                    <div className="text-xs text-muted">{page.filePath}</div>
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-muted">{page.path}</td>
                  <td className="px-5 py-4">
                    {page.status === "HIDDEN" ? (
                      <Badge tone="muted">Hidden</Badge>
                    ) : page.hasDraft ? (
                      <div>
                        <Badge tone="warn">Unpublished changes</Badge>
                        {page.draftSavedBy && <div className="mt-1 text-xs text-muted">by {page.draftSavedBy.name}</div>}
                      </div>
                    ) : (
                      // "Up to date" rather than "Published": a page can be
                      // identical to what is live and have been published from
                      // somewhere else, which is true of every page here today.
                      <Badge tone="muted">Up to date</Badge>
                    )}
                  </td>
                  <td className="px-5 py-4 text-xs text-muted">
                    {page.lastPublishedAt ? <RelativeTime value={page.lastPublishedAt} /> : "Never from here"}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      <a href={page.url} target="_blank" rel="noreferrer">
                        <Button variant="ghost" size="sm">
                          View
                        </Button>
                      </a>
                      <Link to={`/website/pages/${page.id}`}>
                        <Button size="sm">Edit</Button>
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowHidden((value) => !value)}
              className="mt-4 text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              {showHidden ? "Hide" : "Show"} {hiddenCount} file{hiddenCount === 1 ? "" : "s"} that {hiddenCount === 1 ? "is" : "are"} not a listed page
            </button>
          )}
        </>
      )}
    </div>
  );
}
