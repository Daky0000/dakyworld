import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Badge, Button, Drawer, EmptyState, Loading, Notice, PageHeader, RelativeTime, Table, Td, Th, Thead, Tr } from "../components/ui";
import { Grid, OrderDrawer, Row, statusLabel, statusTone, type Order } from "./Orders";

/**
 * Customers: the accounts that buying created.
 *
 * Staff live on Team Access; this is everybody on the other side of a
 * checkout. The server refuses any change aimed at a staff or Owner account,
 * so nothing here can switch off a colleague.
 */

type CustomerRow = {
  id: string;
  name: string;
  email: string;
  active: boolean;
  emailVerified: boolean;
  hasPassword: boolean;
  createdAt: string;
  deletionScheduledFor: string | null;
  lastSeenAt: string | null;
  sites: number;
  orders: number;
  activeOrders: number;
  business: string | null;
  plan: string | null;
};
type CustomerDetail = {
  customer: {
    id: string; name: string; email: string; active: boolean; emailVerifiedAt: string | null; createdAt: string;
    deletionScheduledFor: string | null; hasPassword: boolean; twoFactor: boolean;
    sessions: { createdAt: string; lastRefreshedAt: string; expiresAt: string }[];
  };
  sites: { id: string; name: string; role: string }[];
  orders: Order[];
};

const STATES: [string, string][] = [["ALL", "All"], ["ACTIVE", "Active"], ["NO_PASSWORD", "No password yet"], ["SUSPENDED", "Suspended"], ["DELETING", "Deleting"]];
const date = (value: string | null) => (value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : "That did not work. Try again.");

function accountBadge(c: { active: boolean; hasPassword: boolean; deletionScheduledFor: string | null }) {
  if (c.deletionScheduledFor) return <Badge tone="danger">Deleting {date(c.deletionScheduledFor)}</Badge>;
  if (!c.active) return <Badge tone="muted">Suspended</Badge>;
  if (!c.hasPassword) return <Badge tone="warn">No password yet</Badge>;
  return <Badge tone="positive">Active</Badge>;
}

export function Customers() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [state, setState] = useState("ALL");
  const openId = params.get("open");
  const query = new URLSearchParams({ state, ...(q.trim() ? { q: q.trim() } : {}) });
  const customers = useQuery({
    queryKey: ["commerce-customers", state, q.trim()],
    queryFn: ({ signal }) => api.get<{ customers: CustomerRow[] }>(`/commerce/customers?${query}`, signal),
  });
  const open = (id: string | null) => setParams(id ? { open: id } : {}, { replace: true });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sales"
        title="Customers"
        subtitle="Everyone who has bought from dakyx.com: their account, their orders and their websites."
        action={<Link to="/orders" className="text-sm font-medium text-blue hover:underline">Orders →</Link>}
      />

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search name or email"
          aria-label="Search customers"
          className="h-10 w-full max-w-sm rounded-[10px] border border-line-strong bg-white px-3 text-sm"
        />
        <div className="flex flex-wrap gap-1 rounded-[10px] bg-sunken p-1" role="group" aria-label="Filter customers">
          {STATES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={state === key}
              onClick={() => setState(key)}
              className={`rounded-lg px-3 py-1.5 text-sm ${state === key ? "bg-white font-medium text-ink shadow-xs" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {customers.isLoading && <Loading label="Loading customers" rows={5} />}
      {customers.error && <Notice tone="danger">{errorText(customers.error)}</Notice>}
      {customers.data && customers.data.customers.length === 0 && (
        <EmptyState message={q || state !== "ALL" ? "No customers match that." : "No customers yet. An account is created the moment somebody checks out."} />
      )}
      {customers.data && customers.data.customers.length > 0 && (
        <Table>
          <Thead>
            <Th>Customer</Th>
            <Th>Business</Th>
            <Th>Plan</Th>
            <Th>Account</Th>
            <Th align="right">Last seen</Th>
            <Th align="right">Joined</Th>
          </Thead>
          <tbody>
            {customers.data.customers.map((c) => (
              <Tr key={c.id} onClick={() => open(c.id)} className="cursor-pointer">
                <Td>
                  <span className="block font-medium">{c.name}</span>
                  <span className="text-xs text-muted">{c.email}</span>
                </Td>
                <Td>{c.business ?? <span className="text-faint">—</span>}</Td>
                <Td>
                  <span className="block">{c.plan ?? "—"}</span>
                  <span className="text-xs text-muted">{c.orders} order{c.orders === 1 ? "" : "s"} · {c.sites} site{c.sites === 1 ? "" : "s"}</span>
                </Td>
                <Td>{accountBadge(c)}</Td>
                <Td align="right"><RelativeTime value={c.lastSeenAt} /></Td>
                <Td align="right">{date(c.createdAt)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <CustomerDrawer id={openId} onClose={() => open(null)} />
    </div>
  );
}

function CustomerDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [orderId, setOrderId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["commerce-customer", id],
    enabled: Boolean(id),
    queryFn: ({ signal }) => api.get<CustomerDetail>(`/commerce/customers/${id}`, signal),
  });
  const customer = detail.data?.customer;
  useEffect(() => {
    setMessage(null);
    setEditing(false);
  }, [id]);
  useEffect(() => {
    if (customer) { setName(customer.name); setEmail(customer.email); }
  }, [customer]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["commerce-customers"] });
    qc.invalidateQueries({ queryKey: ["commerce-customer", id] });
    qc.invalidateQueries({ queryKey: ["commerce-orders"] });
  };
  const save = useMutation({
    mutationFn: (body: { name?: string; email?: string; active?: boolean }) => api.patch(`/commerce/customers/${id}`, body),
    onSuccess: (_r, body) => {
      setEditing(false);
      setMessage(body.active === false ? "Account suspended and signed out everywhere." : body.active === true ? "Account restored." : "Details saved.");
      refresh();
    },
  });
  const sendAccess = useMutation({
    mutationFn: () => api.post<{ sent: string; email: string }>(`/commerce/customers/${id}/send-access`, {}),
    onSuccess: (r) => setMessage(r.sent === "SET_PASSWORD" ? `A set-password link was sent to ${r.email}.` : `A password reset link was sent to ${r.email}.`),
  });
  const signOut = useMutation({
    mutationFn: () => api.post(`/commerce/customers/${id}/sign-out`, {}),
    onSuccess: () => { setMessage("Signed out of every device."); refresh(); },
  });
  const error = save.error || sendAccess.error || signOut.error;

  return (
    <>
      <Drawer open={Boolean(id)} onClose={onClose} wide title={customer?.name ?? "Customer"} subtitle={customer?.email}>
        {detail.isLoading && <Loading label="Loading customer" />}
        {detail.error && <Notice tone="danger">{errorText(detail.error)}</Notice>}
        {customer && detail.data && (
          <div className="space-y-6">
            {message && <Notice tone="positive">{message}</Notice>}
            {error && <Notice tone="danger">{errorText(error)}</Notice>}

            <section className="flex flex-wrap items-center gap-2">
              {accountBadge(customer)}
              {customer.emailVerifiedAt ? <Badge tone="info">Email verified</Badge> : <Badge tone="muted">Email not verified</Badge>}
              {customer.twoFactor && <Badge tone="info">Two-factor on</Badge>}
            </section>

            {editing ? (
              <form
                className="space-y-3 rounded-2xl border border-line bg-white p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  save.mutate({ name: name.trim(), ...(email.trim().toLowerCase() !== customer.email ? { email: email.trim() } : {}) });
                }}
              >
                <label className="block text-sm">
                  <span className="text-xs font-medium uppercase tracking-[.14em] text-muted">Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 h-10 w-full rounded-[10px] border border-line-strong px-3" />
                </label>
                <label className="block text-sm">
                  <span className="text-xs font-medium uppercase tracking-[.14em] text-muted">Email</span>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="mt-1 h-10 w-full rounded-[10px] border border-line-strong px-3" />
                  <span className="mt-1 block text-xs text-muted">Changing it signs them out everywhere and marks the new address unverified.</span>
                </label>
                <div className="flex gap-2">
                  <Button type="submit" variant="accent" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
                  <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <Grid title="Account">
                <Row label="Name">{customer.name}</Row>
                <Row label="Email"><a className="text-blue hover:underline" href={`mailto:${customer.email}`}>{customer.email}</a></Row>
                <Row label="Joined">{date(customer.createdAt)}</Row>
                <Row label="Password">{customer.hasPassword ? "Set" : "Not chosen yet"}</Row>
                <Row label="Last seen">{customer.sessions[0] ? <RelativeTime value={customer.sessions[0].lastRefreshedAt} /> : "Never signed in"}</Row>
                <Row label="Signed in on">{customer.sessions.length ? `${customer.sessions.length} device${customer.sessions.length === 1 ? "" : "s"}` : "None"}</Row>
                {customer.deletionScheduledFor && <Row label="Deletion">Their details are erased on {date(customer.deletionScheduledFor)}</Row>}
              </Grid>
            )}

            <Grid title="Websites">
              {detail.data.sites.length ? detail.data.sites.map((s) => <Row key={s.id} label={s.role.toLowerCase()}>{s.name}</Row>) : <Row label="None">No website connected yet</Row>}
            </Grid>

            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-[.14em] text-muted">Orders</h3>
              {detail.data.orders.length ? (
                <ul className="divide-y divide-line rounded-2xl border border-line bg-white">
                  {detail.data.orders.map((o) => (
                    <li key={o.id}>
                      <button type="button" onClick={() => setOrderId(o.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-sunken">
                        <span>
                          <span className="block font-medium">{o.product.name} · {o.businessName}</span>
                          <span className="text-xs text-muted">{o.invoice?.invoiceNumber ?? "No invoice"} · {date(o.createdAt)}</span>
                        </span>
                        <Badge tone={statusTone(o.status)}>{statusLabel(o.status)}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">No orders on this account.</p>
              )}
            </section>

            <section className="flex flex-wrap gap-2 border-t border-line pt-5">
              {!editing && <Button variant="secondary" onClick={() => setEditing(true)}>Edit details</Button>}
              <Button variant="secondary" onClick={() => sendAccess.mutate()} disabled={sendAccess.isPending || !customer.active}>
                {sendAccess.isPending ? "Sending…" : customer.hasPassword ? "Send password reset" : "Send set-password link"}
              </Button>
              <Button variant="secondary" onClick={() => signOut.mutate()} disabled={signOut.isPending || !customer.sessions.length}>Sign out everywhere</Button>
              {customer.active ? (
                <Button
                  variant="danger"
                  disabled={save.isPending}
                  onClick={() => { if (window.confirm(`Suspend ${customer.name}? They are signed out and cannot sign in until restored. Their subscription is not cancelled.`)) save.mutate({ active: false }); }}
                >
                  Suspend account
                </Button>
              ) : (
                <Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate({ active: true })}>Restore account</Button>
              )}
            </section>
          </div>
        )}
      </Drawer>
      <OrderDrawer id={orderId} onClose={() => setOrderId(null)} />
    </>
  );
}
