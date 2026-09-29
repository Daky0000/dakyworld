import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui";
import {
  IconCheck,
  IconCopy,
  IconDesktop,
  IconExternalLink,
  IconEye,
  IconGlobe,
  IconLock,
  IconSearch,
  IconShieldCheck,
  IconSparkles,
  IconUsers,
} from "../components/WebsiteIcons";

export type FreelancerClientSummary = {
  clientId: string;
  clientName: string;
  companyName: string;
  contactEmail: string | null;
  liveSite: {
    id: string;
    name: string;
    slug: string;
    publicUrl: string;
    pagesCount: number;
    lastPublishedAt: string | null;
    lastDraftEditAt: string | null;
    lastEditorName: string | null;
    hasUnpublishedDrafts: boolean;
    editingBoundary: string;
  } | null;
  activeDemo: {
    id: string;
    title: string;
    slug: string;
    url: string;
    views: number;
    lastViewedAt: string | null;
    status: string;
    expiresAt: string | null;
    isExpired: boolean;
    isProtected: boolean;
  } | null;
  pendingApproval: {
    id: string;
    token: string;
    pageTitle: string;
    shareUrl: string;
    status: string;
    createdAt: string;
  } | null;
  recentViewsCount: number;
  totalDwellMinutes: number;
};

export type FreelancerWorkspaceOverview = {
  totalClients: number;
  activeSites: number;
  activeDemos: number;
  pendingApprovalsCount: number;
  clients: FreelancerClientSummary[];
};

export function FreelancerWorkspace() {
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ["freelancer-workspace", "overview"],
    queryFn: ({ signal }) => api.get<FreelancerWorkspaceOverview>("/freelancer-workspace/overview", signal),
  });

  const data = overview.data;

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2500);
    } catch {}
  };

  const filteredClients = (data?.clients ?? []).filter((c) => {
    const q = search.toLowerCase();
    return (
      c.clientName.toLowerCase().includes(q) ||
      c.companyName.toLowerCase().includes(q) ||
      (c.liveSite?.name.toLowerCase().includes(q) ?? false) ||
      (c.activeDemo?.title.toLowerCase().includes(q) ?? false)
    );
  });

  return (
    <div className="space-y-6 p-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
              Freelancer & Agency Cockpit
            </h1>
            <span className="rounded-full bg-blue/10 px-2.5 py-0.5 text-xs font-semibold text-blue">
              Operating Layer
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            Unified management across client websites, pitch demos, client approvals, and editing safety boundaries.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link to="/demos">
            <Button variant="secondary" size="sm">
              <span className="inline-flex items-center gap-1.5">
                <IconSparkles size={14} />
                <span>Create Pitch Demo</span>
              </span>
            </Button>
          </Link>
          <Link to="/website/sites">
            <Button variant="accent" size="sm">
              <span className="inline-flex items-center gap-1.5">
                <IconGlobe size={14} />
                <span>Manage Live Sites</span>
              </span>
            </Button>
          </Link>
        </div>
      </div>

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-muted">
            <span className="text-xs font-semibold">Clients Managed</span>
            <IconUsers size={16} />
          </div>
          <div className="mt-2 font-display text-2xl font-bold text-ink">
            {data?.totalClients ?? 0}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-muted">
            <span className="text-xs font-semibold">Active Live Sites</span>
            <IconGlobe size={16} />
          </div>
          <div className="mt-2 font-display text-2xl font-bold text-ink">
            {data?.activeSites ?? 0}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-muted">
            <span className="text-xs font-semibold">Pitch Demos Active</span>
            <IconDesktop size={16} />
          </div>
          <div className="mt-2 font-display text-2xl font-bold text-ink">
            {data?.activeDemos ?? 0}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-muted">
            <span className="text-xs font-semibold">Pending Approvals</span>
            <IconShieldCheck size={16} />
          </div>
          <div className="mt-2 font-display text-2xl font-bold text-emerald-700">
            {data?.pendingApprovalsCount ?? 0}
          </div>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative w-full max-w-sm">
          <IconSearch size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Search by client, live site, or demo…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-line bg-white py-2 pl-9 pr-4 text-xs outline-none focus:border-blue"
          />
        </div>
        <div className="text-xs text-muted">
          Showing {filteredClients.length} of {data?.clients.length ?? 0} clients
        </div>
      </div>

      {/* Main Multi-Client Table */}
      <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line bg-sunken/40 font-semibold text-muted">
                <th className="px-4 py-3">Client / Business</th>
                <th className="px-4 py-3">Live Website</th>
                <th className="px-4 py-3">Active Demo & Engagement</th>
                <th className="px-4 py-3">Approval Sign-off</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {overview.isLoading ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-muted">
                    Loading workspace overview…
                  </td>
                </tr>
              ) : filteredClients.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-muted">
                    No clients found.
                  </td>
                </tr>
              ) : (
                filteredClients.map((client) => {
                  const site = client.liveSite;
                  const demo = client.activeDemo;
                  const approval = client.pendingApproval;

                  return (
                    <tr key={client.clientId} className="transition hover:bg-sunken/20">
                      {/* 1. Client / Business */}
                      <td className="px-4 py-3">
                        <div className="font-bold text-ink">{client.companyName}</div>
                        <div className="text-muted">{client.clientName}</div>
                        {client.contactEmail && (
                          <div className="font-mono text-[11px] text-muted">{client.contactEmail}</div>
                        )}
                      </td>

                      {/* 2. Live Website */}
                      <td className="px-4 py-3">
                        {site ? (
                          <div>
                            <div className="flex items-center gap-1.5 font-semibold text-ink">
                              <span>{site.name}</span>
                              <span
                                className={`rounded px-1.5 py-0.2 text-[10px] font-bold uppercase ${
                                  site.editingBoundary === "safe"
                                    ? "bg-emerald-100 text-emerald-800"
                                    : site.editingBoundary === "flexible"
                                      ? "bg-blue/10 text-blue"
                                      : "bg-purple-100 text-purple-800"
                                }`}
                              >
                                {site.editingBoundary} mode
                              </span>
                            </div>
                            <div className="text-[11px] text-muted">
                              {site.pagesCount} page{site.pagesCount === 1 ? "" : "s"} ·{" "}
                              {site.lastPublishedAt
                                ? `Published ${new Date(site.lastPublishedAt).toLocaleDateString()}`
                                : "Unpublished"}
                            </div>
                            {site.hasUnpublishedDrafts && (
                              <div className="mt-0.5 text-[11px] text-amber-700 font-medium">
                                Unpublished edits staged
                                {site.lastEditorName ? ` by ${site.lastEditorName}` : ""}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted italic">No site connected</span>
                        )}
                      </td>

                      {/* 3. Active Demo */}
                      <td className="px-4 py-3">
                        {demo ? (
                          <div>
                            <div className="flex items-center gap-1.5 font-semibold text-ink">
                              <span>{demo.title}</span>
                              {demo.isProtected && (
                                <span title="PIN / Password protected">
                                  <IconLock size={12} className="text-muted" />
                                </span>
                              )}
                              {demo.isExpired ? (
                                <span className="rounded bg-red-100 px-1 py-0.2 text-[10px] text-red-800">
                                  Expired
                                </span>
                              ) : (
                                <span className="rounded bg-emerald-100 px-1 py-0.2 text-[10px] text-emerald-800">
                                  Live Demo
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted">
                              {demo.views} view{demo.views === 1 ? "" : "s"} · {client.totalDwellMinutes}m dwell
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted italic">No active pitch demo</span>
                        )}
                      </td>

                      {/* 4. Approval Sign-off */}
                      <td className="px-4 py-3">
                        {approval ? (
                          <div>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                approval.status === "APPROVED"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : approval.status === "CHANGES_REQUESTED"
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-blue/10 text-blue"
                              }`}
                            >
                              {approval.status === "APPROVED"
                                ? "✓ Approved"
                                : approval.status === "CHANGES_REQUESTED"
                                  ? "Changes Requested"
                                  : "Awaiting Client Sign-off"}
                            </span>
                            <div className="mt-1 flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleCopy(`app-${approval.id}`, approval.shareUrl)}
                                className="inline-flex items-center gap-1 text-[11px] text-blue hover:underline"
                              >
                                {copiedId === `app-${approval.id}` ? (
                                  <IconCheck size={11} className="text-emerald-600" />
                                ) : (
                                  <IconCopy size={11} />
                                )}
                                <span>{copiedId === `app-${approval.id}` ? "Copied" : "Copy Review Link"}</span>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted text-[11px]">No pending reviews</span>
                        )}
                      </td>

                      {/* 5. Actions */}
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {site && (
                            <Link to={`/website/sites`}>
                              <button
                                type="button"
                                className="rounded-lg border border-line bg-white px-2 py-1 text-xs font-semibold text-ink transition hover:bg-sunken"
                              >
                                Open Editor
                              </button>
                            </Link>
                          )}
                          {demo && (
                            <a
                              href={demo.url}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-lg border border-line bg-white p-1 text-muted transition hover:text-ink hover:bg-sunken"
                              title="View Demo"
                            >
                              <IconExternalLink size={13} />
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
