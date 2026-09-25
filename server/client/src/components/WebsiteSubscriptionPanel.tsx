import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button, Card, Notice } from "./ui";

/**
 * What the customer is paying, and how to stop.
 *
 * The cancel button is on the same screen as the plan rather than buried,
 * because a subscription that can only be left by writing to the founder is
 * one people are right to be wary of joining. It says plainly what cancelling
 * does and does not do: no further charge, and the website stays online until
 * the period they have paid for runs out.
 */

type Subscription = {
  tier: string;
  source: string;
  subscription: {
    id: string;
    status: string;
    currency: string;
    monthlyPrice: string;
    standardRecurringPrice: string | null;
    billingPriceUpdatedAt: string | null;
    billingState: string;
    activatedAt: string | null;
    nextBillingAt: string | null;
    promoEndsAt: string | null;
  } | null;
  cancellation: { cancellable: boolean; alreadyCancelled: boolean; servesUntil: string | null } | null;
};

const money = (amount: string, currency: string) =>
  currency === "USD" ? `$${Number(amount).toFixed(0)}` : `GHS ${Number(amount).toLocaleString("en-GB")}`;

const day = (value: string | null) => (value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : null);

export function WebsiteSubscriptionPanel() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const subscription = useQuery({
    queryKey: ["website", "subscription"],
    queryFn: () => api.get<Subscription>("/website/subscription"),
  });

  const cancel = useMutation({
    mutationFn: () => api.post<{ message: string }>("/website/subscription/cancel", { reason }),
    onSuccess: (result) => {
      setDone(result.message);
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["website", "subscription"] });
    },
  });
  const manage = useMutation({
    mutationFn: () => api.post<{ url: string }>("/website/subscription/manage", {}),
    onSuccess: ({ url }) => { window.location.assign(url); },
  });

  if (subscription.isLoading) return <p className="text-sm text-muted">Loading your plan…</p>;
  if (subscription.isError) return <Notice tone="warn">{(subscription.error as Error).message}</Notice>;

  const data = subscription.data!;
  const row = data.subscription;

  if (!row) {
    return (
      <Card className="p-6">
        <h2 className="font-display text-lg font-medium text-ink">Your plan</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          There is no paid subscription on this account. You are on the {data.tier === "MANAGED" ? "full" : "starter"}{" "}
          feature set
          {data.source === "staff" ? " because you work here" : ""}.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-5 p-6">
      <div>
        <h2 className="font-display text-lg font-medium text-ink">Your plan</h2>
        <p className="mt-1 text-sm text-muted">
          {money(row.monthlyPrice, row.currency)} a month
          {row.standardRecurringPrice && !row.billingPriceUpdatedAt && (
            <> · goes to {money(row.standardRecurringPrice, row.currency)} when the introductory period ends</>
          )}
        </p>
      </div>

      <div className="space-y-1 text-sm text-muted">
        {row.activatedAt && <p>Started {day(row.activatedAt)}.</p>}
        {row.nextBillingAt && row.status !== "CANCELLED" && <p>Next payment {day(row.nextBillingAt)}.</p>}
        {row.billingState === "PAST_DUE" && (
          <Notice tone="warn">
            Your last payment was declined. Your website is still online and stays online. If it is not paid within two
            weeks, editing pauses until a payment goes through.
          </Notice>
        )}
      </div>

      {done && <Notice tone="positive">{done}</Notice>}
      {row.status !== "CANCELLED" && <div>
        <Button size="sm" variant="secondary" disabled={manage.isPending} onClick={() => manage.mutate()}>
          {manage.isPending ? "Opening billing…" : "Manage card and billing"}
        </Button>
        {manage.isError && <p className="mt-2 text-sm text-warn-text">{(manage.error as Error).message}</p>}
      </div>}

      {row.status === "CANCELLED" ? (
        <Notice>
          Cancelled. You will not be charged again, and your website stays online until{" "}
          {day(row.nextBillingAt) ?? "the end of the paid period"}.
        </Notice>
      ) : confirming ? (
        <div className="space-y-3 rounded-xl border border-line p-4">
          <p className="text-sm text-ink">
            Cancelling stops any further payment. Your website stays online until{" "}
            {day(row.nextBillingAt) ?? "the end of the period you have paid for"}, and nothing is deleted.
          </p>
          <textarea
            className="w-full rounded-xl border border-line bg-cream px-3 py-2 text-sm"
            rows={2}
            placeholder="If you have a moment: what made you cancel? (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              {cancel.isPending ? "Cancelling…" : "Confirm cancellation"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Keep my plan
            </Button>
          </div>
          {cancel.isError && <p className="text-sm text-warn-text">{(cancel.error as Error).message}</p>}
        </div>
      ) : (
        <button type="button" className="text-sm text-muted underline hover:text-ink" onClick={() => setConfirming(true)}>
          Cancel my subscription
        </button>
      )}
    </Card>
  );
}
