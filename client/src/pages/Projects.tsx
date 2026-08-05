import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Project } from "../lib/types";
import { Badge, EmptyState, Money, PageHeader, Table } from "../components/ui";

export function Projects() {
  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/projects"),
  });

  return (
    <div>
      <PageHeader title="Project & Delivery" subtitle="Scope, timeline, deliverables, team — once a deal closes, it lives here." />
      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : !projects || projects.length === 0 ? (
        <EmptyState message="No projects yet. Projects are created automatically when a proposal is accepted." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-ink/10 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
              <th className="px-4 py-3">Project</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Budget</th>
              <th className="px-4 py-3">Hours logged</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-b border-ink/5 last:border-0 hover:bg-ink/[.02]">
                <td className="px-4 py-3">
                  <Link to={`/projects/${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  <div className="text-xs text-ink/50">{p.serviceType}</div>
                </td>
                <td className="px-4 py-3">{p.client.name}</td>
                <td className="px-4 py-3">{p.budgetAmount ? <Money amount={p.budgetAmount} /> : "—"}</td>
                <td className="px-4 py-3">{Number(p.actualHours).toFixed(1)}h</td>
                <td className="px-4 py-3">
                  <Badge tone={p.status === "DELIVERED" ? "gold" : "default"}>{p.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
