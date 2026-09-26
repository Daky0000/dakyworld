import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SiteSummary, ClientActivityResponse } from "../lib/types";
import { Badge, PageHeader } from "./ui";

const CATEGORIES = [
  { id: "all", label: "All Activity" },
  { id: "content", label: "Pages & Edits" },
  { id: "ai", label: "AI Assistant" },
  { id: "media", label: "Media & Assets" },
  { id: "billing", label: "Billing & Invoices" },
  { id: "settings", label: "Settings & Domains" },
] as const;

export function WebsiteAuditTrail() {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedSiteId, setSelectedSiteId] = useState<string>("all");

  const sites = useQuery({
    queryKey: ["website", "sites"],
    queryFn: () => api.get<SiteSummary[]>("/website/sites"),
  });

  const activity = useQuery({
    queryKey: ["website", "activity", selectedCategory, selectedSiteId],
    queryFn: () => {
      const params = new URLSearchParams();
      if (selectedCategory !== "all") params.set("category", selectedCategory);
      if (selectedSiteId !== "all") params.set("siteId", selectedSiteId);
      const query = params.toString();
      return api.get<ClientActivityResponse>(`/website/activity${query ? `?${query}` : ""}`);
    },
  });

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "ai":
        return "🤖";
      case "content":
        return "📄";
      case "media":
        return "🖼️";
      case "billing":
        return "💳";
      case "settings":
        return "⚙️";
      case "team":
        return "👥";
      default:
        return "⚡";
    }
  };

  return (
    <div className="mx-auto max-w-4xl pb-16">
      <PageHeader
        title="Workspace Activity"
        subtitle="Chronological audit trail of website edits, AI assistant runs, publishes, assets, and billing events."
      />

      {/* Filters Strip */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        {/* Category Tabs */}
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategory(cat.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                selectedCategory === cat.id
                  ? "bg-white text-ink shadow-2xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Site Filter Dropdown */}
        {Boolean(sites.data?.length && sites.data.length > 1) && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Website:</span>
            <select
              value={selectedSiteId}
              onChange={(e) => setSelectedSiteId(e.target.value)}
              className="h-8 rounded-lg border border-line bg-white px-2.5 text-xs font-medium text-ink focus:outline-none"
            >
              <option value="all">All Websites</option>
              {sites.data?.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Error States */}
      {activity.error && (
        <div role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm text-danger-text">
          {(activity.error as Error).message || "Unable to load workspace activity."}
        </div>
      )}

      {/* Loading Skeleton */}
      {activity.isLoading && (
        <div className="space-y-3 py-4">
          <div className="h-16 animate-pulse rounded-2xl bg-[#EBECEF]" />
          <div className="h-16 animate-pulse rounded-2xl bg-[#EBECEF]" />
          <div className="h-16 animate-pulse rounded-2xl bg-[#EBECEF]" />
        </div>
      )}

      {/* Activity Timeline List */}
      {activity.data && (
        <div className="space-y-3">
          {activity.data.items.length === 0 ? (
            <div className="rounded-2xl border border-line bg-white p-12 text-center">
              <span className="text-3xl">📝</span>
              <h3 className="mt-3 font-semibold text-ink text-sm">No activity recorded for this filter</h3>
              <p className="mt-1 text-xs text-muted max-w-sm mx-auto">
                Edits, content changes, AI assistant prompts, and invoice settlements will be recorded in real-time.
              </p>
            </div>
          ) : (
            activity.data.items.map((event) => (
              <article
                key={event.id}
                className="flex items-start gap-3.5 rounded-2xl border border-line bg-white p-4 shadow-2xs hover:border-[#1E293B]/30 transition"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cream text-base">
                  {getCategoryIcon(event.category)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-xs text-ink">{event.title}</p>
                    <span className="text-[11px] text-muted whitespace-nowrap">
                      {new Date(event.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <span className="font-medium text-slate-700">{event.actorName}</span>
                    <span>·</span>
                    <span className="rounded bg-cream px-1.5 py-0.5 font-medium">{event.siteName || "Website"}</span>
                    <span>·</span>
                    <Badge tone={event.badgeTone}>{event.kind.toLowerCase().replaceAll("_", " ")}</Badge>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      )}
    </div>
  );
}
