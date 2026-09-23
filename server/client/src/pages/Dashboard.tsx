import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DashboardData } from "../lib/types";
import { Button, EmptyState, Loading, Money, Notice, PageHeader, RelativeTime } from "../components/ui";

export function Dashboard() {
  const { user, can } = useAuth();
  const { data, isLoading, isError, refetch, isFetching } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<DashboardData>("/dashboard") });
  const totalLeads = data?.leadsByStatus.reduce((sum, row) => sum + row._count, 0) ?? 0;
  const largestGroup = Math.max(1, ...(data?.leadsByStatus.map(row => row._count) ?? []));
  const plans = data?.carePlans;
  const shortcuts = [
    { to: "/leads", title: "Lead pipeline", description: "Qualify opportunities and move conversations forward.", needs: "leads.view" },
    { to: "/projects", title: "Client projects", description: "Keep delivery, milestones and client work in view.", needs: "projects.view" },
    { to: "/agents", title: "Workforce", description: "Manage assignments, tools and agent activity.", needs: "agents.view" },
    { to: "/approvals", title: "Approval queue", description: "Review proposed actions before they go ahead.", needs: "agents.approvals.view" },
  ].filter(item => can(item.needs));
  return <div className="os-dashboard">
    <PageHeader eyebrow="Business overview" title="The bigger picture." subtitle={`Welcome back${user?.name ? `, ${user.name.split(" ")[0]}` : ""}. Here is where the business stands.`} action={<Button variant="secondary" size="sm" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Refreshing" : "Refresh overview"}</Button>} />
    {isLoading ? <Loading rows={6} /> : isError || !data ? <Notice tone="danger" title="Overview unavailable" action={<Button variant="secondary" onClick={() => void refetch()}>Try again</Button>}>Business data could not be loaded. Please try again.</Notice> : <>
      <section className="os-financials" aria-label="Financial overview">
        <div className="os-revenue"><div className="os-caption">Revenue collected</div><div className="os-revenue-value"><Money amount={data.revenueThisMonth} /></div><div className="os-revenue-bottom"><span>This month</span>{can("invoices.view") && <Link to="/invoices">View invoices</Link>}</div></div>
        <div className="os-financial-detail"><div className="os-caption">Monthly recurring</div><div className="os-metric-value"><Money amount={data.monthlyRecurringRevenue} /></div><p>{data.activeCarePlanCount} active care {data.activeCarePlanCount === 1 ? "plan" : "plans"}</p></div>
        <div className="os-financial-detail"><div className="os-caption">Outstanding invoices</div><div className="os-metric-value"><Money amount={data.outstandingInvoiceTotal} /></div><p>{data.outstandingInvoiceCount} awaiting payment</p></div>
        <div className="os-financial-detail"><div className="os-caption">Proposal pipeline</div><div className="os-metric-value"><Money amount={data.pipelineValue} /></div><p>{data.openProposalCount} open {data.openProposalCount === 1 ? "proposal" : "proposals"}</p></div>
      </section>
      <div className="os-overview-grid">
        <section className="os-panel">
          <header className="os-panel-heading"><div><span className="os-caption">Acquisition</span><h2>Pipeline composition</h2></div>{can("leads.view") && <Link to="/leads" className="os-text-link">View leads</Link>}</header>
          <div className="os-pipeline-total"><strong>{totalLeads.toLocaleString()}</strong><span>Total leads across all stages</span></div>
          {data.leadsByStatus.length ? <div className="os-pipeline-rows">{data.leadsByStatus.map(row => <div className="os-pipeline-row" key={row.status}><div className="os-pipeline-label">{can("leads.view") ? <Link to={`/leads?status=${encodeURIComponent(row.status)}`}>{row.status.toLowerCase().replaceAll("_", " ")}</Link> : <span>{row.status.toLowerCase().replaceAll("_", " ")}</span>}<strong>{row._count.toLocaleString()}</strong></div><div className="os-bar-track" aria-hidden><div style={{ width: `${row._count / largestGroup * 100}%` }} /></div></div>)}</div> : <EmptyState message="Your pipeline is ready for its first lead." />}
          <p className="os-panel-footnote">Current distribution of recorded leads.</p>
        </section>
        <section className="os-panel os-care-panel">
          <header className="os-panel-heading"><div><span className="os-caption">Client continuity</span><h2>Care plans</h2></div>{can("retainers.view") && <Link to="/care-plans" className="os-text-link">Manage</Link>}</header>
          {plans ? <><div className="os-care-summary"><strong>{plans.active}</strong><span>Active plans</span><div><b>{plans.paused}</b><span>Paused</span></div></div><dl className="os-detail-list"><div><dt>Billing within 7 days</dt><dd>{plans.billingWithin7Days}</dd></div><div><dt>Draft invoices to send</dt><dd>{plans.draftInvoices}</dd></div><div><dt>Reviews due</dt><dd>{plans.reviewsDue}</dd></div><div><dt>Churned this quarter</dt><dd>{plans.churnedThisQuarter}</dd></div></dl><div className="os-next-billing"><span className="os-caption">Next billing</span>{plans.nextBilling ? <><strong>{plans.nextBilling.client}</strong><div><Money amount={plans.nextBilling.amount} currency={plans.nextBilling.currency} /><RelativeTime value={plans.nextBilling.at} /></div></> : <p>No upcoming invoice scheduled.</p>}</div></> : <EmptyState message="Care plan information is unavailable." />}
        </section>
      </div>
      {shortcuts.length > 0 && <section className="os-shortcuts" aria-label="Workspace shortcuts"><div className="os-section-label"><h2>Your workspace</h2><span>Continue where it matters</span></div><div className="os-shortcut-grid">{shortcuts.map((item, index) => <Link to={item.to} className="os-shortcut" key={item.to}><span className="os-shortcut-number">{String(index + 1).padStart(2, "0")}</span><h3>{item.title}</h3><p>{item.description}</p><span className="os-shortcut-action">Open workspace</span></Link>)}</div></section>}
    </>}
  </div>;
}
