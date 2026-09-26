import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Badge, Button, PageHeader } from "../components/ui";
import type { WebsiteBalanceReport, ClientInvoice, ClientAddon } from "../lib/types";

export function WebsiteBalance() {
  const qc = useQueryClient();
  const [selectedAddon, setSelectedAddon] = useState<ClientAddon | null>(null);
  const [addonNotes, setAddonNotes] = useState("");
  const [purchaseSuccess, setPurchaseSuccess] = useState<{
    invoiceNumber: string;
    amount: number;
    currency: string;
    paymentUrl: string | null;
    message: string;
  } | null>(null);

  const balanceQuery = useQuery({
    queryKey: ["website-balance"],
    queryFn: () => api.get<WebsiteBalanceReport>("/website/balance"),
  });

  const orderAddonMutation = useMutation({
    mutationFn: (data: { addonId: string; notes?: string }) =>
      api.post<{
        ok: boolean;
        invoiceNumber: string;
        amount: number;
        currency: string;
        paymentUrl: string | null;
        message: string;
      }>("/website/balance/request-addon", data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["website-balance"] });
      setSelectedAddon(null);
      setAddonNotes("");
      setPurchaseSuccess(data);
    },
  });

  const data = balanceQuery.data;
  const isLoading = balanceQuery.isLoading;
  const error = balanceQuery.error;

  const unpaidInvoices = data?.invoices.filter(
    (inv) => inv.status === "SENT" || inv.status === "OVERDUE"
  ) ?? [];

  const paidInvoices = data?.invoices.filter((inv) => inv.status === "PAID") ?? [];

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <PageHeader
        title="Balance & Invoices"
        subtitle="Manage your subscription, settle open invoices, track monthly AI usage, and order instant service add-ons."
        action={
          <div className="flex items-center gap-2">
            {data?.subscription?.manageUrl && (
              <a
                href={data.subscription.manageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center justify-center rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink shadow-2xs hover:bg-cream"
              >
                Manage Payment Card
              </a>
            )}
            <a
              href="mailto:support@dakyworld.com?subject=Billing%20Support%20Request"
              className="inline-flex h-9 items-center justify-center rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink shadow-2xs hover:bg-cream"
            >
              Contact Billing
            </a>
          </div>
        }
      />

      {error && (
        <div role="alert" className="mb-6 rounded-2xl bg-danger-surface p-4 text-sm text-danger-text">
          {error instanceof ApiError ? error.message : "Unable to load balance and invoice information."}
        </div>
      )}

      {isLoading && (
        <div className="space-y-4 py-8">
          <div className="h-28 animate-pulse rounded-2xl bg-[#EBECEF]" />
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="h-32 animate-pulse rounded-2xl bg-[#EBECEF]" />
            <div className="h-32 animate-pulse rounded-2xl bg-[#EBECEF]" />
            <div className="h-32 animate-pulse rounded-2xl bg-[#EBECEF]" />
            <div className="h-32 animate-pulse rounded-2xl bg-[#EBECEF]" />
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Status banner */}
          <div
            className={`mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl p-5 border ${
              data.summary.status === "OVERDUE"
                ? "border-red-300 bg-red-50 text-red-900"
                : data.summary.status === "OUTSTANDING"
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-emerald-200 bg-emerald-50 text-emerald-900"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-2xs text-lg">
                {data.summary.status === "OVERDUE" ? "⚠️" : data.summary.status === "OUTSTANDING" ? "📋" : "✓"}
              </span>
              <div>
                <p className="font-semibold text-sm">
                  {data.summary.status === "OVERDUE"
                    ? "Payment Overdue"
                    : data.summary.status === "OUTSTANDING"
                    ? "Invoice Ready for Payment"
                    : "Account in Good Standing"}
                </p>
                <p className="text-xs opacity-85 mt-0.5">
                  {data.summary.status === "OVERDUE"
                    ? "You have past-due balance. Settle now to maintain continuous website features."
                    : data.summary.status === "OUTSTANDING"
                    ? `You have ${unpaidInvoices.length} unpaid invoice${unpaidInvoices.length === 1 ? "" : "s"} totaling ${data.summary.currency} ${data.summary.outstandingAmount.toLocaleString()}.`
                    : "All current invoices are settled and your subscription is active."}
                </p>
              </div>
            </div>

            {unpaidInvoices.length > 0 && unpaidInvoices[0].paymentUrl && (
              <a
                href={unpaidInvoices[0].paymentUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center justify-center rounded-xl bg-ink px-4 text-xs font-semibold text-white shadow-2xs hover:bg-ink/90 transition"
              >
                Pay Outstanding ({data.summary.currency} {data.summary.outstandingAmount.toLocaleString()}) →
              </a>
            )}
          </div>

          {/* Top 4 KPI Metrics */}
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* 1. Outstanding Balance */}
            <div className="rounded-2xl border border-line bg-white p-5 shadow-2xs">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Outstanding Balance</span>
              <div className="mt-2 text-2xl font-bold tracking-tight text-ink">
                {data.summary.currency} {data.summary.outstandingAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </div>
              <p className="mt-1 text-xs text-muted">
                {unpaidInvoices.length === 0 ? "0 unpaid invoices" : `${unpaidInvoices.length} invoice${unpaidInvoices.length === 1 ? "" : "s"} pending payment`}
              </p>
            </div>

            {/* 2. Active Subscription / Tier */}
            <div className="rounded-2xl border border-line bg-white p-5 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">Active Plan</span>
                {data.subscription ? (
                  <Badge tone={data.subscription.status === "ACTIVE" ? "positive" : "info"}>
                    {data.subscription.status.replaceAll("_", " ")}
                  </Badge>
                ) : (
                  <Badge tone="muted">Standard</Badge>
                )}
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-ink">
                {data.subscription ? `${data.subscription.tierName}` : "Starter Plan"}
              </div>
              <p className="mt-1 text-xs text-muted">
                {data.subscription
                  ? `${data.subscription.currency} ${data.subscription.monthlyPrice.toLocaleString()}/${data.subscription.billingCycle}`
                  : "Basic Visual Editor"}
                {data.subscription?.nextBillingAt && ` · Renews ${new Date(data.subscription.nextBillingAt).toLocaleDateString()}`}
              </p>
            </div>

            {/* 3. AI Usage Meter */}
            <div className="rounded-2xl border border-line bg-white p-5 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">Monthly AI Prompts</span>
                <span className="text-xs font-semibold text-ink">
                  {data.aiUsage.promptsLimit >= 999999
                    ? `${data.aiUsage.promptsUsed} / ∞`
                    : `${data.aiUsage.promptsUsed} / ${data.aiUsage.promptsLimit}`}
                </span>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full transition-all ${
                    data.aiUsage.promptsPercent >= 90
                      ? "bg-red-500"
                      : data.aiUsage.promptsPercent >= 70
                      ? "bg-amber-500"
                      : "bg-blue"
                  }`}
                  style={{ width: `${Math.max(4, Math.min(100, data.aiUsage.promptsPercent))}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-muted">
                <span>{data.aiUsage.promptsRemaining} remaining</span>
                <button
                  type="button"
                  onClick={() => setSelectedAddon(data.availableAddons[0])}
                  className="font-semibold text-blue hover:underline"
                >
                  + Top Up
                </button>
              </div>
            </div>

            {/* 4. Lifetime Settled */}
            <div className="rounded-2xl border border-line bg-white p-5 shadow-2xs">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Lifetime Settled</span>
              <div className="mt-2 text-2xl font-bold tracking-tight text-ink">
                {data.summary.currency} {data.summary.paidLifetime.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </div>
              <p className="mt-1 text-xs text-muted">{data.summary.paidCount} settled payments</p>
            </div>
          </div>

          {/* Actionable Unpaid Invoices Section */}
          {unpaidInvoices.length > 0 && (
            <section className="mb-8" aria-label="Unpaid Invoices">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold text-ink">Open Invoices Requiring Payment</h2>
                  <p className="text-xs text-muted">Direct online payment via MTN Mobile Money, Telecel Cash, or Card.</p>
                </div>
              </div>

              <div className="space-y-3">
                {unpaidInvoices.map((inv) => (
                  <article
                    key={inv.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-line bg-white p-5 shadow-2xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-bold text-ink">{inv.invoiceNumber}</span>
                        <Badge tone={inv.status === "OVERDUE" ? "danger" : "warn"}>
                          {inv.status}
                        </Badge>
                        <span className="text-xs text-muted">
                          Due {new Date(inv.dueDate).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {inv.lineItems.map((li) => li.description).join(" · ") || "Website services"}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="text-right sm:mr-2">
                        <span className="block font-mono text-lg font-bold text-ink">
                          {inv.currency} {inv.amountTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      {inv.pdfUrl && (
                        <a
                          href={inv.pdfUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 items-center justify-center rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink hover:bg-cream"
                        >
                          📄 PDF
                        </a>
                      )}
                      {inv.paymentUrl ? (
                        <a
                          href={inv.paymentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 items-center justify-center rounded-xl bg-ink px-4 text-xs font-semibold text-white hover:bg-ink/90 shadow-2xs"
                        >
                          💳 Pay Now →
                        </a>
                      ) : (
                        <span className="text-xs text-muted">Manual Transfer</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {/* AI Usage & Resource Limits Breakdown */}
          <section className="mb-8 rounded-2xl border border-line bg-white p-6 shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
              <div>
                <h2 className="font-display text-lg font-bold text-ink">AI Assistant & Plan Allowances</h2>
                <p className="text-xs text-muted">
                  Usage cycle resets at the start of each month ({data.aiUsage.period}).
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-cream px-2.5 py-1 text-xs font-semibold text-ink">
                  {data.aiUsage.tierName} Tier
                </span>
                {data.aiUsage.canUpgrade && (
                  <a
                    href="mailto:support@dakyworld.com?subject=Upgrade%20Tier%20Request"
                    className="text-xs font-semibold text-blue hover:underline"
                  >
                    Upgrade Plan →
                  </a>
                )}
              </div>
            </div>

            <div className="mt-5 grid gap-6 sm:grid-cols-3">
              {/* AI Prompts */}
              <div className="rounded-xl border border-line/60 bg-cream/30 p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink">🤖 AI Copy & Layout Prompts</span>
                  <span className="font-mono text-muted">
                    {data.aiUsage.promptsLimit >= 999999 ? "Unlimited" : `${data.aiUsage.promptsUsed} / ${data.aiUsage.promptsLimit}`}
                  </span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-blue"
                    style={{ width: `${Math.max(3, Math.min(100, data.aiUsage.promptsPercent))}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  {data.aiUsage.promptsRemaining > 0
                    ? `${data.aiUsage.promptsRemaining} prompts available for drafting content and styling`
                    : "Monthly quota reached. Add an instant booster pack below."}
                </p>
              </div>

              {/* Page Imports */}
              <div className="rounded-xl border border-line/60 bg-cream/30 p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink">📥 HTML Page Imports</span>
                  <span className="font-mono text-muted">
                    {data.aiUsage.importsLimit >= 999999 ? "Unlimited" : `${data.aiUsage.importsUsed} / ${data.aiUsage.importsLimit}`}
                  </span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{
                      width: `${Math.max(3, Math.min(100, (data.aiUsage.importsUsed / (data.aiUsage.importsLimit || 1)) * 100))}%`,
                    }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  Import existing pages and funnels directly into the visual editor.
                </p>
              </div>

              {/* Page Edits */}
              <div className="rounded-xl border border-line/60 bg-cream/30 p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink">✏️ Page Edits & Saves</span>
                  <span className="font-mono text-muted">
                    {data.aiUsage.editsLimit >= 999999 ? "Unlimited" : `${data.aiUsage.editsUsed} / ${data.aiUsage.editsLimit}`}
                  </span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-purple-500"
                    style={{
                      width: `${Math.max(3, Math.min(100, (data.aiUsage.editsUsed / (data.aiUsage.editsLimit || 1)) * 100))}%`,
                    }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  Storage quota: <strong>{data.aiUsage.storageQuotaLabel}</strong> for images and media files.
                </p>
              </div>
            </div>
          </section>

          {/* Instant Add-on Services Store (Revenue Generator) */}
          <section className="mb-8" aria-label="Add-on Services">
            <div className="mb-3">
              <h2 className="font-display text-lg font-bold text-ink">Add-on Services & Capacity Boosters</h2>
              <p className="text-xs text-muted">Order instant developer hours, AI power packs, or technical optimizations with 1 click.</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {data.availableAddons.map((addon) => (
                <div
                  key={addon.id}
                  className="flex flex-col justify-between rounded-2xl border border-line bg-white p-5 shadow-2xs transition hover:border-[#1E293B]/40 hover:shadow-xs"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="rounded-md bg-lime/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink">
                        {addon.badge}
                      </span>
                      <span className="font-mono text-sm font-bold text-ink">
                        {addon.currency} {addon.amount.toLocaleString()}
                      </span>
                    </div>
                    <h3 className="mt-3 font-semibold text-sm text-ink">{addon.name}</h3>
                    <p className="mt-1 text-xs text-muted leading-relaxed">{addon.description}</p>
                  </div>

                  <div className="mt-4 pt-3 border-t border-line/60">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      onClick={() => setSelectedAddon(addon)}
                    >
                      Order Add-on →
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Settled Invoices History */}
          <section className="rounded-2xl border border-line bg-white p-6 shadow-2xs" aria-label="Invoice History">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-display text-lg font-bold text-ink">Billing & Payment History</h2>
                <p className="text-xs text-muted">All past settled invoices and receipts.</p>
              </div>
              <span className="text-xs text-muted">{paidInvoices.length} paid invoices</span>
            </div>

            {paidInvoices.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No settled invoices recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-line text-muted">
                      <th className="pb-3 font-semibold">Invoice #</th>
                      <th className="pb-3 font-semibold">Issue Date</th>
                      <th className="pb-3 font-semibold">Settled Date</th>
                      <th className="pb-3 font-semibold">Description</th>
                      <th className="pb-3 font-semibold">Amount</th>
                      <th className="pb-3 font-semibold">Status</th>
                      <th className="pb-3 font-semibold text-right">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {paidInvoices.map((inv) => (
                      <tr key={inv.id} className="hover:bg-cream/40 transition">
                        <td className="py-3 font-mono font-bold text-ink">{inv.invoiceNumber}</td>
                        <td className="py-3 text-muted">{new Date(inv.issueDate).toLocaleDateString()}</td>
                        <td className="py-3 text-muted">{inv.paidAt ? new Date(inv.paidAt).toLocaleDateString() : "—"}</td>
                        <td className="py-3 text-ink max-w-xs truncate">
                          {inv.lineItems.map((li) => li.description).join(", ") || "Website maintenance & subscription"}
                        </td>
                        <td className="py-3 font-mono font-semibold text-ink">
                          {inv.currency} {inv.amountTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td className="py-3">
                          <Badge tone="positive">PAID</Badge>
                        </td>
                        <td className="py-3 text-right">
                          {inv.pdfUrl ? (
                            <a
                              href={inv.pdfUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="font-semibold text-blue hover:underline"
                            >
                              Download PDF
                            </a>
                          ) : (
                            <span className="text-muted">Settled</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* Purchase Confirmation Modal */}
      {selectedAddon && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-xl">
            <h3 className="font-display text-lg font-bold text-ink">Confirm Add-on Order</h3>
            <p className="mt-1 text-xs text-muted">
              We will generate an invoice and immediate Paystack payment link for your account.
            </p>

            <div className="mt-4 rounded-xl border border-line bg-cream/40 p-4">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm text-ink">{selectedAddon.name}</span>
                <span className="font-mono text-base font-bold text-ink">
                  {selectedAddon.currency} {selectedAddon.amount.toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">{selectedAddon.description}</p>
            </div>

            <label className="mt-4 block text-xs font-semibold text-ink">
              Specific Instructions / Notes (Optional)
              <textarea
                value={addonNotes}
                onChange={(e) => setAddonNotes(e.target.value)}
                placeholder="e.g. Please apply hours to the landing page redesign..."
                className="mt-1.5 block w-full rounded-xl border border-line p-3 text-xs focus:border-ink focus:outline-none"
                rows={3}
              />
            </label>

            {orderAddonMutation.error && (
              <p role="alert" className="mt-3 text-xs text-danger-text">
                {orderAddonMutation.error instanceof ApiError
                  ? orderAddonMutation.error.message
                  : "Unable to process order. Please try again."}
              </p>
            )}

            <div className="mt-6 flex items-center justify-end gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={orderAddonMutation.isPending}
                onClick={() => setSelectedAddon(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={orderAddonMutation.isPending}
                onClick={() =>
                  orderAddonMutation.mutate({
                    addonId: selectedAddon.id,
                    notes: addonNotes,
                  })
                }
              >
                {orderAddonMutation.isPending ? "Generating Invoice..." : "Confirm & Pay →"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Success Modal with direct Paystack Link */}
      {purchaseSuccess && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-xl">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-2xl text-emerald-800">
              ✓
            </div>
            <h3 className="mt-4 font-display text-lg font-bold text-ink">Invoice Generated</h3>
            <p className="mt-1 text-xs text-muted leading-relaxed">{purchaseSuccess.message}</p>

            <div className="mt-4 rounded-xl border border-line bg-cream/40 p-4 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-muted">Invoice #:</span>
                <span className="font-bold text-ink">{purchaseSuccess.invoiceNumber}</span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-muted">Total:</span>
                <span className="font-bold text-ink">
                  {purchaseSuccess.currency} {purchaseSuccess.amount.toLocaleString()}
                </span>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <Button variant="secondary" size="sm" onClick={() => setPurchaseSuccess(null)}>
                Done
              </Button>
              {purchaseSuccess.paymentUrl && (
                <a
                  href={purchaseSuccess.paymentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center justify-center rounded-xl bg-ink px-4 text-xs font-semibold text-white hover:bg-ink/90 shadow-2xs"
                  onClick={() => setPurchaseSuccess(null)}
                >
                  Pay with Mobile Money / Card →
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
