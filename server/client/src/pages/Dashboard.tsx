import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { DashboardData } from "../lib/types";
import { Card, Money, PageHeader } from "../components/ui";

export function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/dashboard"),
  });

  return (
    <div>
      <PageHeader title="Revenue Dashboard" subtitle="Total revenue, recurring revenue, outstanding invoices, and pipeline — live." />
      {isLoading || !data ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 gap-px border border-ink/10 bg-ink/10 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Revenue this month" value={<Money amount={data.revenueThisMonth} />} />
          <Stat
            label="Monthly recurring revenue"
            value={<Money amount={data.monthlyRecurringRevenue} />}
            sub={`${data.activeCarePlanCount} active care plan${data.activeCarePlanCount === 1 ? "" : "s"}`}
          />
          <Stat
            label="Outstanding invoices"
            value={<Money amount={data.outstandingInvoiceTotal} />}
            sub={`${data.outstandingInvoiceCount} unpaid`}
          />
          <Stat
            label="Pipeline value"
            value={<Money amount={data.pipelineValue} />}
            sub={`${data.openProposalCount} open proposal${data.openProposalCount === 1 ? "" : "s"}`}
          />
        </div>
      )}

      {data && (
        <div className="mt-10">
          <h2 className="mb-4 font-serif text-xl">Leads by status</h2>
          <div className="flex flex-wrap gap-3">
            {data.leadsByStatus.map((row) => (
              <Card key={row.status} className="min-w-[140px]">
                <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">{row.status}</div>
                <div className="mt-2 font-serif text-2xl">{row._count}</div>
              </Card>
            ))}
            {data.leadsByStatus.length === 0 && <div className="text-sm text-ink/50">No leads yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white p-6">
      <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">{label}</div>
      <div className="mt-3 font-serif text-2xl">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink/50">{sub}</div>}
    </div>
  );
}
