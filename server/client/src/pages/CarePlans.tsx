import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { BillOutcome, CarePlan, CarePlanCycle } from "../lib/types";
import { Badge, Button, Card, EmptyState, Money, PageHeader, RelativeTime, StatTile, StatusDot } from "../components/ui";
import { CarePlanEditor } from "../components/CarePlanEditor";

const TIER_LABEL: Record<string, string> = {
  SME_ESSENTIALS: "SME Essentials",
  GROWTH: "Growth",
  ENTERPRISE_CONCIERGE: "Enterprise Concierge",
};

/**
 * The retainers, and what each is about to do. A care plan page that only
 * listed plans would be a list of prices — what matters is which one bills on
 * Thursday, which one has burned its hours with two weeks to go, and which one
 * has not been reviewed since February.
 */
export function CarePlans() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CarePlan | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: plans, isLoading } = useQuery({ queryKey: ["care-plans"], queryFn: () => api.get<CarePlan[]>("/care-plans") });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["care-plans"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
  };

  const billNow = useMutation({
    mutationFn: (id: string) => api.post<{ outcomes: BillOutcome[] }>(`/care-plans/${id}/bill-now`),
    onSuccess: (result) => {
      const billed = result.outcomes.filter((outcome) => outcome.billed);
      if (billed.length > 0) {
        const numbers = billed.map((outcome) => (outcome.billed ? outcome.invoiceNumber : "")).join(", ");
        setNotice(`Raised ${numbers} as a draft. Nothing is emailed — send it from Invoices.`);
      } else {
        const reason = result.outcomes[0]?.billed === false ? result.outcomes[0].reason : "already-billed";
        setNotice(
          {
            "already-billed": "Nothing to bill — this period already has an invoice.",
            "not-due": "Nothing to bill yet — this plan's first full period starts on its next billing day.",
            "not-active": "Paused and churned plans don't bill. Resume it first.",
          }[reason],
        );
      }
      refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post(`/care-plans/${id}/${action}`, body ?? {}),
    onSuccess: () => refresh(),
    onError: (err: Error) => setNotice(err.message),
  });

  const active = (plans ?? []).filter((plan) => plan.status === "ACTIVE");
  const mrr = active.reduce((sum, plan) => sum + Number(plan.monthlyFee), 0);
  const reviewsDue = active.filter((plan) => plan.nextReviewAt && new Date(plan.nextReviewAt) <= new Date()).length;
  const overHours = active.filter((plan) => plan.usage?.hoursRemaining !== null && (plan.usage?.hoursRemaining ?? 1) < 0).length;
  const nextUp = active
    .filter((plan) => plan.nextBillingAt)
    .sort((a, b) => new Date(a.nextBillingAt!).getTime() - new Date(b.nextBillingAt!).getTime())[0];

  return (
    <div>
      <PageHeader
        title="Care Plans"
        subtitle="Retainers, what they include, and when each one bills itself."
        action={
          <Button
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            New care plan
          </Button>
        }
      />

      {notice && (
        <div className="overflow-hidden rounded-2xl mb-6 flex items-center justify-between gap-4 border border-line-strong bg-white px-4 py-3 text-sm">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="font-mono text-[10px] uppercase tracking-[.14em] text-muted hover:text-ink">
            Dismiss
          </button>
        </div>
      )}

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Recurring / month" value={<Money amount={mrr} />} sub={`${active.length} active plan${active.length === 1 ? "" : "s"}`} />
        <StatTile
          label="Next invoice"
          value={nextUp ? <RelativeTime value={nextUp.nextBillingAt} /> : "—"}
          sub={nextUp ? nextUp.client.name : "Nothing scheduled"}
        />
        <StatTile label="Reviews due" value={reviewsDue} sub={reviewsDue > 0 ? "Book them this week" : "All current"} />
        <StatTile label="Over included hours" value={overHours} sub={overHours > 0 ? "Overage bills next cycle" : "Everyone inside their hours"} />
      </div>

      {isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : !plans || plans.length === 0 ? (
        <EmptyState
          message="No care plans yet. A retainer is what turns a delivered project into recurring revenue — add one for a client you've already delivered for."
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              New care plan
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              expanded={expanded === plan.id}
              busy={billNow.isPending || act.isPending}
              onToggle={() => setExpanded(expanded === plan.id ? null : plan.id)}
              onEdit={() => {
                setEditing(plan);
                setEditorOpen(true);
              }}
              onBill={() => billNow.mutate(plan.id)}
              onAct={(action, body) => act.mutate({ id: plan.id, action, body })}
            />
          ))}
        </div>
      )}

      <CarePlanEditor plan={editing} open={editorOpen} onClose={() => setEditorOpen(false)} />
    </div>
  );
}

function PlanCard({
  plan,
  expanded,
  busy,
  onToggle,
  onEdit,
  onBill,
  onAct,
}: {
  plan: CarePlan;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onBill: () => void;
  onAct: (action: string, body?: unknown) => void;
}) {
  const churned = plan.status === "CHURNED";
  const reviewOverdue = plan.status === "ACTIVE" && plan.nextReviewAt && new Date(plan.nextReviewAt) <= new Date();

  return (
    <Card className={churned ? "opacity-60" : ""}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot tone={plan.status === "ACTIVE" ? "ok" : plan.status === "PAUSED" ? "warn" : "idle"} />
            <h3 className="font-display text-lg">{plan.client.name}</h3>
            <Badge tone={plan.status === "ACTIVE" ? "positive" : "muted"}>{TIER_LABEL[plan.tier] ?? plan.tier}</Badge>
            {plan.status !== "ACTIVE" && <Badge tone="muted">{plan.status}</Badge>}
            {!plan.autoInvoice && plan.status === "ACTIVE" && <Badge tone="muted">Manual billing</Badge>}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted">
            <span className="text-ink">
              <Money amount={plan.monthlyFee} currency={plan.currency} />
              <span className="text-muted"> / month</span>
            </span>
            <span>Day {plan.billingDay}</span>
            {plan.status === "ACTIVE" && plan.autoInvoice && plan.nextBillingAt && (
              <span>
                Next invoice <RelativeTime value={plan.nextBillingAt} />
              </span>
            )}
            {plan.project && <span>· {plan.project.name}</span>}
          </div>

          <HoursBar plan={plan} />

          {reviewOverdue && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-xl border border-warn-line bg-warn-surface px-3 py-1.5 text-xs text-warn-text">
              Review due <RelativeTime value={plan.nextReviewAt} /> — every {plan.reviewEveryMonths} months
              <button
                type="button"
                onClick={() => onAct("reviewed")}
                className="font-mono text-[10px] uppercase tracking-[.12em] underline underline-offset-2"
              >
                Mark held
              </button>
            </div>
          )}

          {churned && plan.churnReason && <div className="mt-3 text-xs text-muted">Churned: {plan.churnReason}</div>}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={onToggle}>
            {expanded ? "Hide history" : "History"}
          </Button>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          {plan.status === "ACTIVE" && (
            <>
              <Button size="sm" onClick={onBill} disabled={busy}>
                Bill now
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onAct("pause")} disabled={busy}>
                Pause
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt("Why is this plan ending? (optional)") ?? undefined;
                  onAct("churn", { reason: reason || undefined });
                }}
              >
                Churn
              </Button>
            </>
          )}
          {plan.status !== "ACTIVE" && (
            <Button size="sm" onClick={() => onAct("resume")} disabled={busy}>
              {plan.status === "PAUSED" ? "Resume" : "Reactivate"}
            </Button>
          )}
        </div>
      </div>

      {expanded && <PlanHistory planId={plan.id} />}
    </Card>
  );
}

/** Hours burned this period — the number worth seeing before the month ends. */
function HoursBar({ plan }: { plan: CarePlan }) {
  const usage = plan.usage;
  if (!usage) return null;
  if (usage.includedHours === null) {
    return (
      <div className="mt-3 text-xs text-muted">
        Unmetered · {usage.hoursUsed} h logged this period{plan.project ? "" : " (no project linked, so nothing is counted)"}
      </div>
    );
  }

  const ratio = usage.includedHours === 0 ? 1 : usage.hoursUsed / usage.includedHours;
  const over = usage.hoursUsed > usage.includedHours;
  const tone = over ? "bg-danger" : ratio > 0.8 ? "bg-warn" : "bg-ink/60";

  return (
    <div className="mt-3 max-w-md">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">
          {usage.hoursUsed} of {usage.includedHours} h this period
        </span>
        <span className={over ? "text-danger-text" : "text-muted"}>
          {over
            ? `${Math.round((usage.hoursUsed - usage.includedHours) * 100) / 100} h over`
            : `${usage.hoursRemaining} h left`}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full bg-line">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, Math.max(2, ratio * 100))}%` }} />
      </div>
      {over && !plan.overageHourlyRate && (
        <div className="mt-1 text-[11px] text-muted">No overage rate set — the extra hours won't be charged.</div>
      )}
    </div>
  );
}

/** The billed months, newest first, each with its invoice and settled hours. */
function PlanHistory({ planId }: { planId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["care-plans", planId],
    queryFn: () => api.get<CarePlan>(`/care-plans/${planId}`),
  });

  if (isLoading) return <div className="mt-5 border-t border-line pt-4 text-sm text-muted">Loading history…</div>;
  const cycles = data?.cycles ?? [];

  return (
    <div className="mt-5 border-t border-line pt-4">
      {data?.notes && <p className="mb-4 max-w-2xl text-sm text-muted">{data.notes}</p>}
      {cycles.length === 0 ? (
        <p className="text-sm text-muted">Nothing billed yet. The first invoice goes out on the next billing day.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                <th className="py-2 pr-4">Period</th>
                <th className="py-2 pr-4">Fee</th>
                <th className="py-2 pr-4">Hours</th>
                <th className="py-2 pr-4">Overage</th>
                <th className="py-2 pr-4">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((cycle) => (
                <CycleRow key={cycle.id} cycle={cycle} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CycleRow({ cycle }: { cycle: CarePlanCycle }) {
  const period = new Date(cycle.periodStart).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const included = cycle.includedHours === null || cycle.includedHours === undefined ? null : Number(cycle.includedHours);

  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-2 pr-4 font-medium">{period}</td>
      <td className="py-2 pr-4">
        <Money amount={cycle.monthlyFee} />
      </td>
      <td className="py-2 pr-4 text-ink">
        {cycle.settledAt ? (
          <>
            {Number(cycle.hoursUsed ?? 0)} h{included !== null ? ` / ${included}` : ""}
          </>
        ) : (
          <span className="text-muted">counting…</span>
        )}
      </td>
      <td className="py-2 pr-4">
        {Number(cycle.overageAmount ?? 0) > 0 ? (
          <span className="text-danger-text">
            <Money amount={cycle.overageAmount ?? 0} /> ({Number(cycle.overageHours ?? 0)} h)
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="py-2 pr-4">
        {cycle.invoice ? (
          <span className="flex items-center gap-2">
            {cycle.invoice.pdfUrl ? (
              <a href={cycle.invoice.pdfUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {cycle.invoice.invoiceNumber}
              </a>
            ) : (
              <span className="font-mono text-xs">{cycle.invoice.invoiceNumber}</span>
            )}
            <Badge tone={cycle.invoice.status === "PAID" ? "positive" : "muted"}>{cycle.invoice.status}</Badge>
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
    </tr>
  );
}
