import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Client } from "../lib/types";
import { Badge, Card, EmptyState, Loading, Money, PageHeader, StatGrid, StatTile, Table, Thead, Th, Tr, Td } from "../components/ui";

export function Clients() {
  const [search, setSearch] = useState("");
  const [selectedSector, setSelectedSector] = useState<string>("ALL");

  const { data: clients, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.get<Client[]>("/clients"),
  });

  const allClients = clients ?? [];

  // Summary Metrics
  const stats = useMemo(() => {
    let totalLtv = 0;
    let totalProjects = 0;
    let totalCarePlans = 0;

    for (const c of allClients) {
      totalLtv += Number(c.lifetimeValue) || 0;
      totalProjects += c._count?.projects ?? 0;
      totalCarePlans += c._count?.carePlans ?? 0;
    }

    return {
      count: allClients.length,
      totalLtv,
      totalProjects,
      totalCarePlans,
    };
  }, [allClients]);

  // Unique sectors
  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const c of allClients) {
      if (c.sector) set.add(c.sector);
    }
    return Array.from(set).sort();
  }, [allClients]);

  // Filtered clients
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allClients.filter((c) => {
      const matchSearch =
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.sector && c.sector.toLowerCase().includes(q));
      const matchSector = selectedSector === "ALL" || c.sector === selectedSector;
      return matchSearch && matchSector;
    });
  }, [allClients, search, selectedSector]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clients"
        subtitle="Manage accounts, track customer lifetime value, active engagements, and ongoing retainer partnerships."
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile
          label="Total Clients"
          value={stats.count}
          sub="Active & historical partnerships"
        />
        <StatTile
          label="Cumulative Lifetime Value"
          value={<Money amount={stats.totalLtv} />}
          sub="Total revenue across accounts"
        />
        <StatTile
          label="Total Projects"
          value={stats.totalProjects}
          sub="Delivered & in-flight scopes"
        />
        <StatTile
          label="Active Retainers"
          value={stats.totalCarePlans}
          sub="Recurring care plans"
        />
      </StatGrid>

      {/* Search & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <input
            type="search"
            placeholder="Search by client name, email, or sector…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3.5 py-1.5 text-xs text-ink outline-none transition focus:border-blue focus:ring-2 focus:ring-blue/15"
          />
        </div>

        {sectors.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setSelectedSector("ALL")}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition  ${
                selectedSector === "ALL"
                  ? "bg-ink text-white"
                  : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              All Sectors
            </button>
            {sectors.map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => setSelectedSector(sec)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition  ${
                  selectedSector === sec
                    ? "bg-ink text-white"
                    : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
                }`}
              >
                {sec}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <Loading label="Loading clients" rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={
            allClients.length === 0
              ? "No clients yet. Clients are created automatically when a proposal is accepted."
              : "No clients matched your search criteria."
          }
        />
      ) : (
        <>
          {/* Mobile View: Responsive elevated card grid (< 768px) */}
          <div className="grid gap-3.5 sm:grid-cols-2 md:hidden">
            {filtered.map((c) => (
              <Card key={c.id} interactive className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      to={`/clients/${c.id}`}
                      className="font-display text-base font-medium text-ink hover:underline"
                    >
                      {c.name}
                    </Link>
                    {c.email && <div className="truncate text-xs text-muted mt-0.5">{c.email}</div>}
                  </div>
                  {c.sector && <Badge tone="info">{c.sector}</Badge>}
                </div>

                <div className="mt-3.5 border-t border-line/60 pt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-[11px] uppercase font-sans tracking-wider text-muted">Lifetime Value</div>
                    <div className="font-display font-medium text-sm text-ink mt-0.5">
                      <Money amount={c.lifetimeValue} />
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase font-sans tracking-wider text-muted">Engagements</div>
                    <div className="text-muted mt-0.5">
                      {c._count?.projects ?? 0} project{(c._count?.projects ?? 0) === 1 ? "" : "s"} · {c._count?.carePlans ?? 0} plan{(c._count?.carePlans ?? 0) === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>

                <div className="mt-3 text-right">
                  <Link
                    to={`/clients/${c.id}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue hover:underline"
                  >
                    View Account Details
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
                  <Th>Client Account</Th>
                  <Th>Sector</Th>
                  <Th>Lifetime Value</Th>
                  <Th>Projects</Th>
                  <Th>Care Plans</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </Thead>
              <tbody>
                {filtered.map((c) => (
                  <Tr key={c.id}>
                    <Td className="font-medium">
                      <Link to={`/clients/${c.id}`} className="font-semibold text-ink hover:underline">
                        {c.name}
                      </Link>
                      {c.email && <div className="text-xs text-muted">{c.email}</div>}
                    </Td>
                    <Td>
                      {c.sector ? <Badge tone="info">{c.sector}</Badge> : <span className="text-muted">—</span>}
                    </Td>
                    <Td className="font-semibold text-ink">
                      <Money amount={c.lifetimeValue} />
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{c._count?.projects ?? 0}</span>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{c._count?.carePlans ?? 0}</span>
                    </Td>
                    <Td align="right">
                      <Link
                        to={`/clients/${c.id}`}
                        className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-xs font-semibold text-muted transition hover:border-ink/40 hover:text-ink"
                      >
                        Open
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
