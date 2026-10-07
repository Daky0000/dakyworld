import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { SitePageRow, SiteSummary } from "../lib/types";
import { startTour } from "../lib/tours";
import { tourSeen, updateUiState, useUiState } from "../lib/uiState";

/**
 * The first things worth doing with a new website, ticked off by what has
 * actually happened rather than by somebody pressing "done".
 *
 * Every line is read from the site or the account: a change counts when a
 * draft or a publish exists, the domain when it has verified, the team when
 * somebody else is a member. The list it replaced was five boxes in this
 * browser's storage, each ticked by hand and each describing a feature in
 * words it did not have ("zero-downtime", drag to reorder).
 */
type Item = { id: string; title: string; done: boolean; action?: { label: string; to?: string; onClick?: () => void } };

export function GettingStarted({ site, pages }: { site: SiteSummary; pages: SitePageRow[] }) {
  const { user } = useAuth();
  const ui = useUiState();
  const canInvite = Boolean(site.capabilities?.members);
  const members = useQuery({
    queryKey: ["website", "members", site.id],
    enabled: canInvite,
    queryFn: ({ signal }) => api.get<{ members: unknown[] }>(`/website/sites/${encodeURIComponent(site.id)}/members`, signal),
    staleTime: 60_000,
  });
  if (ui.checklist?.hidden) return null;

  const firstPage = site.firstPageId ?? pages.find((page) => page.status === "LIVE")?.id ?? pages[0]?.id;
  const withDraft = pages.find((page) => page.hasDraft)?.id;
  const changed = (site.draftCount ?? 0) > 0 || Boolean(site.lastPublishedAt) || Boolean(withDraft);
  const editorTourSeen = tourSeen(ui, "editor");
  const items: Item[] = [
    { id: "site", title: "Add your website", done: true },
    {
      id: "change",
      title: "Change something on a page",
      done: changed,
      action: firstPage ? { label: editorTourSeen ? "Open a page" : "Open a page with the tour", to: `/website/pages/${firstPage}${editorTourSeen ? "" : "?walkthrough=1"}` } : undefined,
    },
    {
      id: "publish",
      title: site.hosted ? "Publish it — it is live straight away" : "Publish it",
      done: Boolean(site.lastPublishedAt),
      action: withDraft || firstPage ? { label: "Open the page", to: `/website/pages/${withDraft ?? firstPage}` } : undefined,
    },
  ];
  if (canInvite) {
    items.push({
      id: "team",
      title: "Invite somebody to help",
      done: (members.data?.members.length ?? 0) > 1,
      action: { label: "Invite", to: "/website/team" },
    });
  }
  if (site.hosted && site.capabilities?.manage) {
    items.push({ id: "domain", title: "Use your own domain", done: Boolean(site.customDomain), action: { label: "Set it up", to: "/website/settings" } });
  }
  items.push({ id: "two-step", title: "Turn on two-step sign-in", done: Boolean(user?.twoFactorEnabled), action: { label: "Turn it on", to: "/website/account" } });
  items.push({
    id: "tour",
    title: "Take the two-minute tour of this screen",
    done: tourSeen(ui, "workspace"),
    action: { label: "Start", onClick: () => startTour("workspace") },
  });

  const done = items.filter((item) => item.done).length;
  if (done === items.length) return null;

  return (
    <section aria-labelledby="getting-started" className="mb-6 rounded-2xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="getting-started" className="font-display text-lg text-ink">Getting started</h2>
        <span className="text-xs text-muted">{done} of {items.length} done</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
        <div className="h-full rounded-full bg-blue transition-all" style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
      </div>
      <ul className="mt-4 divide-y divide-line">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span className={`flex items-center gap-2.5 text-sm ${item.done ? "text-muted line-through decoration-line-strong" : "text-ink"}`}>
              <span
                aria-hidden
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${item.done ? "border-positive-line bg-positive-surface text-positive-text" : "border-line-strong"}`}
              >
                {item.done ? "✓" : ""}
              </span>
              <span>
                {item.title}
                <span className="sr-only">{item.done ? " — done" : " — not done yet"}</span>
              </span>
            </span>
            {!item.done && item.action && (
              item.action.to ? (
                <Link to={item.action.to} className="text-xs font-semibold text-blue hover:underline">{item.action.label}</Link>
              ) : (
                <button type="button" onClick={item.action.onClick} className="text-xs font-semibold text-blue hover:underline">{item.action.label}</button>
              )
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="mt-3 text-xs text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => updateUiState({ checklist: { hidden: true } })}>
        Hide this list
      </button>
    </section>
  );
}
