import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Badge, Button, PageHeader } from "../components/ui";
import {
  IconAlertCircle,
  IconCheck,
  IconCreditCard,
  IconDownload,
  IconEdit,
  IconFileText,
  IconSparkles,
} from "../components/WebsiteIcons";
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
    queryFn: ({ signal }) => api.get<WebsiteBalanceReport>("/website/balance", signal),
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
              href="mailto:support@dakyx.com?subject=Billing%20Support%20Request"
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
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-2xs">
                {data.summary.status === "OVERDUE" ? (
                  <IconAlertCircle size={20} className="text-red-600" />
                ) : data.summary.status === "OUTSTANDING" ? (
                  <IconFileText size={20} className="text-amber-600" />
                ) : (
                  <IconCheck size={20} className="text-emerald-600" />
                )}
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

            {/* 3. AI credits: the month's, then bought ones */}
            <div className="rounded-2xl border border-line bg-white p-5 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">AI credits left</span>
                <span className="text-xs font-semibold text-ink">{data.aiUsage.creditsLeft.toLocaleString()}</span>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-cream">
                <div
                  className={`h-full rounded-full transition-all ${data.aiUsage.promptsPercent >= 90 ? "bg-danger" : data.aiUsage.promptsPercent >= 70 ? "bg-warn" : "bg-blue"}`}
                  style={{ width: `${Math.max(4, Math.min(100, data.aiUsage.promptsPercent))}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
                <span>{data.aiUsage.promptsRemaining} of {data.aiUsage.promptsLimit} this month · {data.aiUsage.creditsBought.toLocaleString()} bought</span>
                <button
                  type="button"
                  onClick={() => setSelectedAddon(data.availableAddons.find((addon) => addon.credits) ?? null)}
                  className="shrink-0 font-semibold text-blue hover:underline"
                >
                  + Buy credits
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
                          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink hover:bg-cream"
                        >
                          <IconFileText size={13} /> PDF
                        </a>
                      )}
                      {inv.paymentUrl ? (
                        <a
                          href={inv.paymentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-ink px-4 text-xs font-semibold text-white hover:bg-ink/90 shadow-2xs"
                        >
                          <IconCreditCard size={13} /> Pay Now →
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
                    href="mailto:support@dakyx.com?subject=Upgrade%20Tier%20Request"
                    className="text-xs font-semibold text-blue hover:underline"
                  >
                    Upgrade Plan →
                  </a>
                )}
              </div>
            </div>

            <div className="mt-5 grid gap-6 sm:grid-cols-3">
              {/* AI credits */}
              <div className="rounded-xl border border-line/60 bg-cream/30 p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-semibold text-ink">
                    <IconSparkles size={14} className="text-blue" />
                    AI credits
                  </span>
                  <span className="font-mono text-muted">{data.aiUsage.promptsUsed} / {data.aiUsage.promptsLimit} this month</span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-blue" style={{ width: `${Math.max(3, Math.min(100, data.aiUsage.promptsPercent))}%` }} />
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  {data.aiUsage.promptsRemaining} of the month's credits left, then {data.aiUsage.creditsBought.toLocaleString()} bought.{" "}
                  {data.aiUsage.creditsLeft > 0 ? "" : "None left: buy a pack below — bought credits never expire."}
                </p>
              </div>

              {/* Page Imports */}
              <div className="rounded-xl border border-line/60 bg-cream/30 p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-semibold text-ink">
                    <IconDownload size={14} className="text-emerald-600" />
                    HTML Page Imports
                  </span>
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
                  <span className="flex items-center gap-1.5 font-semibold text-ink">
                    <IconEdit size={14} className="text-purple-600" />
                    Page Edits & Saves
                  </span>
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
          {/* How credits are spent, and where they went */}
          <section className="mb-8 rounded-2xl border border-line bg-white p-6 shadow-2xs" aria-label="AI credit history">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
              <div>
                <h2 className="font-display text-lg font-bold text-ink">AI credits</h2>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
                  The Builder agent and the design assistant spend credits. Free AI models answer first and cost 1 credit; when they cannot, a paid model takes over and costs 2, 3 or 5 by how big the request is. Undo, a site-wide font or colour swap and adding a ready-made section cost nothing. The month's credits are spent first and come back on the 1st; bought credits never expire.
                </p>
              </div>
              <span className="rounded-lg bg-cream px-2.5 py-1 text-xs font-semibold text-ink">{data.aiUsage.creditsLeft.toLocaleString()} left</span>
            </div>
            {data.aiUsage.creditHistory.length === 0 ? (
              <p className="mt-4 text-xs text-muted">Nothing spent or bought yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line/60">
                {data.aiUsage.creditHistory.map((entry) => {
                  const change = entry.planDelta + entry.boughtDelta;
                  return (
                    <li key={entry.id} className="flex items-center justify-between gap-4 py-2 text-xs">
                      <span className="min-w-0 truncate text-ink">{entry.note}</span>
                      <span className="flex shrink-0 items-center gap-3 text-muted">
                        <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
                        <span className={`w-14 text-right font-mono font-semibold ${change > 0 ? "text-positive-text" : "text-ink"}`}>{change > 0 ? `+${change}` : change}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="mb-8" aria-label="Add-on Services">
            <div className="mb-3">
              <h2 className="font-display text-lg font-bold text-ink">Add-on Services & Capacity Boosters</h2>
              <p className="text-xs text-muted">AI credit packs are added as soon as the invoice is paid and never expire. Developer hours and audits are scheduled by the team.</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {data.availableAddons.map((addon) => (
                <div
                  key={addon.id}
                  className="flex flex-col justify-between rounded-2xl border border-line bg-white p-5 shadow-2xs transition hover:border-[#1E293B]/40 hover:shadow-xs"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="rounded-md bg-positive-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink">
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
                      {addon.credits ? "Buy credits →" : "Order Add-on →"}
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
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800">
              <IconCheck size={24} />
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
