import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import {
  Badge, Button, Drawer, EmptyState, Loading, Notice, PageHeader, RelativeTime,
  StatGrid, StatTile, Table, Td, Th, Thead, Tr,
} from "../components/ui";

/**
 * Orders: every checkout from dakyx.com, paid or not.
 *
 * One row per WebsitePurchase. The drawer is where an order is looked after —
 * its invoice and payment, the account it created, and the four things the
 * office actually does: move it on, ask Paystack again, send the buyer their
 * way in, and open the subscription in Paystack.
 */

export type OrderUser = { id: string; name: string; email: string; active: boolean; hasPassword: boolean };
export type Order = {
  id: string;
  createdAt: string;
  status: string;
  billingState: string;
  billingCycle: string;
  tier: string;
  businessName: string;
  contactName: string;
  email: string;
  phone: string | null;
  websiteUrl: string;
  notes: string | null;
  currency: string;
  setupPrice: string;
  monthlyPrice: string;
  standardRecurringPrice: string | null;
  setupPaidAt: string | null;
  activatedAt: string | null;
  nextBillingAt: string | null;
  providerSubscriptionCode: string | null;
  hasReusableCard: boolean;
  compatibilityStatus: string;
  product: { name: string; key: string };
  invoice: { id: string; invoiceNumber: string; status: string; amountTotal: string; currency: string; paidAt: string | null; paymentUrl: string | null } | null;
  user: OrderUser | null;
};
type Summary = {
  byStatus: Record<string, number>;
  collected: { currency: string; amount: number; payments: number }[];
  activeSubscriptions: number;
  mrr: { currency: string; amount: number }[];
};
type OrdersResponse = { orders: Order[]; summary: Summary; paymentAlerts: { id: string; event: string; error: string | null; createdAt: string; reviewRequired: boolean }[] };
type OrderDetail = {
  order: Order;
  payment: { reference: string; provider: string; amount: number; currency: string; state: string; createdAt: string; updatedAt: string } | null;
  receipts: { reference: string; amount: number; currency: string; paidAt: string }[];
  sites: { id: string; name: string; role: string }[];
};

export const ORDER_STATUSES = ["PAYMENT_PENDING", "SETUP_PAID", "SETUP_IN_PROGRESS", "READY", "ACTIVE", "FAILED", "CANCELLED"] as const;
const STATUS_LABEL: Record<string, string> = {
  PAYMENT_PENDING: "Awaiting payment",
  SETUP_PAID: "Paid",
  SETUP_IN_PROGRESS: "Setting up",
  READY: "Ready",
  ACTIVE: "Active",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};
const FILTERS: [string, string][] = [["ALL", "All"], ["PAID", "Paid"], ["UNPAID", "Unpaid"], ["ACTIVE", "Active"], ["SETUP_IN_PROGRESS", "Setting up"], ["CANCELLED", "Cancelled"]];

export function statusTone(status: string): "positive" | "info" | "warn" | "danger" | "muted" {
  if (status === "ACTIVE" || status === "READY") return "positive";
  if (status === "SETUP_PAID" || status === "SETUP_IN_PROGRESS") return "info";
  if (status === "PAYMENT_PENDING") return "warn";
  if (status === "FAILED") return "danger";
  return "muted";
}
export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status.replaceAll("_", " ").toLowerCase();

const amount = (currency: string, value: number | string) => `${currency} ${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const date = (value: string | null) => (value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : "That did not work. Try again.");

export function Orders() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [openId, setOpenId] = useState<string | null>(null);
  const params = new URLSearchParams({ status: filter, ...(q.trim() ? { q: q.trim() } : {}) });
  const orders = useQuery({
    queryKey: ["commerce-orders", filter, q.trim()],
    queryFn: ({ signal }) => api.get<OrdersResponse>(`/commerce/orders?${params}`, signal),
  });
  const summary = orders.data?.summary;
  const pending = summary?.byStatus.PAYMENT_PENDING ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sales"
        title="Orders"
        subtitle="Every checkout from dakyx.com: who bought what, whether the money arrived, and what happens next."
        action={<Link to="/customers" className="text-sm font-medium text-blue hover:underline">Customers →</Link>}
      />

      {summary && (
        <StatGrid columns={4}>
          <StatTile label="Active subscriptions" value={summary.activeSubscriptions} />
          <StatTile label="Monthly recurring" value={summary.mrr.length ? summary.mrr.map((m) => amount(m.currency, m.amount)).join(" · ") : "—"} />
          <StatTile label="Collected to date" value={summary.collected.length ? summary.collected.map((c) => amount(c.currency, c.amount)).join(" · ") : "—"} sub={`${summary.collected.reduce((n, c) => n + c.payments, 0)} payments`} />
          <StatTile label="Awaiting payment" value={pending} sub={pending ? "Checkouts not finished" : "None waiting"} />
        </StatGrid>
      )}

      {Boolean(orders.data?.paymentAlerts.length) && (
        <Notice tone="warn" title="Payment events need review">
          {orders.data!.paymentAlerts.slice(0, 5).map((alert) => (
            <span key={alert.id} className="block">{alert.event} · {date(alert.createdAt)}{alert.error ? ` — ${alert.error}` : ""}</span>
          ))}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search business, name, email, website or invoice"
          aria-label="Search orders"
          className="h-10 w-full max-w-sm rounded-[10px] border border-line-strong bg-white px-3 text-sm"
        />
        <div className="flex flex-wrap gap-1 rounded-[10px] bg-sunken p-1" role="group" aria-label="Filter orders">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`rounded-lg px-3 py-1.5 text-sm ${filter === key ? "bg-white font-medium text-ink shadow-xs" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {orders.isLoading && <Loading label="Loading orders" rows={5} />}
      {orders.error && <Notice tone="danger">{errorText(orders.error)}</Notice>}
      {orders.data && orders.data.orders.length === 0 && (
        <EmptyState message={q || filter !== "ALL" ? "No orders match that." : "No orders yet. A checkout on dakyx.com appears here the moment it starts."} />
      )}
      {orders.data && orders.data.orders.length > 0 && (
        <Table>
          <Thead>
            <Th>Order</Th>
            <Th>Customer</Th>
            <Th>Plan</Th>
            <Th>Status</Th>
            <Th align="right">Paid</Th>
            <Th align="right">Next billing</Th>
          </Thead>
          <tbody>
            {orders.data.orders.map((order) => (
              <Tr key={order.id} onClick={() => setOpenId(order.id)} className="cursor-pointer">
                <Td>
                  <span className="block font-medium">{order.businessName}</span>
                  <span className="text-xs text-muted">{order.invoice?.invoiceNumber ?? "No invoice"} · {date(order.createdAt)}</span>
                </Td>
                <Td>
                  <span className="block">{order.contactName}</span>
                  <span className="text-xs text-muted">{order.email}</span>
                </Td>
                <Td>
                  <span className="block">{order.product.name}</span>
                  <span className="text-xs text-muted">{amount(order.currency, order.monthlyPrice)}/{order.billingCycle === "annual" ? "mo, billed yearly" : "mo"}</span>
                </Td>
                <Td><Badge tone={statusTone(order.status)}>{statusLabel(order.status)}</Badge></Td>
                <Td align="right">{order.setupPaidAt ? date(order.setupPaidAt) : <span className="text-faint">Not yet</span>}</Td>
                <Td align="right">{date(order.nextBillingAt)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <OrderDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

export function OrderDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["commerce-order", id],
    enabled: Boolean(id),
    queryFn: ({ signal }) => api.get<OrderDetail>(`/commerce/orders/${id}`, signal),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["commerce-orders"] });
    qc.invalidateQueries({ queryKey: ["commerce-order", id] });
    qc.invalidateQueries({ queryKey: ["commerce-customers"] });
  };
  const setStatus = useMutation({
    mutationFn: (status: string) => api.patch(`/commerce/orders/${id}`, { status }),
    onSuccess: () => { setMessage("Status updated."); refresh(); },
  });
  const verify = useMutation({
    mutationFn: () => api.post<{ paid: boolean; changed: boolean }>(`/commerce/orders/${id}/verify-payment`, {}),
    onSuccess: (r) => { setMessage(r.paid ? (r.changed ? "Paystack confirmed the payment. The order is marked paid." : "Paystack confirms it is paid.") : "Paystack has no successful payment for this order yet."); refresh(); },
  });
  const resend = useMutation({
    mutationFn: () => api.post<{ sent: string; email: string }>(`/commerce/orders/${id}/resend-access`, {}),
    onSuccess: (r) => setMessage(r.sent === "SET_PASSWORD" ? `A set-password link was sent to ${r.email}.` : `A password reset link was sent to ${r.email}.`),
  });
  const billing = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/commerce/orders/${id}/manage-billing`, {}),
    onSuccess: ({ url }) => window.open(url, "_blank", "noopener"),
  });
  const error = setStatus.error || verify.error || resend.error || billing.error;
  const data = detail.data;
  const order = data?.order;

  return (
    <Drawer
      open={Boolean(id)}
      onClose={() => { setMessage(null); onClose(); }}
      wide
      title={order ? order.businessName : "Order"}
      subtitle={order ? `${order.product.name} · ordered ${date(order.createdAt)}` : undefined}
    >
      {detail.isLoading && <Loading label="Loading order" />}
      {detail.error && <Notice tone="danger">{errorText(detail.error)}</Notice>}
      {order && (
        <div className="space-y-6">
          {message && <Notice tone="positive">{message}</Notice>}
          {error && <Notice tone="danger">{errorText(error)}</Notice>}

          <section className="flex flex-wrap items-center gap-3">
            <Badge tone={statusTone(order.status)}>{statusLabel(order.status)}</Badge>
            <label className="flex items-center gap-2 text-sm text-muted">
              Move to
              <select
                aria-label="Order status"
                value={order.status}
                disabled={setStatus.isPending}
                onChange={(event) => setStatus.mutate(event.target.value)}
                className="h-9 rounded-[10px] border border-line-strong bg-white px-2 text-sm text-ink"
              >
                {ORDER_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            </label>
          </section>

          <Grid title="Customer">
            <Row label="Name">{order.contactName}</Row>
            <Row label="Email"><a className="text-blue hover:underline" href={`mailto:${order.email}`}>{order.email}</a></Row>
            <Row label="Phone">{order.phone ?? "—"}</Row>
            <Row label="Website"><a className="text-blue hover:underline" href={order.websiteUrl} target="_blank" rel="noreferrer">{order.websiteUrl}</a></Row>
            <Row label="Account">
              {order.user ? (
                <Link className="text-blue hover:underline" to={`/customers?open=${order.user.id}`}>
                  {order.user.email}{!order.user.hasPassword ? " · no password yet" : ""}{!order.user.active ? " · suspended" : ""}
                </Link>
              ) : "Not created"}
            </Row>
            {order.notes && <Row label="Notes">{order.notes}</Row>}
          </Grid>

          <Grid title="Plan and billing">
            <Row label="Plan">{order.product.name} ({order.tier.toLowerCase()})</Row>
            <Row label="Price">{amount(order.currency, order.monthlyPrice)} a month{order.billingCycle === "annual" ? ", billed yearly" : ""}{order.standardRecurringPrice ? ` · then ${amount(order.currency, order.standardRecurringPrice)}` : ""}</Row>
            <Row label="Setup">{Number(order.setupPrice) ? amount(order.currency, order.setupPrice) : "No setup fee"}</Row>
            <Row label="Paid">{order.setupPaidAt ? date(order.setupPaidAt) : "Not yet"}</Row>
            <Row label="Active since">{date(order.activatedAt)}</Row>
            <Row label="Next billing">{date(order.nextBillingAt)}</Row>
            <Row label="Billing state">{order.billingState.replaceAll("_", " ").toLowerCase()}{order.hasReusableCard ? " · card on file" : ""}</Row>
            <Row label="Compatibility">{order.compatibilityStatus.toLowerCase()}</Row>
          </Grid>

          <Grid title="Invoice and payment">
            <Row label="Invoice">{order.invoice ? `${order.invoice.invoiceNumber} · ${order.invoice.status.toLowerCase()} · ${amount(order.invoice.currency, order.invoice.amountTotal)}` : "None"}</Row>
            {order.invoice?.paymentUrl && !order.setupPaidAt && (
              <Row label="Payment link"><a className="text-blue hover:underline" href={order.invoice.paymentUrl} target="_blank" rel="noreferrer">Open the checkout</a></Row>
            )}
            <Row label="Paystack">{data.payment ? `${data.payment.reference} · ${data.payment.state.toLowerCase()} · opened ${date(data.payment.createdAt)}` : "Never opened"}</Row>
            <Row label="Payments received">
              {data.receipts.length ? data.receipts.map((r) => <span key={r.reference} className="block">{amount(r.currency, r.amount)} · {date(r.paidAt)} · <span className="text-muted">{r.reference}</span></span>) : "None"}
            </Row>
          </Grid>

          {data.sites.length > 0 && (
            <Grid title="Websites">
              {data.sites.map((s) => <Row key={s.id} label={s.role.toLowerCase()}>{s.name}</Row>)}
            </Grid>
          )}

          <section className="flex flex-wrap gap-2 border-t border-line pt-5">
            <Button variant="secondary" onClick={() => verify.mutate()} disabled={verify.isPending || !data.payment}>
              {verify.isPending ? "Checking…" : "Check payment with Paystack"}
            </Button>
            <Button variant="secondary" onClick={() => resend.mutate()} disabled={resend.isPending || !order.user || !order.setupPaidAt}>
              {resend.isPending ? "Sending…" : order.user?.hasPassword ? "Send password reset" : "Resend account link"}
            </Button>
            <Button variant="secondary" onClick={() => billing.mutate()} disabled={billing.isPending || !order.providerSubscriptionCode}>
              Manage subscription in Paystack
            </Button>
          </section>
        </div>
      )}
    </Drawer>
  );
}

export function Grid({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-[.14em] text-muted">{title}</h3>
      <dl className="divide-y divide-line rounded-2xl border border-line bg-white">{children}</dl>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 px-4 py-2.5 text-sm">
      <dt className="text-muted first-letter:uppercase">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

export { RelativeTime };
