import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Client } from "../lib/types";
import { EmptyState, Money, PageHeader, Table } from "../components/ui";

export function Clients() {
  const { data: clients, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.get<Client[]>("/clients"),
  });

  return (
    <div>
      <PageHeader title="Clients" subtitle="Every company you've worked with — projects, invoices, and care plans in one place." />
      {isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : !clients || clients.length === 0 ? (
        <EmptyState message="No clients yet. Clients are created automatically when a proposal is accepted." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-muted">
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Sector</th>
              <th className="px-4 py-3">Lifetime value</th>
              <th className="px-4 py-3">Projects</th>
              <th className="px-4 py-3">Care plans</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0 hover:bg-sunken">
                <td className="px-4 py-3">
                  <Link to={`/clients/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                  <div className="text-xs text-muted">{c.email}</div>
                </td>
                <td className="px-4 py-3">{c.sector ?? "—"}</td>
                <td className="px-4 py-3">
                  <Money amount={c.lifetimeValue} />
                </td>
                <td className="px-4 py-3">{c._count?.projects ?? 0}</td>
                <td className="px-4 py-3">{c._count?.carePlans ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
