import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Badge, Button, Card, CopyButton, EmptyState, Loading, Money, PageHeader, StatGrid, StatTile } from "../components/ui";
import { EmailComposer, type ComposerTarget } from "../components/EmailComposer";

interface ClientDetailData {
  id: string;
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  sector?: string | null;
  lifetimeValue: string;
  projects: { id: string; name: string; status: string; serviceType?: string }[];
  invoices: { id: string; invoiceNumber: string; amountTotal: string; status: string; dueDate?: string }[];
  carePlans: { id: string; tier: string; monthlyFee: string; status: string; currency?: string }[];
}

export function ClientDetail() {
  const { id = "" } = useParams();
  const [emailing, setEmailing] = useState<ComposerTarget | null>(null);

  const { data: client, isLoading } = useQuery({
    queryKey: ["clients", id],
    queryFn: () => api.get<ClientDetailData>(`/clients/${id}`),
  });

  const totals = useMemo(() => {
    if (!client) return { totalInvoiced: 0, retainerMrr: 0 };
    const totalInvoiced = client.invoices.reduce((sum, inv) => sum + (Number(inv.amountTotal) || 0), 0);
    const retainerMrr = client.carePlans
      .filter((cp) => cp.status === "ACTIVE")
      .reduce((sum, cp) => sum + (Number(cp.monthlyFee) || 0), 0);
    return { totalInvoiced, retainerMrr };
  }, [client]);

  if (isLoading) return <Loading label="Loading client details" rows={4} />;
  if (!client) {
    return (
      <EmptyState
        message="Client account not found."
        action={
          <Link to="/clients">
            <Button variant="secondary">Back to Clients</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={client.name}
        subtitle={[client.company, client.sector, client.email, client.phone].filter(Boolean).join(" · ")}
        action={
          <div className="flex items-center gap-2">
            {client.email && (
              <Button
                variant="primary"
                onClick={() =>
                  setEmailing({
                    clientId: client.id,
                    purpose: "CUSTOM",
                  })
                }
              >
                Send email
              </Button>
            )}
            <Link to="/clients">
              <Button variant="secondary">All Clients</Button>
            </Link>
          </div>
        }
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile
          label="Cumulative Lifetime Value"
          value={<Money amount={client.lifetimeValue} />}
          sub="Total revenue received"
        />
        <StatTile
          label="Total Invoiced"
          value={<Money amount={totals.totalInvoiced} />}
          sub={`${client.invoices.length} invoice${client.invoices.length === 1 ? "" : "s"} raised`}
        />
        <StatTile
          label="Active Retainer MRR"
          value={<Money amount={totals.retainerMrr} />}
          sub={`${client.carePlans.filter((c) => c.status === "ACTIVE").length} active care plan(s)`}
        />
        <StatTile
          label="Projects Delivered"
          value={client.projects.length}
          sub="Contracts & delivery scopes"
        />
      </StatGrid>

      {/* Account Profile Card */}
      <Card className="p-5">
        <h3 className="font-display text-sm font-medium text-ink mb-3">Account Information</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-xs">
          <div>
            <span className="text-[11px] font-sans uppercase tracking-wider text-muted block">Company / Trade Name</span>
            <span className="font-semibold text-ink mt-0.5 block">{client.company || client.name}</span>
          </div>
          <div>
            <span className="text-[11px] font-sans uppercase tracking-wider text-muted block">Sector</span>
            <span className="mt-0.5 block">
              {client.sector ? <Badge tone="info">{client.sector}</Badge> : <span className="text-muted">—</span>}
            </span>
          </div>
          <div>
            <span className="text-[11px] font-sans uppercase tracking-wider text-muted block">Contact Email</span>
            {client.email ? (
              <div className="flex items-center gap-1.5 mt-0.5">
                <a href={`mailto:${client.email}`} className="text-blue hover:underline truncate">
                  {client.email}
                </a>
                <CopyButton text={client.email} />
              </div>
            ) : (
              <span className="text-muted mt-0.5 block">—</span>
            )}
          </div>
          <div>
            <span className="text-[11px] font-sans uppercase tracking-wider text-muted block">Direct Phone</span>
            {client.phone ? (
              <div className="flex items-center gap-1.5 mt-0.5">
                <a href={`tel:${client.phone}`} className="font-mono text-ink hover:underline">
                  {client.phone}
                </a>
                <CopyButton text={client.phone} />
              </div>
            ) : (
              <span className="text-muted mt-0.5 block">—</span>
            )}
          </div>
        </div>
      </Card>

      {/* Engagement 3-Column Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Projects */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-medium text-ink">
              Projects ({client.projects.length})
            </h3>
            <Link to="/projects" className="text-xs font-semibold text-blue hover:underline">
              View all
            </Link>
          </div>
          <div className="space-y-2.5">
            {client.projects.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="block">
                <Card interactive className="p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-xs font-medium text-ink truncate hover:underline">
                      {p.name}
                    </span>
                    <Badge tone={p.status === "DELIVERED" ? "positive" : "info"}>{p.status}</Badge>
                  </div>
                  {p.serviceType && (
                    <div className="mt-1 text-[11px] text-muted font-mono">{p.serviceType}</div>
                  )}
                </Card>
              </Link>
            ))}
            {client.projects.length === 0 && (
              <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-muted">
                No projects assigned to this account yet.
              </div>
            )}
          </div>
        </div>

        {/* Invoices */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-medium text-ink">
              Invoices ({client.invoices.length})
            </h3>
            <Link to="/invoices" className="text-xs font-semibold text-blue hover:underline">
              View all
            </Link>
          </div>
          <div className="space-y-2.5">
            {client.invoices.map((inv) => (
              <Card key={inv.id} className="p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-xs font-bold text-ink">{inv.invoiceNumber}</span>
                    <CopyButton text={inv.invoiceNumber} />
                  </div>
                  <Badge
                    tone={
                      inv.status === "PAID"
                        ? "positive"
                        : inv.status === "OVERDUE"
                        ? "danger"
                        : inv.status === "SENT"
                        ? "info"
                        : "muted"
                    }
                  >
                    {inv.status}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="font-display font-medium text-ink">
                    <Money amount={inv.amountTotal} />
                  </span>
                  {inv.dueDate && (
                    <span className="text-[11px] text-muted font-mono">
                      Due {new Date(inv.dueDate).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </Card>
            ))}
            {client.invoices.length === 0 && (
              <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-muted">
                No invoices raised for this account yet.
              </div>
            )}
          </div>
        </div>

        {/* Care Plans */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-medium text-ink">
              Retainers ({client.carePlans.length})
            </h3>
            <Link to="/care-plans" className="text-xs font-semibold text-blue hover:underline">
              View all
            </Link>
          </div>
          <div className="space-y-2.5">
            {client.carePlans.map((cp) => (
              <Card key={cp.id} className="p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-xs font-medium text-ink">{cp.tier} Tier</span>
                  <Badge tone={cp.status === "ACTIVE" ? "positive" : "muted"}>{cp.status}</Badge>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-muted">Monthly Retainer</span>
                  <span className="font-display font-medium text-ink">
                    <Money amount={cp.monthlyFee} currency={cp.currency} /> / mo
                  </span>
                </div>
              </Card>
            ))}
            {client.carePlans.length === 0 && (
              <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-muted">
                No active care plans on retainer.
              </div>
            )}
          </div>
        </div>
      </div>

      <EmailComposer target={emailing} open={emailing !== null} onClose={() => setEmailing(null)} />
    </div>
  );
}
