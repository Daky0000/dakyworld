import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CarePlan, CarePlanCatalogue, CarePlanRate, CarePlanTier, CarePlanTierOption, Client, Project } from "../lib/types";
import { Button, Drawer, Field, RelativeTime, Toggle } from "./ui";

/**
 * The one form that decides what a client pays every month, so it says what
 * each number does rather than assuming it's obvious: what the billing day
 * means, what happens when included hours run out, when the next review lands.
 *
 * **The tiers and their prices are not in this file.** They arrive from
 * `GET /care-plans/catalogue`, which reads them off dakyworld.com — see
 * `services/carePlanCatalogue.ts`. They used to be three constants here, under
 * three names the website had stopped using, at prices it had stopped
 * charging; the client and the invoice disagreed and only the client noticed.
 *
 * **Changing the tier changes the price.** It did not use to: the prefill was
 * skipped when editing, so moving a client up a tier renamed their plan and
 * went on billing the old fee. It reprices now, and where that replaced a fee
 * somebody had agreed, it says so and offers the old number back.
 */

const money = (amount: number) => amount.toLocaleString("en-GB");

/** Today plus `months`, as the value a date input wants. */
function monthsFromNow(months: number): string {
  const end = new Date();
  end.setMonth(end.getMonth() + months);
  return end.toISOString().slice(0, 10);
}

/** What this tier bills at this rate, or null where the site publishes nothing. */
function feeAt(option: CarePlanTierOption, rate: CarePlanRate): number | null {
  if (rate === "FOUNDING" && option.foundingMonthly !== null) return option.foundingMonthly;
  return option.standardMonthly;
}

type Draft = {
  clientId: string;
  projectId: string;
  tier: CarePlanTier;
  rate: CarePlanRate;
  monthlyFee: number;
  standardMonthlyFee: string;
  foundingRateUntil: string;
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

/** The fee a reprice replaced, kept only so it can be put back in one click. */
type Replaced = { monthlyFee: number; standardMonthlyFee: string; foundingRateUntil: string; includedHours: string };

function draftFrom(plan: CarePlan | null): Draft {
  return {
    clientId: plan?.client.id ?? "",
    projectId: plan?.project?.id ?? "",
    tier: plan?.tier ?? "GROWTH",
    // A plan with a standard fee waiting behind its current one is a plan
    // still inside its Founding Partner period.
    rate: plan?.standardMonthlyFee ? "FOUNDING" : "STANDARD",
    monthlyFee: plan ? Number(plan.monthlyFee) : 0,
    standardMonthlyFee: plan?.standardMonthlyFee ? String(Number(plan.standardMonthlyFee)) : "",
    foundingRateUntil: plan?.foundingRateUntil ? plan.foundingRateUntil.slice(0, 10) : "",
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
  const [replaced, setReplaced] = useState<Replaced | null>(null);
  // Remount-free reset: the drawer stays mounted between plans, so the draft
  // has to follow whichever one was opened.
  const [loadedFor, setLoadedFor] = useState<string | null>(plan?.id ?? null);
  if (open && (plan?.id ?? null) !== loadedFor) {
    setLoadedFor(plan?.id ?? null);
    setForm(draftFrom(plan));
    setReplaced(null);
    setError(null);
  }

  const { data: catalogue } = useQuery({
    queryKey: ["care-plan-catalogue"],
    queryFn: () => api.get<CarePlanCatalogue>("/care-plans/catalogue"),
    enabled: open,
  });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: () => api.get<Client[]>("/clients"), enabled: open });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects"), enabled: open });

  const tiers = catalogue?.tiers ?? [];
  const tier = tiers.find((option) => option.tier === form.tier) ?? null;

  // A new plan has no fee until the website's prices arrive. Filling it in the
  // moment they do is the whole point of the catalogue, and it must not count
  // as replacing an agreed number — there isn't one yet.
  const [prefilled, setPrefilled] = useState(false);
  if (open && !editing && !prefilled && tier) {
    setPrefilled(true);
    const fee = feeAt(tier, form.rate);
    if (fee !== null) setForm((current) => ({ ...current, monthlyFee: fee, includedHours: String(tier.includedHours) }));
  }
  if (!open && prefilled) setPrefilled(false);

  const clientProjects = useMemo(
    () => (projects ?? []).filter((project) => project.client?.id === form.clientId),
    [projects, form.clientId],
  );

  /**
   * Move the plan to a tier or a rate, and move the money with it.
   *
   * The old fee is kept rather than discarded: repricing is right by default,
   * and wrong for the client who negotiated a number, so that client's number
   * is one click away instead of being retyped from memory.
   */
  const reprice = (next: { tier?: CarePlanTier; rate?: CarePlanRate }) => {
    const wantTier = next.tier ?? form.tier;
    const wantRate = next.rate ?? form.rate;
    const option = tiers.find((entry) => entry.tier === wantTier);
    if (!option) return setForm({ ...form, tier: wantTier, rate: wantRate });

    const fee = feeAt(option, wantRate);
    if (fee === null) return setForm({ ...form, tier: wantTier, rate: wantRate });

    const founding = wantRate === "FOUNDING" && option.foundingMonthly !== null && option.standardMonthly !== null;
    setReplaced(
      fee === form.monthlyFee
        ? null
        : {
            monthlyFee: form.monthlyFee,
            standardMonthlyFee: form.standardMonthlyFee,
            foundingRateUntil: form.foundingRateUntil,
            includedHours: form.includedHours,
          },
    );
    setForm({
      ...form,
      tier: wantTier,
      rate: wantRate,
      monthlyFee: fee,
      standardMonthlyFee: founding ? String(option.standardMonthly) : "",
      // A founding period already running is kept — changing tier partway
      // through a discount must not restart the three months.
      foundingRateUntil: founding ? form.foundingRateUntil || monthsFromNow(catalogue?.foundingMonths ?? 3) : "",
      includedHours: String(option.includedHours),
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        projectId: form.projectId || null,
        // The fee on screen is the fee that is saved. `rate` is left out on
        // purpose: the server reprices when it is sent, and this form has
        // already done that on screen where it can be seen and undone.
        rate: undefined,
        standardMonthlyFee: form.standardMonthlyFee === "" ? null : Number(form.standardMonthlyFee),
        foundingRateUntil: form.foundingRateUntil === "" ? null : form.foundingRateUntil,
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

  const noPublishedPrice = Boolean(tier) && feeAt(tier as CarePlanTierOption, form.rate) === null;
  const steppingUp = form.standardMonthlyFee !== "" && form.foundingRateUntil !== "";

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
              ? `Bills on day ${form.billingDay} of each month, ${form.currency} ${money(form.monthlyFee)}.`
              : "Invoices raised by hand from this page."}
            {steppingUp && ` Then ${form.currency} ${money(Number(form.standardMonthlyFee))} from ${form.foundingRateUntil}.`}
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

        <Field label="Tier" hint={tier?.for || "Priced from the monthly partnerships on dakyworld.com."} full>
          <div className="grid gap-2 sm:grid-cols-3">
            {tiers.map((option) => {
              const fee = feeAt(option, form.rate);
              const selected = form.tier === option.tier;
              return (
                <button
                  key={option.tier}
                  type="button"
                  onClick={() => reprice({ tier: option.tier })}
                  className={`border px-3 py-2 text-left transition ${
                    selected ? "border-ink bg-ink text-cream" : "border-line-strong hover:border-ink/40"
                  }`}
                >
                  <span className="block font-mono text-[10px] uppercase tracking-[.12em]">{option.label}</span>
                  <span className={`mt-1 block text-xs ${selected ? "text-cream/60" : "text-muted"}`}>
                    {fee === null ? "No published price" : `${option.fromPrice ? "from " : ""}GHS ${money(fee)}/mo`}
                  </span>
                </button>
              );
            })}
            {tiers.length === 0 && <span className="text-xs text-muted sm:col-span-3">Loading the tiers from the website…</span>}
          </div>
        </Field>

        <Field
          label="Rate"
          hint={
            form.rate === "FOUNDING"
              ? tier?.discountNote || "The Founding Partner rate, for the agreed opening period."
              : "The standard published rate."
          }
          full
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {(["FOUNDING", "STANDARD"] as CarePlanRate[]).map((option) => {
              const available = option === "STANDARD" || (tier?.foundingMonthly ?? null) !== null;
              const selected = form.rate === option;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={!available}
                  onClick={() => reprice({ rate: option })}
                  className={`border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    selected ? "border-ink bg-ink text-cream" : "border-line-strong hover:border-ink/40"
                  }`}
                >
                  <span className="block font-mono text-[10px] uppercase tracking-[.12em]">
                    {option === "FOUNDING" ? "Founding Partner" : "Standard"}
                  </span>
                  <span className={`mt-1 block text-xs ${selected ? "text-cream/60" : "text-muted"}`}>
                    {option === "FOUNDING"
                      ? tier?.foundingMonthly === null || tier === null
                        ? "Not on offer for this tier"
                        : `First ${catalogue?.foundingMonths ?? 3} months`
                      : "Every month"}
                  </span>
                </button>
              );
            })}
          </div>
        </Field>

        {noPublishedPrice && (
          <div className="sm:col-span-2 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-xs text-warn-text">
            The website publishes no monthly price for this tier at this rate, so nothing was filled in. Enter the fee below, or publish the
            price and re-sync the business context in Settings.
          </div>
        )}

        {replaced && (
          <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-sunken px-3.5 py-2.5 text-xs">
            <span className="text-muted">
              Repriced to {form.currency} {money(form.monthlyFee)}/month, replacing {form.currency} {money(replaced.monthlyFee)}.
            </span>
            <button
              type="button"
              onClick={() => {
                setForm({ ...form, ...replaced });
                setReplaced(null);
              }}
              className="font-mono text-[10px] uppercase tracking-[.12em] underline underline-offset-2"
            >
              Keep {form.currency} {money(replaced.monthlyFee)}
            </button>
          </div>
        )}

        <Field label="Monthly fee" hint="What the next invoice charges. Overrides the tier's published price.">
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

        {form.rate === "FOUNDING" && (
          <>
            <Field label="Rate after the founding period" hint="Blank never steps the price up.">
              <input
                type="number"
                min={0}
                className="input"
                placeholder="e.g. 5000"
                value={form.standardMonthlyFee}
                onChange={(event) => setForm({ ...form, standardMonthlyFee: event.target.value })}
              />
            </Field>
            <Field label="Founding rate ends" hint="The first invoice on or after this date charges the standard rate.">
              <input
                type="date"
                className="input"
                value={form.foundingRateUntil}
                onChange={(event) => setForm({ ...form, foundingRateUntil: event.target.value })}
              />
            </Field>
          </>
        )}

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

        <Field label="Included hours" hint="The tier's capacity allocation. Blank means unmetered — no overage is ever charged.">
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
        <Field
          label="Overage rate / hour"
          hint="Blank never charges, and blank is the published position: work beyond the allocation is quoted as a separate project first."
        >
          <input
            type="number"
            min={0}
            className="input"
            placeholder="Usually blank"
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

        {catalogue && (
          <p className="sm:col-span-2 text-xs text-muted">
            {catalogue.source === "website" && catalogue.syncedAt ? (
              <>
                Tier prices read from dakyworld.com <RelativeTime value={catalogue.syncedAt} />. Change a price on the site and re-sync in
                Settings › Business context.
              </>
            ) : (
              <>These are the prices this app shipped with — the website has not been read yet. Sync it in Settings › Business context.</>
            )}
            {catalogue.unmatched.length > 0 && (
              <>
                {" "}
                The site also sells {catalogue.unmatched.join(", ")}, which has no tier in this database yet.
              </>
            )}
          </p>
        )}
      </div>
    </Drawer>
  );
}
