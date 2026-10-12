/**
 * npx tsx checks/checkoutTokenScope.ts        (no database: prisma is stood in for)
 *
 * The payment-return page may hand a set-password token to the browser, and
 * only for an account the purchase itself created.
 *
 * Checkout looks an account up by the email the buyer typed, so a purchase can
 * point at somebody else's existing account. Before 10 Oct 2026 the return page
 * gave a token to any purchase whose account had no password yet, and a staff
 * member added on the Team screen without one, or anybody invited and not yet
 * signed in, could be taken over for the price of the cheapest plan. These are
 * driven over real HTTP through the real router, with the four Prisma models it
 * touches replaced by in-memory stand-ins, so the suite runs it with or without
 * a database.
 *
 * Only the browser that bought may be handed one, and the checkout key is how
 * it proves that: a UUID the checkout page made and kept in sessionStorage. The
 * Paystack reference rides in the callback address — browser history, Referer
 * headers, the receipt — so a lookup by reference alone learns paid or unpaid
 * and nothing else (12 Oct 2026).
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { prisma } from "../src/lib/prisma.js";
import { paymentReturnBase, publicProductsRouter } from "../src/routes/products.js";
import { completePasswordFromToken } from "../src/services/accountAccess.js";

let passed = 0;
async function check(name: string, test: () => Promise<void> | void) {
  await test();
  passed++;
  console.log(`  ok  ${name}`);
}

type Purchase = { id: string; setupPaidAt: Date | null; status: string; billingState: string; email: string; contactName: string; userId: string | null; invoiceId: string; accountCreated: boolean };
type Account = { id: string; email: string; name: string; passwordHash: string | null; emailVerifiedAt: Date | null; accessRole: null };

const CHECKOUT_KEY = "6f1b2a7e-3c1d-4f7a-9b2e-0c4d5e6f7a8b";
const REFERENCE = "T123456789012";

const state: {
  purchase: Purchase | null;
  account: Account | null;
  tokens: Array<{ data: Record<string, unknown> }>;
  tokenRow: { id: string; kind: string; usedAt: Date | null; expiresAt: Date; viaBrowser: boolean; user: Account } | null;
  userUpdates: Array<Record<string, unknown>>;
} = { purchase: null, account: null, tokens: [], tokenRow: null, userUpdates: [] };

/** A model whose unlisted methods throw, so a call nobody expected is a failure rather than a silent pass. */
function standIn(name: string, methods: Record<string, (...args: any[]) => unknown>) {
  return new Proxy(methods, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unexpected prisma.${name}.${String(prop)}()`); };
    },
  });
}

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(model: string, value: unknown) {
  originals.set(model, Object.getOwnPropertyDescriptor(prisma, model));
  Object.defineProperty(prisma, model, { configurable: true, value });
}

replace("websitePurchase", standIn("websitePurchase", {
  findUnique: async ({ where }: { where: { checkoutKey?: string } }) => (where.checkoutKey === CHECKOUT_KEY ? state.purchase : null),
  findFirst: async ({ where }: { where: { invoiceId?: string } }) => (state.purchase && where.invoiceId === state.purchase.invoiceId ? state.purchase : null),
}));
// The reference path: one Paystack attempt on the purchase's invoice, already
// paid, so settling it again is a no-op that never calls Paystack.
replace("paymentAttempt", standIn("paymentAttempt", {
  findUnique: async ({ where }: { where: { reference?: string } }) => (where.reference === REFERENCE ? { reference: REFERENCE, invoiceId: "invoice-1", provider: "paystack" } : null),
}));
replace("invoice", standIn("invoice", {
  findUnique: async ({ where }: { where: { id?: string } }) => (where.id === "invoice-1" ? { id: "invoice-1", status: "PAID", paymentProvider: "paystack" } : null),
  findFirst: async () => null,
}));
replace("user", standIn("user", {
  findUnique: async ({ where }: { where: { id?: string } }) => (state.account && where.id === state.account.id ? state.account : null),
  update: async ({ data }: { data: Record<string, unknown> }) => {
    state.userUpdates.push(data);
    return { ...state.account!, ...data };
  },
}));
replace("authToken", standIn("authToken", {
  updateMany: async () => ({ count: 1 }),
  create: async (args: { data: Record<string, unknown> }) => { state.tokens.push(args); return args.data; },
  findUnique: async () => state.tokenRow,
}));
replace("session", standIn("session", {
  deleteMany: async () => ({ count: 0 }),
}));
// Mail settings: none configured, so a confirmation email is written to the log
// rather than sent, which is what a laptop without SMTP does too.
replace("appSetting", standIn("appSetting", {
  findUnique: async () => null,
  findMany: async () => [],
  findFirst: async () => null,
}));

const app = express();
app.use(express.json());
app.use("/api/public", publicProductsRouter);
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error.message });
});
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

type ReturnBody = { paid?: boolean; token?: string | null; setPasswordUrl?: string | null; email?: string; name?: string };
async function returnPage(ask: { checkoutKey?: string; reference?: string } = { checkoutKey: CHECKOUT_KEY }): Promise<{ status: number; body: ReturnBody }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/public/website-payment-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://dakyx.com" },
    body: JSON.stringify(ask),
  });
  return { status: response.status, body: (await response.json()) as never };
}

function paidPurchase(accountCreated: boolean): Purchase {
  return {
    id: "purchase-1", setupPaidAt: new Date(), status: "SETUP_PAID", billingState: "NONE",
    email: "someone@example.com", contactName: "Buyer", userId: "account-1", invoiceId: "invoice-1", accountCreated,
  };
}
function account(passwordHash: string | null): Account {
  return { id: "account-1", email: "someone@example.com", name: "Some One", passwordHash, emailVerifiedAt: null, accessRole: null };
}
function reset() {
  state.tokens = [];
  state.userUpdates = [];
  state.tokenRow = null;
}

try {
  await check("an existing passwordless account is not handed to whoever paid", async () => {
    reset();
    state.purchase = paidPurchase(false);
    state.account = account(null);
    const { status, body } = await returnPage();
    assert.equal(status, 200);
    assert.equal(body.paid, true);
    assert.equal(body.token, null);
    assert.equal(body.setPasswordUrl, null);
    assert.equal(state.tokens.length, 0, "no token row may even be written");
  });

  await check("an account the purchase created gets a browser token", async () => {
    reset();
    state.purchase = paidPurchase(true);
    state.account = account(null);
    const { body } = await returnPage();
    assert.equal(typeof body.token, "string");
    assert.match(body.setPasswordUrl ?? "", /^https:\/\/editor\.dakyx\.com\/set-password\?token=/);
    assert.equal(state.tokens.length, 1);
    assert.equal(state.tokens[0]!.data.viaBrowser, true, "the token must be marked as shown to a browser");
    assert.equal(state.tokens[0]!.data.kind, "SET_PASSWORD");
  });

  await check("the checkout key and the reference together still get the token", async () => {
    reset();
    state.purchase = paidPurchase(true);
    state.account = account(null);
    const { body } = await returnPage({ checkoutKey: CHECKOUT_KEY, reference: REFERENCE });
    assert.equal(typeof body.token, "string");
    assert.equal(body.email, "someone@example.com");
    assert.equal(state.tokens.length, 1);
  });

  await check("a Paystack reference alone learns it was paid, and nothing that opens the account", async () => {
    reset();
    state.purchase = paidPurchase(true);
    state.account = account(null);
    const { status, body } = await returnPage({ reference: REFERENCE });
    assert.equal(status, 200);
    assert.equal(body.paid, true, "the reference still answers paid or unpaid");
    assert.equal(body.token, null);
    assert.equal(body.setPasswordUrl, null);
    assert.equal(body.email, undefined, "nor who paid");
    assert.equal(body.name, undefined);
    assert.equal(state.tokens.length, 0, "no token row may even be written");
  });

  await check("a reference beside somebody else's checkout key gets no token", async () => {
    reset();
    state.purchase = paidPurchase(true);
    state.account = account(null);
    const { body } = await returnPage({ checkoutKey: "0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a", reference: REFERENCE });
    assert.equal(body.paid, true);
    assert.equal(body.token, null);
    assert.equal(body.setPasswordUrl, null);
    assert.equal(state.tokens.length, 0);
  });

  await check("an unpaid purchase found by reference says so", async () => {
    reset();
    state.purchase = { ...paidPurchase(true), setupPaidAt: null, status: "PAYMENT_PENDING" };
    state.account = account(null);
    const { body } = await returnPage({ reference: REFERENCE });
    assert.equal(body.paid, false);
    assert.equal(state.tokens.length, 0);
  });

  await check("a reference that matches nothing finds nothing", async () => {
    reset();
    state.purchase = paidPurchase(true);
    const { status } = await returnPage({ reference: "T000000000000" });
    assert.equal(status, 404);
  });

  await check("an account that already has a password gets no token, even one the purchase made", async () => {
    reset();
    state.purchase = paidPurchase(true);
    state.account = account("scrypt$already-set");
    const { body } = await returnPage();
    assert.equal(body.token, null);
    assert.equal(state.tokens.length, 0);
  });

  await check("an unpaid purchase gets no token", async () => {
    reset();
    state.purchase = { ...paidPurchase(true), setupPaidAt: null, status: "PAYMENT_PENDING" };
    state.account = account(null);
    const { body } = await returnPage();
    assert.equal(body.paid, false);
    assert.equal(body.token, undefined);
    assert.equal(state.tokens.length, 0);
  });

  await check("redeeming a browser token sets the password and leaves the address unconfirmed", async () => {
    reset();
    state.account = account(null);
    state.tokenRow = { id: "token-1", kind: "SET_PASSWORD", usedAt: null, expiresAt: new Date(Date.now() + 60_000), viaBrowser: true, user: state.account };
    await completePasswordFromToken("a-browser-token-value", "a long enough passphrase", "SET_PASSWORD");
    assert.equal(state.userUpdates.length, 1);
    assert.equal(typeof state.userUpdates[0]!.passwordHash, "string");
    assert.equal(state.userUpdates[0]!.emailVerifiedAt, null, "a browser token proves a payment, not an inbox");
    assert.equal(state.tokens.at(-1)?.data.kind, "EMAIL_VERIFICATION", "the address is confirmed by email instead");
  });

  await check("redeeming an emailed token still confirms the address", async () => {
    reset();
    state.account = account(null);
    state.tokenRow = { id: "token-2", kind: "SET_PASSWORD", usedAt: null, expiresAt: new Date(Date.now() + 60_000), viaBrowser: false, user: state.account };
    await completePasswordFromToken("an-emailed-token-value", "a long enough passphrase", "SET_PASSWORD");
    assert.ok(state.userUpdates[0]!.emailVerifiedAt instanceof Date);
    assert.equal(state.tokens.length, 0, "no second email for an address the link already proved");
  });

  await check("in production the caller's Origin never decides where the password link points", () => {
    const fallback = "https://editor.dakyx.com";
    assert.equal(paymentReturnBase("http://localhost:5173", true, fallback), fallback);
    assert.equal(paymentReturnBase("https://localhost.attacker.example", true, fallback), fallback);
    assert.equal(paymentReturnBase("http://localhost:5173/checkout", false, fallback), "http://localhost:5173");
    assert.equal(paymentReturnBase("https://localhost.attacker.example", false, fallback), fallback, "a hostname that merely contains localhost is not local");
    assert.equal(paymentReturnBase("not a url", false, fallback), fallback);
  });

  console.log(`checkoutTokenScope: ${passed} passed`);
} finally {
  server.close();
  for (const [model, descriptor] of originals) {
    if (descriptor) Object.defineProperty(prisma, model, descriptor);
    else delete (prisma as unknown as Record<string, unknown>)[model];
  }
  await prisma.$disconnect().catch(() => {});
}
