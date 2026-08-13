import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { DashboardData } from "../lib/types";
import { Card, Money, PageHeader, RelativeTime } from "../components/ui";

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
        <div className="grid grid-cols-1 gap-px rounded-2xl border border-line bg-ink/10 sm:grid-cols-2 lg:grid-cols-4">
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

      {data?.carePlans && <RetainerHealth data={data} />}

      {data && (
        <div className="mt-10">
          <h2 className="mb-4 font-display text-xl">Leads by status</h2>
          <div className="flex flex-wrap gap-3">
            {data.leadsByStatus.map((row) => (
              <Card key={row.status} className="min-w-[140px]">
                <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">{row.status}</div>
                <div className="mt-2 font-display text-2xl">{row._count}</div>
              </Card>
            ))}
            {data.leadsByStatus.length === 0 && <div className="text-sm text-ink/50">No leads yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * MRR is a number that only moves when something has already happened. This
 * row is the part that hasn't happened yet — the invoice about to go out, the
 * review nobody has booked, the draft sitting unsent — which is the only half
 * anyone can still do something about.
 */
function RetainerHealth({ data }: { data: DashboardData }) {
  const plans = data.carePlans;
  const attention = plans.reviewsDue + plans.draftInvoices + plans.paused;

  return (
    <div className="mt-10">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-xl">Retainers</h2>
        <Link to="/care-plans" className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/45 transition hover:text-ink">
          Manage →
        </Link>
      </div>

      {plans.active === 0 && plans.paused === 0 ? (
        <Card>
          <p className="text-sm text-ink/55">
            No care plans yet. Most Dakyworld clients arrive through a one-off project — a retainer is how that becomes recurring
            revenue.{" "}
            <Link to="/care-plans" className="underline underline-offset-2">
              Set one up
            </Link>
            .
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-px rounded-2xl border border-line bg-ink/10 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            label="Next invoice"
            value={plans.nextBilling ? <RelativeTime value={plans.nextBilling.at} /> : "—"}
            sub={plans.nextBilling ? `${plans.nextBilling.client} · ${plans.nextBilling.currency} ${Number(plans.nextBilling.amount).toLocaleString()}` : "Nothing scheduled"}
          />
          <Stat label="Billing this week" value={plans.billingWithin7Days} sub="Invoices raised automatically" />
          <Stat label="Drafts to send" value={plans.draftInvoices} sub={plans.draftInvoices > 0 ? "Nothing is emailed for you" : "All sent"} />
          <Stat label="Reviews due" value={plans.reviewsDue} sub={plans.reviewsDue > 0 ? "Overdue as of today" : "All current"} />
          <Stat
            label="Paused / churned"
            value={`${plans.paused} / ${plans.churnedThisQuarter}`}
            sub="Churn counted this quarter"
          />
        </div>
      )}

      {attention > 0 && (
        <p className="mt-3 text-xs text-ink/45">
          {attention} thing{attention === 1 ? "" : "s"} on the retainers need a person: drafts don't send themselves, and a paused
          plan bills nothing until it's resumed.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white p-6">
      <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">{label}</div>
      <div className="mt-3 font-display text-2xl">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink/50">{sub}</div>}
    </div>
  );
}
