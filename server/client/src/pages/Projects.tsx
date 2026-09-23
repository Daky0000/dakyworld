import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Project } from "../lib/types";
import { Badge, Card, EmptyState, Loading, Money, PageHeader, StatGrid, StatTile, Table, Thead, Th, Tr, Td } from "../components/ui";

export function Projects() {
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/projects"),
  });

  const allProjects = projects ?? [];

  // Metrics
  const stats = useMemo(() => {
    let inProgress = 0;
    let delivered = 0;
    let totalHours = 0;

    for (const p of allProjects) {
      totalHours += Number(p.actualHours) || 0;
      if (p.status === "DELIVERED") delivered++;
      else inProgress++;
    }

    return {
      total: allProjects.length,
      inProgress,
      delivered,
      totalHours: totalHours.toFixed(1),
    };
  }, [allProjects]);

  // Unique statuses
  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const p of allProjects) {
      if (p.status) set.add(p.status);
    }
    return Array.from(set).sort();
  }, [allProjects]);

  // Filtered
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allProjects.filter((p) => {
      const matchSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.client.name.toLowerCase().includes(q) ||
        (p.serviceType && p.serviceType.toLowerCase().includes(q));
      const matchStatus = statusFilter === "ALL" || p.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [allProjects, search, statusFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project & Delivery"
        subtitle="Manage deliverables, service scopes, team capacity, and tracked hours across active client contracts."
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile
          label="Total Scopes"
          value={stats.total}
          sub="All historical projects"
        />
        <StatTile
          label="Active Delivery"
          value={stats.inProgress}
          sub="Currently in-flight"
        />
        <StatTile
          label="Delivered"
          value={stats.delivered}
          sub="Completed scopes"
        />
        <StatTile
          label="Total Tracked Hours"
          value={`${stats.totalHours}h`}
          sub="Actual engineering time"
        />
      </StatGrid>

      {/* Search & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <input
            type="search"
            placeholder="Search by project name, client, or service…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3.5 py-1.5 text-xs text-ink outline-none transition focus:border-blue focus:ring-2 focus:ring-blue/15"
          />
        </div>

        {statuses.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setStatusFilter("ALL")}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition  ${
                statusFilter === "ALL"
                  ? "bg-ink text-white"
                  : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              All Statuses
            </button>
            {statuses.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition  ${
                  statusFilter === st
                    ? "bg-ink text-white"
                    : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <Loading label="Loading projects" rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={
            allProjects.length === 0
              ? "No projects yet. Projects are created automatically when a proposal is accepted."
              : "No projects matched your search criteria."
          }
        />
      ) : (
        <>
          {/* Mobile View: Responsive elevated card grid (< 768px) */}
          <div className="grid gap-3.5 sm:grid-cols-2 md:hidden">
            {filtered.map((p) => (
              <Card key={p.id} interactive className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      to={`/projects/${p.id}`}
                      className="font-display text-base font-medium text-ink hover:underline"
                    >
                      {p.name}
                    </Link>
                    <div className="text-xs text-muted mt-0.5">{p.client.name}</div>
                  </div>
                  <Badge tone={p.status === "DELIVERED" ? "positive" : "info"}>{p.status}</Badge>
                </div>

                <div className="mt-3.5 border-t border-line/60 pt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-[11px] uppercase font-sans tracking-wider text-muted">Service Scope</div>
                    <div className="font-medium text-ink mt-0.5">{p.serviceType || "Custom Project"}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase font-sans tracking-wider text-muted">Tracked Hours</div>
                    <div className="font-mono text-ink mt-0.5">{Number(p.actualHours).toFixed(1)}h</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-[11px] uppercase font-sans tracking-wider text-muted">Budget</div>
                    <div className="font-display font-medium text-sm text-ink mt-0.5">
                      {p.budgetAmount ? <Money amount={p.budgetAmount} /> : "—"}
                    </div>
                  </div>
                </div>

                <div className="mt-3 text-right">
                  <Link
                    to={`/projects/${p.id}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue hover:underline"
                  >
                    View Project Timeline
                  </Link>
                </div>
              </Card>
            ))}
          </div>

          {/* Desktop View: Elevated Table (>= 768px) */}
          <div className="hidden md:block">
            <Table>
              <Thead>
                <tr>
                  <Th>Project Name</Th>
                  <Th>Client Account</Th>
                  <Th>Service Type</Th>
                  <Th>Budget</Th>
                  <Th>Hours Logged</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </Thead>
              <tbody>
                {filtered.map((p) => (
                  <Tr key={p.id}>
                    <Td className="font-medium">
                      <Link to={`/projects/${p.id}`} className="font-semibold text-ink hover:underline">
                        {p.name}
                      </Link>
                    </Td>
                    <Td>{p.client.name}</Td>
                    <Td>
                      <span className="text-xs text-muted font-mono">{p.serviceType || "Custom"}</span>
                    </Td>
                    <Td className="font-medium text-ink">
                      {p.budgetAmount ? <Money amount={p.budgetAmount} /> : <span className="text-muted">—</span>}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{Number(p.actualHours).toFixed(1)}h</span>
                    </Td>
                    <Td>
                      <Badge tone={p.status === "DELIVERED" ? "positive" : "info"}>{p.status}</Badge>
                    </Td>
                    <Td align="right">
                      <Link
                        to={`/projects/${p.id}`}
                        className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-xs font-semibold text-muted transition hover:border-ink/40 hover:text-ink"
                      >
                        Details
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
