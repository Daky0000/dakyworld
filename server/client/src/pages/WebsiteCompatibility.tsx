import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Badge, Button } from "../components/ui";
import { useWebsiteSites } from "../components/WebsiteGuard";

/**
 * What this editor can do with a particular website, before anybody is told it
 * can.
 *
 * The report is written to be read out loud in an onboarding conversation. Every
 * line says what it means for the person who will be editing rather than what it
 * is technically — "menus driven by JavaScript will not behave here as they do
 * on the live site" rather than "scripts are stripped in the preview sandbox" —
 * because the audience for this screen is the one who has to be comfortable with
 * the answer, not the one who wrote the page.
 */

type Grade = "editable" | "limited" | "developer" | "unsupported";

type Report = {
  site: { id: string; name: string; publicUrl: string; repo: string | null };
  rating: string;
  grade: Grade;
  readiness: "CONNECTED" | "NEEDS_REVIEW" | "READY" | "LIMITED" | "PUBLISH_BLOCKED";
  findings: Array<{ code: string; grade: Grade; title: string; detail: string; count: number }>;
  pages: Array<{ pageId: string; title: string; path: string; editable: number; grade: Grade; unreadable?: string; findings: Array<{ code: string; title: string; grade: Grade; count: number }> }>;
  totals: { pages: number; readable: number; editable: number; text: number; richtext: number; link: number; button: number; image: number; container: number };
  publishing: { repository: boolean; credentials: boolean; branch: string | null; blocked: string | null };
  truncated: number;
};

const GRADE_LABEL: Record<Grade, string> = {
  editable: "Fully editable",
  limited: "Editable, with limits",
  developer: "Developer-managed",
  unsupported: "Not supported",
};

const GRADE_TONE: Record<Grade, "positive" | "warn" | "muted" | "danger"> = {
  editable: "positive",
  limited: "warn",
  developer: "muted",
  unsupported: "danger",
};

const READINESS: Record<Report["readiness"], { label: string; tone: "positive" | "warn" | "muted" | "danger"; detail: string }> = {
  READY: { label: "Ready for editing", tone: "positive", detail: "Everything on this site can be edited here and published." },
  LIMITED: { label: "Ready, with limits", tone: "warn", detail: "Editable and publishable, with parts that stay with whoever writes the code. Go through those below before handing it over." },
  NEEDS_REVIEW: { label: "Needs review", tone: "warn", detail: "Some pages cannot be carried by this editor. Decide what happens to them before a client is given access." },
  PUBLISH_BLOCKED: { label: "Publishing blocked", tone: "danger", detail: "Changes can be made and saved, but nothing can go live until this is fixed." },
  CONNECTED: { label: "Connected, not scanned", tone: "muted", detail: "No pages have been scanned yet, so there is nothing to judge." },
};

export function WebsiteCompatibility() {
  const [params, setParams] = useSearchParams();
  const sites = useWebsiteSites();
  const [expanded, setExpanded] = useState<string | null>(null);

  const siteId = params.get("site") ?? sites.data?.[0]?.id ?? "";
  const report = useQuery({
    queryKey: ["website", "compatibility", siteId],
    enabled: Boolean(siteId),
    queryFn: () => api.get<Report>(`/website/sites/${siteId}/compatibility`),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl tracking-[-.02em]">Compatibility</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            What this editor can and cannot do with a website, page by page. Worth going through before a client is given access to one.
          </p>
        </div>
        {(sites.data?.length ?? 0) > 1 && (
          <label className="text-xs text-muted">
            <span className="mb-1 block">Website</span>
            <select
              className="h-9 rounded-xl border border-line bg-white px-2 text-sm text-ink"
              value={siteId}
              onChange={(event) => setParams({ site: event.target.value })}
            >
              {sites.data?.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {report.isLoading && <p className="text-sm text-muted">Reading every page…</p>}
      {report.isError && (
        <p className="rounded-2xl border border-warn-line bg-warn-surface p-4 text-sm text-warn-text">
          {report.error instanceof ApiError ? report.error.message : "That website could not be analysed."}
        </p>
      )}

      {report.data && (
        <>
          <div className="rounded-2xl border border-line bg-white p-5">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={READINESS[report.data.readiness].tone}>{READINESS[report.data.readiness].label}</Badge>
              <span className="text-sm font-semibold text-ink">Compatibility: {report.data.rating}</span>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted">{READINESS[report.data.readiness].detail}</p>

            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Pages", value: report.data.totals.pages },
                { label: "Read", value: report.data.totals.readable },
                { label: "Editable things", value: report.data.totals.editable },
                { label: "Pictures", value: report.data.totals.image },
              ].map((entry) => (
                <div key={entry.label} className="rounded-xl bg-sunken px-3 py-2">
                  <dt className="text-[11px] uppercase tracking-[.08em] text-muted">{entry.label}</dt>
                  <dd className="font-display text-lg tracking-[-.02em]">{entry.value}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-4 space-y-1.5 text-sm">
              <Line ok={report.data.publishing.repository} text={report.data.site.repo ? `Repository ${report.data.site.repo}` : "No repository connected"} />
              <Line ok={report.data.publishing.credentials} text="GitHub access for publishing" />
              <Line ok={!report.data.publishing.blocked} text={report.data.publishing.blocked ?? `Publishing to ${report.data.publishing.branch ?? "the default branch"}`} />
            </div>

            {report.data.truncated > 0 && (
              <p className="mt-3 text-xs text-muted">The first 60 pages were analysed; {report.data.truncated} more were not.</p>
            )}
          </div>

          {report.data.findings.length > 0 && (
            <div className="rounded-2xl border border-line bg-white p-5">
              <h2 className="font-display text-base tracking-[-.02em]">What to know before handing it over</h2>
              <ul className="mt-3 space-y-3">
                {report.data.findings.map((finding) => (
                  <li key={finding.code} className="flex gap-3">
                    <span className="mt-0.5 shrink-0">
                      <Badge tone={GRADE_TONE[finding.grade]}>{GRADE_LABEL[finding.grade]}</Badge>
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">
                        {finding.title}
                        <span className="ml-2 font-normal text-muted">×{finding.count}</span>
                      </p>
                      <p className="text-sm leading-relaxed text-muted">{finding.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-2xl border border-line bg-white p-5">
            <h2 className="font-display text-base tracking-[-.02em]">Page by page</h2>
            <ul className="mt-3 divide-y divide-line">
              {report.data.pages.map((page) => (
                <li key={page.pageId} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={GRADE_TONE[page.grade]}>{GRADE_LABEL[page.grade]}</Badge>
                    <Link to={`/website/pages/${page.pageId}`} className="text-sm font-semibold text-ink hover:underline">
                      {page.title}
                    </Link>
                    <span className="font-mono text-[11px] text-muted">{page.path}</span>
                    <span className="ml-auto text-xs text-muted">{page.editable} editable</span>
                    {page.findings.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === page.pageId ? null : page.pageId)}
                        className="text-xs text-blue underline-offset-2 hover:underline"
                      >
                        {expanded === page.pageId ? "Hide" : `${page.findings.length} note${page.findings.length === 1 ? "" : "s"}`}
                      </button>
                    )}
                  </div>
                  {page.unreadable && <p className="mt-1 text-xs text-warn-text">{page.unreadable}</p>}
                  {expanded === page.pageId && (
                    <ul className="mt-1.5 space-y-1 text-xs text-muted">
                      {page.findings.map((finding) => (
                        <li key={finding.code}>
                          {finding.title} <span className="text-faint">×{finding.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {report.data.pages.length === 0 && (
              <p className="mt-2 text-sm text-muted">
                No pages have been scanned yet. Open the site and scan it first.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void report.refetch()}>
              Read the pages again
            </Button>
            <Link to="/website/sites">
              <Button variant="ghost" size="sm">
                Back to the site
              </Button>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function Line({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p className={`flex items-start gap-2 ${ok ? "text-ink" : "text-warn-text"}`}>
      <span aria-hidden className="mt-0.5 shrink-0 font-mono text-xs">
        {ok ? "Pass" : "Review"}
      </span>
      <span>{text}</span>
    </p>
  );
}
