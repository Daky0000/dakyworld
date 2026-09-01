import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { DashboardData } from "../lib/types";
import { Card, Loading, Money, PageHeader, RelativeTime, SectionHeading, StatGrid, StatTile } from "../components/ui";

export function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/dashboard"),
  });

  return (
    <div>
      <PageHeader title="Revenue Dashboard" subtitle="Total revenue, recurring revenue, outstanding invoices, and pipeline — live." />
      {isLoading || !data ? (
        <Loading rows={2} />
      ) : (
        <StatGrid>
          <StatTile label="Revenue this month" value={<Money amount={data.revenueThisMonth} />} />
          <StatTile
            label="Monthly recurring revenue"
            value={<Money amount={data.monthlyRecurringRevenue} />}
            sub={`${data.activeCarePlanCount} active care plan${data.activeCarePlanCount === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Outstanding invoices"
            value={<Money amount={data.outstandingInvoiceTotal} />}
            sub={`${data.outstandingInvoiceCount} unpaid`}
          />
          <StatTile
            label="Pipeline value"
            value={<Money amount={data.pipelineValue} />}
            sub={`${data.openProposalCount} open proposal${data.openProposalCount === 1 ? "" : "s"}`}
          />
        </StatGrid>
      )}

      {data?.carePlans && <RetainerHealth data={data} />}

      {data && (
        <div className="mt-10">
          <SectionHeading title="Leads by status" />
          <div className="flex flex-wrap gap-x-8 gap-y-5 rounded-2xl border border-line bg-white px-6 py-5">
            {data.leadsByStatus.map((row) => (
              <div key={row.status}>
                <div className="micro">{row.status}</div>
                <div className="mt-1.5 font-display text-2xl leading-none tracking-[-.04em]">{row._count}</div>
              </div>
            ))}
            {data.leadsByStatus.length === 0 && <div className="text-sm text-muted">No leads yet.</div>}
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
      <SectionHeading
        title="Retainers"
        action={
          <Link to="/care-plans" className="micro transition hover:text-ink">
            Manage →
          </Link>
        }
      />

      {plans.active === 0 && plans.paused === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            No care plans yet. Most Dakyworld clients arrive through a one-off project — a retainer is how that becomes recurring
            revenue.{" "}
            <Link to="/care-plans" className="underline underline-offset-2">
              Set one up
            </Link>
            .
          </p>
        </Card>
      ) : (
        <StatGrid columns={5}>
          <StatTile
            label="Next invoice"
            value={plans.nextBilling ? <RelativeTime value={plans.nextBilling.at} /> : "—"}
            sub={plans.nextBilling ? `${plans.nextBilling.client} · ${plans.nextBilling.currency} ${Number(plans.nextBilling.amount).toLocaleString()}` : "Nothing scheduled"}
          />
          <StatTile label="Billing this week" value={plans.billingWithin7Days} sub="Invoices raised automatically" />
          <StatTile label="Drafts to send" value={plans.draftInvoices} sub={plans.draftInvoices > 0 ? "Nothing is emailed for you" : "All sent"} />
          <StatTile label="Reviews due" value={plans.reviewsDue} sub={plans.reviewsDue > 0 ? "Overdue as of today" : "All current"} />
          <StatTile
            label="Paused / churned"
            value={`${plans.paused} / ${plans.churnedThisQuarter}`}
            sub="Churn counted this quarter"
          />
        </StatGrid>
      )}

      {attention > 0 && (
        <p className="mt-3 text-xs text-muted">
          {attention} thing{attention === 1 ? "" : "s"} on the retainers need a person: drafts don't send themselves, and a paused
          plan bills nothing until it's resumed.
        </p>
      )}
    </div>
  );
}
