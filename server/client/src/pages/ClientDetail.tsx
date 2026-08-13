import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Badge, Card, Money, PageHeader } from "../components/ui";

interface ClientDetailData {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  sector?: string | null;
  lifetimeValue: string;
  projects: { id: string; name: string; status: string }[];
  invoices: { id: string; invoiceNumber: string; amountTotal: string; status: string }[];
  carePlans: { id: string; tier: string; monthlyFee: string; status: string }[];
}

export function ClientDetail() {
  const { id = "" } = useParams();
  const { data: client, isLoading } = useQuery({
    queryKey: ["clients", id],
    queryFn: () => api.get<ClientDetailData>(`/clients/${id}`),
  });

  if (isLoading || !client) return <div className="text-sm text-ink/50">Loading…</div>;

  return (
    <div>
      <PageHeader title={client.name} subtitle={[client.sector, client.email, client.phone].filter(Boolean).join(" · ")} />

      <Card className="mb-8">
        <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">Lifetime value</div>
        <div className="mt-2 font-display text-2xl">
          <Money amount={client.lifetimeValue} />
        </div>
      </Card>

      <div className="grid gap-8 lg:grid-cols-3">
        <Section title="Projects">
          {client.projects.map((p) => (
            <Row key={p.id} left={p.name} right={<Badge>{p.status}</Badge>} />
          ))}
          {client.projects.length === 0 && <Empty />}
        </Section>
        <Section title="Invoices">
          {client.invoices.map((inv) => (
            <Row key={inv.id} left={inv.invoiceNumber} right={<Money amount={inv.amountTotal} />} />
          ))}
          {client.invoices.length === 0 && <Empty />}
        </Section>
        <Section title="Care plans">
          {client.carePlans.map((cp) => (
            <Row key={cp.id} left={cp.tier} right={<Money amount={cp.monthlyFee} />} />
          ))}
          {client.carePlans.length === 0 && <Empty />}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-3 font-display text-lg">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3 text-sm">
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}

function Empty() {
  return <div className="text-sm text-ink/40">None yet.</div>;
}
