import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CarePlan, CarePlanTier, Client, Project } from "../lib/types";
import { Button, Drawer, Field, Toggle } from "./ui";

/**
 * The one form that decides what a client pays every month, so it says what
 * each number does rather than assuming it's obvious: what the billing day
 * means, what happens when included hours run out, when the next review lands.
 */

const TIERS: { value: CarePlanTier; label: string; fee: number; hours: number; hint: string }[] = [
  { value: "SME_ESSENTIALS", label: "SME Essentials", fee: 5000, hours: 6, hint: "Lean teams — the baseline retainer." },
  { value: "GROWTH", label: "Growth", fee: 12500, hours: 12, hint: "The middle tier most retainers land on." },
  {
    value: "ENTERPRISE_CONCIERGE",
    label: "Enterprise Concierge",
    fee: 25000,
    hours: 25,
    hint: "Priority incident response, 4-hour P1 SLA.",
  },
];

type Draft = {
  clientId: string;
  projectId: string;
  tier: CarePlanTier;
  monthlyFee: number;
  currency: string;
  billingDay: number;
  timezone: string;
  autoInvoice: boolean;
  dueDays: number;
  includedHours: string;
  overageHourlyRate: string;
  reviewEveryMonths: number;
  notes: string;
};

function draftFrom(plan: CarePlan | null): Draft {
  return {
    clientId: plan?.client.id ?? "",
    projectId: plan?.project?.id ?? "",
    tier: plan?.tier ?? "GROWTH",
    monthlyFee: plan ? Number(plan.monthlyFee) : 12500,
    currency: plan?.currency ?? "GHS",
    billingDay: plan?.billingDay ?? 1,
    timezone: plan?.timezone ?? "Africa/Accra",
    autoInvoice: plan?.autoInvoice ?? true,
    dueDays: plan?.dueDays ?? 14,
    includedHours: plan?.includedHours ? String(Number(plan.includedHours)) : "",
    overageHourlyRate: plan?.overageHourlyRate ? String(Number(plan.overageHourlyRate)) : "",
    reviewEveryMonths: plan?.reviewEveryMonths ?? 3,
    notes: plan?.notes ?? "",
  };
}

export function CarePlanEditor({ plan, open, onClose }: { plan: CarePlan | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = Boolean(plan);
  const [form, setForm] = useState<Draft>(() => draftFrom(plan));
  const [error, setError] = useState<string | null>(null);
  // Remount-free reset: the drawer stays mounted between plans, so the draft
  // has to follow whichever one was opened.
  const [loadedFor, setLoadedFor] = useState<string | null>(plan?.id ?? null);
  if (open && (plan?.id ?? null) !== loadedFor) {
    setLoadedFor(plan?.id ?? null);
    setForm(draftFrom(plan));
    setError(null);
  }

  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: () => api.get<Client[]>("/clients"), enabled: open });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects"), enabled: open });

  const clientProjects = useMemo(
    () => (projects ?? []).filter((project) => project.client?.id === form.clientId),
    [projects, form.clientId],
  );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        projectId: form.projectId || null,
        includedHours: form.includedHours === "" ? null : Number(form.includedHours),
        overageHourlyRate: form.overageHourlyRate === "" ? null : Number(form.overageHourlyRate),
        notes: form.notes.trim() || null,
      };
      return editing
        ? api.patch<CarePlan>(`/care-plans/${plan!.id}`, { ...body, clientId: undefined })
        : api.post<CarePlan>("/care-plans", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["care-plans"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const tier = TIERS.find((option) => option.value === form.tier)!;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? `${plan!.client.name} — care plan` : "New care plan"}
      subtitle={editing ? "Changes apply from the next invoice; history is untouched." : "The recurring half of the relationship."}
      footer={
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-muted">
            {form.autoInvoice
              ? `Bills on day ${form.billingDay} of each month, ${form.currency} ${form.monthlyFee.toLocaleString()}.`
              : "Invoices raised by hand from this page."}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !form.clientId}>
              {save.isPending ? "Saving…" : editing ? "Save" : "Create plan"}
            </Button>
          </div>
        </div>
      }
    >
      {error && <div className="mb-4 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{error}</div>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client" full>
          <select
            className="input"
            value={form.clientId}
            disabled={editing}
            onChange={(event) => setForm({ ...form, clientId: event.target.value, projectId: "" })}
          >
            <option value="">Choose a client…</option>
            {(clients ?? []).map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
                {client.company ? ` — ${client.company}` : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Tier" hint={tier.hint} full>
          <div className="grid gap-2 sm:grid-cols-3">
            {TIERS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  setForm({
                    ...form,
                    tier: option.value,
                    // Only prefill an untouched form; an agreed price must not
                    // be rewritten by clicking through the tiers.
                    monthlyFee: editing ? form.monthlyFee : option.fee,
                    includedHours: editing ? form.includedHours : String(option.hours),
                  })
                }
                className={`border px-3 py-2 text-left transition ${
                  form.tier === option.value ? "border-ink bg-ink text-cream" : "border-line-strong hover:border-ink/40"
                }`}
              >
                <span className="block font-mono text-[10px] uppercase tracking-[.12em]">{option.label}</span>
                <span className={`mt-1 block text-xs ${form.tier === option.value ? "text-cream/60" : "text-muted"}`}>
                  GHS {option.fee.toLocaleString()}/mo
                </span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Monthly fee">
          <input
            type="number"
            min={0}
            className="input"
            value={form.monthlyFee}
            onChange={(event) => setForm({ ...form, monthlyFee: Number(event.target.value) })}
          />
        </Field>
        <Field label="Currency">
          <input className="input" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} />
        </Field>

        <Field label="Billing day" hint="1–28, so no month is ever skipped.">
          <input
            type="number"
            min={1}
            max={28}
            className="input"
            value={form.billingDay}
            onChange={(event) => setForm({ ...form, billingDay: Number(event.target.value) })}
          />
        </Field>
        <Field label="Payment terms" hint="Days from issue to due.">
          <input
            type="number"
            min={0}
            max={90}
            className="input"
            value={form.dueDays}
            onChange={(event) => setForm({ ...form, dueDays: Number(event.target.value) })}
          />
        </Field>

        <Field label="Included hours" hint="Blank means unmetered — no overage is ever charged.">
          <input
            type="number"
            min={0}
            step="0.5"
            className="input"
            placeholder="e.g. 12"
            value={form.includedHours}
            onChange={(event) => setForm({ ...form, includedHours: event.target.value })}
          />
        </Field>
        <Field label="Overage rate / hour" hint="Charged in arrears on the next invoice. Blank never charges.">
          <input
            type="number"
            min={0}
            className="input"
            placeholder="e.g. 350"
            value={form.overageHourlyRate}
            onChange={(event) => setForm({ ...form, overageHourlyRate: event.target.value })}
          />
        </Field>

        <Field label="Delivery project" hint="Time logged here is what included hours are measured against." full>
          <select
            className="input"
            value={form.projectId}
            onChange={(event) => setForm({ ...form, projectId: event.target.value })}
            disabled={!form.clientId}
          >
            <option value="">No project — hours aren't tracked</option>
            {clientProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Review every (months)" hint="0 turns the reminder off.">
          <input
            type="number"
            min={0}
            max={24}
            className="input"
            value={form.reviewEveryMonths}
            onChange={(event) => setForm({ ...form, reviewEveryMonths: Number(event.target.value) })}
          />
        </Field>
        <Field label="Timezone" hint="The calendar the billing day is read from.">
          <input className="input" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} />
        </Field>

        <Field label="Notes" full>
          <textarea
            rows={3}
            className="input"
            placeholder="What this retainer covers, anything agreed off-contract…"
            value={form.notes}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
          />
        </Field>

        <div className="sm:col-span-2 border-t border-line pt-4">
          <Toggle
            checked={form.autoInvoice}
            onChange={(next) => setForm({ ...form, autoInvoice: next })}
            label="Invoice automatically on the billing day"
          />
          <p className="mt-2 text-xs text-muted">
            Invoices are raised as drafts — nothing is emailed. Send them from the Invoices page once you've looked at them.
          </p>
        </div>
      </div>
    </Drawer>
  );
}
