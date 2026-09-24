import crypto from "node:crypto";
import { SETTING, getSetting } from "./settings.js";

/**
 * Paystack — the hosted payment page.
 *
 * Stripe does not acquire in Ghana. Every invoice, proposal and care plan in
 * this system is denominated in GHS, and until now none of them could actually
 * be paid: the invoice template took a payment block and nothing supplied one,
 * so a real invoice printed with no way to settle it.
 *
 * Paystack answers that with one link that accepts a card, mobile money or a
 * bank transfer, which is the thing that goes in an email. Hubtel
 * (`lib/hubtel.ts`) answers the other half — a prompt that arrives on the
 * client's phone.
 *
 * Spoken to over `fetch` rather than an SDK, like the three non-Anthropic model
 * vendors: the surface used here is three endpoints.
 *
 * **Amounts are in pesewas.** Paystack takes the minor unit, always, and the
 * mistake is silent in both directions — an invoice for GHS 4,500 sent as 4500
 * charges GHS 45. Every crossing of that boundary goes through `toMinor` and
 * `fromMinor` here rather than at the call sites.
 */

// Never send merchant credentials to a configurable host or follow redirects.
const BASE = "https://api.paystack.co";

export class PaystackError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "PaystackError";
  }
}

export async function paystackConfigured(): Promise<boolean> {
  return Boolean(await getSetting(SETTING.PAYSTACK_SECRET_KEY));
}

async function secretKey(): Promise<string> {
  const key = await getSetting(SETTING.PAYSTACK_SECRET_KEY);
  if (!key) throw new PaystackError("Paystack isn't connected. Add a secret key under Settings → Payments.", 503);
  return key;
}

/** GHS 45.50 → 4550. Paystack works entirely in the minor unit. */
export function toMinor(amount: number): number {
  const minor = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(minor) || minor <= 0 || Math.abs(amount * 100 - minor) > 0.00001) {
    throw new PaystackError("Enter a positive amount with at most two decimal places.", 400);
  }
  return minor;
}

/** 4550 → 45.50, for anything read back off Paystack. */
export function fromMinor(minor: number): number {
  return Math.round(minor) / 100;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const key = await secretKey();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      signal: AbortSignal.timeout(12_000),
      redirect: "error",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    throw new PaystackError("Paystack could not be reached. Payment status may be pending; check before trying again.", 503);
  }

  let text: string;
  try { text = await response.text(); } catch { throw new PaystackError("Paystack response timed out. Check payment status before retrying.", 503); }
  let payload: PaystackEnvelope<T> | null = null;
  try {
    payload = JSON.parse(text) as PaystackEnvelope<T>;
  } catch {
    // Paystack answers JSON for everything it handles, so a non-JSON body is a
    // gateway or a WAF between here and them. Say that rather than "invalid
    // JSON", which sends whoever reads it looking in the wrong place.
    throw new PaystackError(`Paystack answered ${response.status} with something that wasn't JSON.`);
  }

  if (!response.ok || !payload || payload.status !== true) {
    if (response.status === 401 || response.status === 403) throw new PaystackError("Paystack credentials or payment permissions need attention. Contact support.", 503);
    if (response.status === 429) throw new PaystackError("Paystack is busy. Wait before checking the payment again.", 503);
    throw new PaystackError("Paystack could not complete this request. Check payment status before retrying; contact support if it persists.", 502);
  }
  return payload.data;
}

export interface PaystackLink {
  /** The hosted page. This is what goes in the email. */
  url: string;
  /** Paystack's own id for the attempt. A webhook arrives quoting this. */
  reference: string;
  accessCode: string;
}

/** Opens hosted checkout for a reference already durably claimed by Dakyworld.
 * Paystack rejects a reused reference; callers must never issue a new reference
 * merely because initialization timed out. */
export async function createPaymentLink(input: {
  email: string;
  amount: number;
  currency?: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  recurring?: boolean;
}): Promise<PaystackLink> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new PaystackError("A valid billing email is required.", 400);
  if (!/^[A-Za-z0-9.=\-]{1,100}$/.test(input.reference)) throw new PaystackError("Invalid payment reference.", 400);
  if (input.callbackUrl && new URL(input.callbackUrl).protocol !== "https:" && process.env.NODE_ENV === "production") throw new PaystackError("Payment return URLs must use HTTPS.", 400);
  const data = await call<{ authorization_url: string; access_code: string; reference: string }>("/transaction/initialize", {
    method: "POST",
    body: {
      email: input.email,
      amount: toMinor(input.amount),
      currency: input.currency ?? "GHS",
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata ?? {},
      ...(input.recurring ? { channels: ["card"] } : {}),
    },
  });
  if (data?.reference !== input.reference || !isPaystackUrl(data.authorization_url) || typeof data.access_code !== "string") throw new PaystackError("Paystack returned an invalid checkout. Contact support.");
  return { url: data.authorization_url, reference: data.reference, accessCode: data.access_code };
}

export function isPaystackUrl(value: unknown): value is string {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password && !url.port && ["checkout.paystack.com", "paystack.com"].includes(url.hostname);
  } catch { return false; }
}

export interface PaystackStatus {
  reference: string;
  paid: boolean;
  amount: number;
  currency: string;
  /** "mobile_money", "card", "bank" — what actually settled it, read off Paystack. */
  channel: string | null;
  paidAt: Date | null;
  customerEmail: string | null;
  authorizationCode: string | null;
  domain: string;
}

export async function verifyTransaction(reference: string): Promise<PaystackStatus> {
  const data = await call<{
    reference: string;
    status: string;
    amount: number;
    currency: string;
    channel: string | null;
    paid_at: string | null;
    customer?: { email?: string };
    authorization?: { authorization_code?: string; reusable?: boolean; channel?: string };
    domain: string;
  }>(`/transaction/verify/${encodeURIComponent(reference)}`);

  if (data?.reference !== reference || !Number.isSafeInteger(data.amount) || data.amount < 0 || typeof data.currency !== "string") throw new PaystackError("Paystack returned an invalid verification response.");
  const expectedDomain = (await secretKey()).startsWith("sk_live_") ? "live" : "test";
  if (data.domain !== expectedDomain) throw new PaystackError("Payment mode does not match the configured Paystack account.", 409);
  return {
    domain: data.domain,
    reference: data.reference,
    paid: data.status === "success",
    amount: fromMinor(data.amount),
    currency: data.currency,
    channel: data.channel ?? null,
    paidAt: data.paid_at && Number.isFinite(Date.parse(data.paid_at)) ? new Date(data.paid_at) : null,
    customerEmail: data.customer?.email ?? null,
    authorizationCode: data.authorization?.reusable === true && data.authorization.channel === "card" ? data.authorization.authorization_code ?? null : null,
  };
}

export async function createSubscriptionPlan(input: { name: string; amount: number; currency: string; interval?: "monthly" | "annually" }) {
  const data = await call<{ plan_code: string }>("/plan", { method: "POST", body: { name: input.name, amount: toMinor(input.amount), interval: input.interval ?? "monthly", currency: input.currency } });
  if (!data?.plan_code?.startsWith("PLN_")) throw new PaystackError("Paystack returned an invalid plan.");
  return data.plan_code;
}

export async function createSubscription(input: { email: string; planCode: string; authorizationCode: string; startDate: Date }) {
  const data = await call<{ subscription_code: string; next_payment_date?: string }>("/subscription", { method: "POST", body: { customer: input.email, plan: input.planCode, authorization: input.authorizationCode, start_date: input.startDate.toISOString() } });
  if (!data?.subscription_code?.startsWith("SUB_")) throw new PaystackError("Paystack returned an invalid subscription. Reconcile before retrying.");
  return { code: data.subscription_code, nextPaymentAt: data.next_payment_date ? new Date(data.next_payment_date) : null };
}

/** Confirms a key works, and says which mode it is in, before it is stored. */
export async function verifyPaystackKey(key: string): Promise<{ livemode: boolean; business: string | null }> {
  if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(key)) throw new PaystackError("Enter a valid Paystack secret key.", 400);
  const response = await fetch(`${BASE}/balance`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (response.status === 401) throw new PaystackError("Paystack rejected that key.", 401);
  if (!response.ok) throw new PaystackError(`Paystack answered ${response.status}.`);
  const payload = (await response.json()) as PaystackEnvelope<Array<{ currency: string }>>;
  if (!payload.status) throw new PaystackError(payload.message || "Paystack refused that key.");
  return { livemode: key.startsWith("sk_live_"), business: payload.data?.[0]?.currency ?? null };
}

/**
 * Whether a webhook really came from Paystack.
 *
 * HMAC-SHA512 over the **exact bytes** that were sent, keyed by the same secret
 * key the API uses — there is no separate webhook secret, unlike Stripe. This
 * is why the route is mounted above the JSON body parser: a re-serialised body
 * differs from what was signed by a space, and the signature then fails with a
 * message that says nothing about body parsing.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is checked
 * first — a thrown comparison would be caught somewhere as a server error and
 * read as a bug rather than as a rejected forgery.
 */
export async function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined): Promise<boolean> {
  if (typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const key = await getSetting(SETTING.PAYSTACK_SECRET_KEY);
  if (!key) return false;

  const expected = crypto.createHmac("sha512", key).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}

export interface PaystackSubscription {
  domain: string;
  subscription_code: string;
  status: string;
  email_token: string;
  next_payment_date: string | null;
  customer: { email: string };
  plan: { plan_code: string; amount: number; currency: string; interval: string };
}

export async function fetchSubscription(code: string): Promise<PaystackSubscription> {
  const data = await call<PaystackSubscription>(`/subscription/${encodeURIComponent(code)}`);
  if (data?.subscription_code !== code || !data.customer?.email || !data.plan?.plan_code) throw new PaystackError("Invalid subscription response.");
  if (data.domain !== ((await secretKey()).startsWith("sk_live_") ? "live" : "test")) throw new PaystackError("Subscription payment mode mismatch.", 409);
  return data;
}

export async function cancelSubscription(code: string) {
  const subscription = await fetchSubscription(code);
  if (["cancelled", "completed", "complete", "non-renewing"].includes(subscription.status)) return;
  await call("/subscription/disable", { method: "POST", body: { code, token: subscription.email_token } });
}

export async function subscriptionManagementLink(code: string) {
  const data = await call<{ link: string }>(`/subscription/${encodeURIComponent(code)}/manage/link`);
  if (!isPaystackUrl(data?.link)) throw new PaystackError("Invalid subscription management URL.");
  return data.link;
}

export async function updatePlanAmount(code: string, amount: number) {
  await call(`/plan/${encodeURIComponent(code)}`, { method: "PUT", body: { amount: toMinor(amount), update_existing_subscriptions: true } });
}
