import { Router } from "express";
import { z } from "zod";
import type { Prisma, WebsitePurchaseStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requirePermission } from "../middleware/auth.js";
import { revokeAllSessionsFor } from "../lib/session.js";
import { subscriptionManagementLink } from "../lib/paystack.js";
import { publicPurchase, updatePurchaseStatus } from "../services/websiteCommerce.js";
import { settleFromProvider } from "../services/payments.js";
import { requestPasswordReset, sendSetPasswordLink } from "../services/accountAccess.js";

/**
 * Orders and customers: what happens after somebody pays.
 *
 * A checkout on dakyx.com writes a WebsitePurchase, raises an Invoice, opens a
 * Paystack PaymentAttempt and creates (or finds) the buyer's User. Until now the
 * only window onto any of that was a hidden list. This router is the office's
 * side of it: find an order, see whether the money arrived, nudge it along, and
 * look after the person who bought it.
 *
 * Everything here needs `website.manage`, the permission that already governed
 * the purchase list, and external (customer) accounts never reach it at all —
 * `scopeExternal` refuses them before this router runs.
 *
 * **Customers are only ever customers.** Every write to an account checks that
 * the account is an external one (or has no role and owns a purchase), is not
 * the person asking, and is not an Owner. Without that, "suspend customer" is a
 * button that can switch off a colleague, or the last Owner.
 */
export const commerceRouter = Router();

const STATUSES = ["PAYMENT_PENDING", "SETUP_PAID", "SETUP_IN_PROGRESS", "READY", "ACTIVE", "FAILED", "CANCELLED"] as const;

const ORDER_INCLUDE = {
  product: { select: { name: true, key: true } },
  invoice: { select: { id: true, invoiceNumber: true, status: true, amountTotal: true, currency: true, paidAt: true, paymentUrl: true, dueDate: true } },
  user: { select: { id: true, name: true, email: true, active: true, passwordHash: true } },
} satisfies Prisma.WebsitePurchaseInclude;

type OrderRow = Prisma.WebsitePurchaseGetPayload<{ include: typeof ORDER_INCLUDE }>;

/** An order as the screen sees it: no card authorisation, no password hash. */
function orderView(row: OrderRow) {
  const { user, ...rest } = row;
  return {
    ...publicPurchase(rest),
    user: user ? { id: user.id, name: user.name, email: user.email, active: user.active, hasPassword: Boolean(user.passwordHash) } : null,
  };
}

const money = (value: Prisma.Decimal | number | string | null | undefined) => Number(value ?? 0);

// --- Orders --------------------------------------------------------------------

const orderQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum([...STATUSES, "ALL", "PAID", "UNPAID"]).optional(),
});

commerceRouter.get("/orders", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const { q, status } = orderQuery.parse(req.query);
    const where: Prisma.WebsitePurchaseWhereInput = {};
    if (status === "PAID") where.setupPaidAt = { not: null };
    else if (status === "UNPAID") where.setupPaidAt = null;
    else if (status && status !== "ALL") where.status = status;
    if (q) {
      where.OR = [
        { businessName: { contains: q, mode: "insensitive" } },
        { contactName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { websiteUrl: { contains: q, mode: "insensitive" } },
        { invoice: { invoiceNumber: { contains: q, mode: "insensitive" } } },
      ];
    }

    const [rows, byStatus, receipts, active, alerts] = await Promise.all([
      prisma.websitePurchase.findMany({ where, include: ORDER_INCLUDE, orderBy: { createdAt: "desc" }, take: 300 }),
      prisma.websitePurchase.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.paymentReceipt.groupBy({ by: ["currency"], _sum: { amount: true }, _count: { _all: true } }),
      prisma.websitePurchase.findMany({ where: { status: "ACTIVE" }, select: { currency: true, monthlyPrice: true, billingCycle: true, standardRecurringPrice: true } }),
      prisma.paystackEvent.findMany({
        where: { OR: [{ error: { not: null } }, { reviewRequired: true }] },
        select: { id: true, event: true, error: true, createdAt: true, reviewRequired: true },
        take: 20,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Monthly recurring revenue, per currency. An annual plan counts as a
    // twelfth of its renewal price, because that is what it is worth a month.
    const mrr: Record<string, number> = {};
    for (const row of active) {
      const monthly = row.billingCycle === "annual" && row.standardRecurringPrice ? money(row.standardRecurringPrice) / 12 : money(row.monthlyPrice);
      mrr[row.currency] = (mrr[row.currency] ?? 0) + monthly;
    }

    res.json({
      orders: rows.map(orderView),
      summary: {
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        collected: receipts.map((r) => ({ currency: r.currency, amount: money(r._sum.amount), payments: r._count._all })),
        activeSubscriptions: active.length,
        mrr: Object.entries(mrr).map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })),
      },
      paymentAlerts: alerts,
    });
  } catch (error) { next(error); }
});

commerceRouter.get("/orders/:id", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const row = await prisma.websitePurchase.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
    if (!row) return res.status(404).json({ error: "That order no longer exists." });
    const [attempt, receipts, sites] = await Promise.all([
      row.invoiceId
        ? prisma.paymentAttempt.findUnique({ where: { invoiceId: row.invoiceId }, select: { reference: true, provider: true, amount: true, currency: true, state: true, createdAt: true, updatedAt: true } })
        : null,
      prisma.paymentReceipt.findMany({ where: { purchaseId: row.id }, orderBy: { paidAt: "desc" } }),
      row.userId
        ? prisma.siteMember.findMany({ where: { userId: row.userId }, select: { role: true, site: { select: { id: true, name: true } } } })
        : [],
    ]);
    res.json({
      order: orderView(row),
      payment: attempt ? { ...attempt, amount: money(attempt.amount) } : null,
      receipts: receipts.map((r) => ({ ...r, amount: money(r.amount) })),
      sites: sites.map((s) => ({ id: s.site.id, name: s.site.name, role: s.role })),
    });
  } catch (error) { next(error); }
});

commerceRouter.patch("/orders/:id", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(STATUSES) }).parse(req.body);
    // The same function the old list used, so the rules about cancelling a
    // live subscription or activating without a card are enforced once.
    res.json(await updatePurchaseStatus(req.params.id, status as WebsitePurchaseStatus));
  } catch (error) { next(error); }
});

/** Asks Paystack again. For the order that says unpaid when the customer says they paid. */
commerceRouter.post("/orders/:id/verify-payment", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const row = await prisma.websitePurchase.findUnique({ where: { id: req.params.id }, select: { invoiceId: true } });
    if (!row) return res.status(404).json({ error: "That order no longer exists." });
    const attempt = row.invoiceId ? await prisma.paymentAttempt.findUnique({ where: { invoiceId: row.invoiceId } }) : null;
    if (!attempt) return res.status(409).json({ error: "No payment was ever opened for this order, so there is nothing to check." });
    const result = await settleFromProvider(attempt.reference, "paystack");
    const after = await prisma.websitePurchase.findUnique({ where: { id: req.params.id }, select: { setupPaidAt: true, status: true } });
    res.json({ paid: Boolean(after?.setupPaidAt), status: after?.status, changed: Boolean(result?.changed) });
  } catch (error) { next(error); }
});

/** Sends the buyer their way in again: a set-password link, or a reset if they already chose one. */
commerceRouter.post("/orders/:id/resend-access", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const row = await prisma.websitePurchase.findUnique({ where: { id: req.params.id }, select: { userId: true, setupPaidAt: true } });
    if (!row?.userId) return res.status(409).json({ error: "This order has no account attached yet." });
    if (!row.setupPaidAt) return res.status(409).json({ error: "The payment has not been confirmed, so no account link is sent yet." });
    res.json(await sendAccessLink(row.userId));
  } catch (error) {
    if (fail(res, error)) return;
    next(error);
  }
});

commerceRouter.post("/orders/:id/manage-billing", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const row = await prisma.websitePurchase.findUnique({ where: { id: req.params.id }, select: { providerSubscriptionCode: true } });
    if (!row?.providerSubscriptionCode) return res.status(409).json({ error: "There is no Paystack subscription on this order yet." });
    res.set("Cache-Control", "no-store").json({ url: await subscriptionManagementLink(row.providerSubscriptionCode) });
  } catch (error) { next(error); }
});

// --- Customers -----------------------------------------------------------------

/** Who counts as a customer: an external account, or an unroled one that bought something. */
const CUSTOMER_WHERE: Prisma.UserWhereInput = {
  OR: [{ accessRole: { external: true } }, { accessRoleId: null, websiteSubscriptions: { some: {} } }],
};

const customerQuery = z.object({
  q: z.string().trim().max(120).optional(),
  state: z.enum(["ALL", "ACTIVE", "SUSPENDED", "NO_PASSWORD", "DELETING"]).optional(),
});

commerceRouter.get("/customers", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const { q, state } = customerQuery.parse(req.query);
    const and: Prisma.UserWhereInput[] = [CUSTOMER_WHERE];
    if (q) and.push({ OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] });
    if (state === "ACTIVE") and.push({ active: true, deletionScheduledFor: null });
    if (state === "SUSPENDED") and.push({ active: false, deletionScheduledFor: null });
    if (state === "NO_PASSWORD") and.push({ passwordHash: null });
    if (state === "DELETING") and.push({ deletionScheduledFor: { not: null } });

    const users = await prisma.user.findMany({
      where: { AND: and },
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true, name: true, email: true, active: true, emailVerifiedAt: true, passwordHash: true, createdAt: true, deletionScheduledFor: true,
        sessions: { select: { lastRefreshedAt: true }, orderBy: { lastRefreshedAt: "desc" }, take: 1 },
        websiteSubscriptions: { select: { id: true, status: true, businessName: true, currency: true, monthlyPrice: true, product: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
        _count: { select: { siteMemberships: true } },
      },
    });

    res.json({
      customers: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        active: u.active,
        emailVerified: Boolean(u.emailVerifiedAt),
        hasPassword: Boolean(u.passwordHash),
        createdAt: u.createdAt,
        deletionScheduledFor: u.deletionScheduledFor,
        lastSeenAt: u.sessions[0]?.lastRefreshedAt ?? null,
        sites: u._count.siteMemberships,
        orders: u.websiteSubscriptions.length,
        activeOrders: u.websiteSubscriptions.filter((s) => s.status === "ACTIVE").length,
        business: u.websiteSubscriptions[0]?.businessName ?? null,
        plan: u.websiteSubscriptions.find((s) => s.status === "ACTIVE")?.product.name ?? u.websiteSubscriptions[0]?.product.name ?? null,
      })),
    });
  } catch (error) { next(error); }
});

commerceRouter.get("/customers/:id", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { AND: [{ id: req.params.id }, CUSTOMER_WHERE] },
      select: {
        id: true, name: true, email: true, active: true, emailVerifiedAt: true, passwordHash: true, createdAt: true, deletionScheduledFor: true,
        totpConfirmedAt: true,
        sessions: { select: { createdAt: true, lastRefreshedAt: true, expiresAt: true }, orderBy: { lastRefreshedAt: "desc" }, take: 5 },
        siteMemberships: { select: { role: true, site: { select: { id: true, name: true } } } },
      },
    });
    if (!user) return res.status(404).json({ error: "That customer no longer exists." });
    const orders = await prisma.websitePurchase.findMany({ where: { userId: user.id }, include: ORDER_INCLUDE, orderBy: { createdAt: "desc" } });
    const { passwordHash, siteMemberships, ...rest } = user;
    res.json({
      customer: { ...rest, hasPassword: Boolean(passwordHash), twoFactor: Boolean(user.totpConfirmedAt) },
      sites: siteMemberships.map((s) => ({ id: s.site.id, name: s.site.name, role: s.role })),
      orders: orders.map(orderView),
    });
  } catch (error) { next(error); }
});

/**
 * Loads the account a write is aimed at and refuses anything that is not a
 * customer, is the caller, or is an Owner. Throws a status-carrying error the
 * handler turns into a response.
 */
export async function customerForWrite(id: string, actorId: string | undefined) {
  const user = await prisma.user.findFirst({
    where: { AND: [{ id }, CUSTOMER_WHERE] },
    select: { id: true, name: true, email: true, active: true, passwordHash: true, accessRole: { select: { superAdmin: true } } },
  });
  if (!user) throw Object.assign(new Error("That account is not a customer account, so it is managed on Team Access instead."), { status: 404 });
  if (user.id === actorId) throw Object.assign(new Error("You cannot change your own account from here."), { status: 409 });
  if (user.accessRole?.superAdmin) throw Object.assign(new Error("An Owner account is never managed as a customer."), { status: 409 });
  return user;
}

function fail(res: import("express").Response, error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (!status) return false;
  res.status(status).json({ error: (error as Error).message });
  return true;
}

async function sendAccessLink(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, active: true, passwordHash: true } });
  if (!user) throw Object.assign(new Error("That account no longer exists."), { status: 404 });
  if (!user.active) throw Object.assign(new Error("This account is suspended. Restore it before sending a link."), { status: 409 });
  if (user.passwordHash) {
    await requestPasswordReset(user.email);
    return { sent: "PASSWORD_RESET" as const, email: user.email };
  }
  await sendSetPasswordLink(user, "purchase");
  return { sent: "SET_PASSWORD" as const, email: user.email };
}

const customerEdit = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  active: z.boolean().optional(),
});

commerceRouter.patch("/customers/:id", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const body = customerEdit.parse(req.body);
    const user = await customerForWrite(req.params.id, req.dbUser?.id);
    const data: Prisma.UserUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.active !== undefined) data.active = body.active;
    if (body.email !== undefined && body.email !== user.email) {
      const taken = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
      if (taken) return res.status(409).json({ error: "Another account already uses that email address." });
      // A new address has not been proved to belong to them yet.
      data.email = body.email;
      data.emailVerifiedAt = null;
    }
    const updated = await prisma.user.update({ where: { id: user.id }, data, select: { id: true, name: true, email: true, active: true } });
    // Suspending, or moving the account to another inbox, signs it out
    // everywhere: a session opened under the old arrangement should not outlive it.
    if (body.active === false || data.email) await revokeAllSessionsFor(user.id);
    res.json({ customer: updated });
  } catch (error) {
    if (fail(res, error)) return;
    next(error);
  }
});

commerceRouter.post("/customers/:id/send-access", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const user = await customerForWrite(req.params.id, req.dbUser?.id);
    res.json(await sendAccessLink(user.id));
  } catch (error) {
    if (fail(res, error)) return;
    next(error);
  }
});

commerceRouter.post("/customers/:id/sign-out", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const user = await customerForWrite(req.params.id, req.dbUser?.id);
    await revokeAllSessionsFor(user.id);
    res.json({ signedOut: true });
  } catch (error) {
    if (fail(res, error)) return;
    next(error);
  }
});
