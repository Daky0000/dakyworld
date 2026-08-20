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

const BASE = process.env.PAYSTACK_BASE_URL ?? "https://api.paystack.co";

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
  return Math.round(amount * 100);
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
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    throw new PaystackError(`Could not reach Paystack: ${(err as Error).message}`);
  }

  const text = await response.text();
  let payload: PaystackEnvelope<T> | null = null;
  try {
    payload = JSON.parse(text) as PaystackEnvelope<T>;
  } catch {
    // Paystack answers JSON for everything it handles, so a non-JSON body is a
    // gateway or a WAF between here and them. Say that rather than "invalid
    // JSON", which sends whoever reads it looking in the wrong place.
    throw new PaystackError(`Paystack answered ${response.status} with something that wasn't JSON.`);
  }

  if (!response.ok || !payload.status) {
    throw new PaystackError(payload.message || `Paystack refused that (${response.status}).`, response.status === 401 ? 401 : 502);
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

/**
 * Opens a transaction and returns the link to pay it.
 *
 * `reference` is ours to choose and is what ties a webhook back to an invoice,
 * so it carries the invoice number. Paystack requires it to be unique across
 * the account for ever, which is why the timestamp is on the end: a second
 * attempt at the same invoice — after the first link expired, or was abandoned
 * — is a second transaction, and re-using the reference is rejected rather
 * than replacing anything.
 */
export async function createPaymentLink(input: {
  email: string;
  amount: number;
  currency?: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}): Promise<PaystackLink> {
  const data = await call<{ authorization_url: string; access_code: string; reference: string }>("/transaction/initialize", {
    method: "POST",
    body: {
      email: input.email,
      amount: toMinor(input.amount),
      currency: input.currency ?? "GHS",
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata ?? {},
    },
  });
  return { url: data.authorization_url, reference: data.reference, accessCode: data.access_code };
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
  }>(`/transaction/verify/${encodeURIComponent(reference)}`);

  return {
    reference: data.reference,
    paid: data.status === "success",
    amount: fromMinor(data.amount),
    currency: data.currency,
    channel: data.channel ?? null,
    paidAt: data.paid_at ? new Date(data.paid_at) : null,
    customerEmail: data.customer?.email ?? null,
  };
}

/** Confirms a key works, and says which mode it is in, before it is stored. */
export async function verifyPaystackKey(key: string): Promise<{ livemode: boolean; business: string | null }> {
  const response = await fetch(`${BASE}/balance`, { headers: { authorization: `Bearer ${key}` } });
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
  if (!signature) return false;
  const key = await getSetting(SETTING.PAYSTACK_SECRET_KEY);
  if (!key) return false;

  const expected = crypto.createHmac("sha512", key).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
