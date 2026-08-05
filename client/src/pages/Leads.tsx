import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Lead } from "../lib/types";
import { Badge, Button, Card, EmptyState, Money, PageHeader, Table } from "../components/ui";

const STATUSES = ["NEW", "QUALIFYING", "QUALIFIED", "DISQUALIFIED", "CONVERTED", "LOST"];
const SOURCES = ["REFERRAL", "LINKEDIN", "COLD_EMAIL", "OUTREACH", "CONTENT", "WARM_NETWORK", "OTHER"];

interface LeadCreateInput {
  contactName: string;
  contactEmail?: string;
  companyName?: string;
  source: string;
  estimatedDealSize?: number;
  discoveryNotes?: string;
}

export function Leads() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const { data: leads, isLoading } = useQuery({
    queryKey: ["leads"],
    queryFn: () => api.get<Lead[]>("/leads"),
  });

  const createLead = useMutation({
    mutationFn: (body: LeadCreateInput) => api.post<Lead>("/leads", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      setShowForm(false);
    },
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch<Lead>(`/leads/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leads"] }),
  });

  return (
    <div>
      <PageHeader
        title="Lead & Pipeline"
        subtitle="Every prospect from first contact through close — the top of the funnel."
        action={<Button onClick={() => setShowForm((s) => !s)}>{showForm ? "Cancel" : "New lead"}</Button>}
      />

      {showForm && <NewLeadForm onSubmit={(body) => createLead.mutate(body)} pending={createLead.isPending} />}

      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : !leads || leads.length === 0 ? (
        <EmptyState message="No leads yet. Add your first prospect above." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-ink/10 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Deal size</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="border-b border-ink/5 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium">{lead.contactName}</div>
                  <div className="text-xs text-ink/50">{lead.contactEmail}</div>
                </td>
                <td className="px-4 py-3">{lead.companyName ?? "—"}</td>
                <td className="px-4 py-3">
                  <Badge tone="muted">{lead.source}</Badge>
                </td>
                <td className="px-4 py-3">{lead.leadScore}</td>
                <td className="px-4 py-3">{lead.estimatedDealSize ? <Money amount={lead.estimatedDealSize} /> : "—"}</td>
                <td className="px-4 py-3">
                  <select
                    value={lead.status}
                    onChange={(e) => updateStatus.mutate({ id: lead.id, status: e.target.value })}
                    className="border border-ink/20 bg-white px-2 py-1 font-mono text-xs uppercase tracking-[.08em]"
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function NewLeadForm({ onSubmit, pending }: { onSubmit: (body: LeadCreateInput) => void; pending: boolean }) {
  const [form, setForm] = useState({
    contactName: "",
    contactEmail: "",
    companyName: "",
    source: "OUTREACH",
    estimatedDealSize: "",
    discoveryNotes: "",
  });

  return (
    <Card className="mb-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            ...form,
            estimatedDealSize: form.estimatedDealSize ? Number(form.estimatedDealSize) : undefined,
          });
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Contact name">
          <input required value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} className="input" />
        </Field>
        <Field label="Contact email">
          <input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} className="input" />
        </Field>
        <Field label="Company">
          <input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} className="input" />
        </Field>
        <Field label="Source">
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className="input">
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Estimated deal size (GHS)">
          <input type="number" min="0" value={form.estimatedDealSize} onChange={(e) => setForm({ ...form, estimatedDealSize: e.target.value })} className="input" />
        </Field>
        <Field label="Discovery notes" full>
          <textarea rows={3} value={form.discoveryNotes} onChange={(e) => setForm({ ...form, discoveryNotes: e.target.value })} className="input" />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save lead"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`block text-sm ${full ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">{label}</span>
      {children}
    </label>
  );
}
