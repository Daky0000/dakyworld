import { SETTING, getSetting } from "./settings.js";
import { defaultCallingCode, toE164 } from "./phone.js";

/**
 * Hubtel — the prompt that arrives on the client's phone, and the text message.
 *
 * The other half of the Ghanaian payment story from `lib/paystack.ts`. A hosted
 * page is the right answer for a client who is comfortable paying on the web;
 * for a great many small businesses here the thing that actually gets completed
 * is a mobile-money prompt on the handset they already have open. Both rails
 * are wired and the billing agent picks per client — and has to say why, or the
 * reconciliation later is guesswork.
 *
 * **Payments and SMS are two different credential pairs.** Using one for the
 * other returns a 401 that says nothing about which, which is a genuinely
 * confusing half-hour. They are stored and checked separately, and each
 * `configured` predicate names its own.
 *
 * **Amounts here are in cedis, not pesewas** — the opposite of Paystack. Hubtel
 * takes a decimal major-unit amount. Getting this the wrong way round silently
 * charges a hundred times too much or too little, so neither library exposes a
 * raw amount: this one takes cedis and sends cedis, and Paystack's converts.
 */

const CHECKOUT_BASE = process.env.HUBTEL_CHECKOUT_BASE_URL ?? "https://payproxyapi.hubtel.com";
const SMS_BASE = process.env.HUBTEL_SMS_BASE_URL ?? "https://smsc.hubtel.com";

export class HubtelError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "HubtelError";
  }
}

export async function hubtelConfigured(): Promise<boolean> {
  const [id, secret, merchant] = await Promise.all([
    getSetting(SETTING.HUBTEL_CLIENT_ID),
    getSetting(SETTING.HUBTEL_CLIENT_SECRET),
    getSetting(SETTING.HUBTEL_MERCHANT_ID),
  ]);
  return Boolean(id && secret && merchant);
}

export async function hubtelSmsConfigured(): Promise<boolean> {
  const [id, secret] = await Promise.all([getSetting(SETTING.HUBTEL_SMS_ID), getSetting(SETTING.HUBTEL_SMS_SECRET)]);
  return Boolean(id && secret);
}

async function basicAuth(idKey: string, secretKey: string, what: string): Promise<string> {
  const [id, secret] = await Promise.all([getSetting(idKey), getSetting(secretKey)]);
  if (!id || !secret) throw new HubtelError(`Hubtel ${what} isn't connected. Add the credentials under Settings → Payments.`, 503);
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

/**
 * Normalises a Ghanaian mobile number to what Hubtel expects.
 *
 * People write their number six ways — `024 123 4567`, `+233 24 123 4567`,
 * `233241234567`, `24 123 4567`. Hubtel wants `233XXXXXXXXX`. This is worth
 * doing centrally because the failure is not an error: a malformed number is
 * accepted and the prompt goes to nobody, or worse, to somebody else.
 */
export function normaliseGhanaNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) return digits;
  // A local number keeps its leading zero in writing and loses it in the
  // international form: 0241234567 -> 233241234567.
  if (digits.startsWith("0") && digits.length === 10) return `233${digits.slice(1)}`;
  // Written without either prefix, which is common in a spreadsheet where the
  // leading zero was eaten by the cell format.
  if (digits.length === 9) return `233${digits}`;
  return null;
}

async function callJson<T>(url: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: auth, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    throw new HubtelError(`Could not reach Hubtel: ${(err as Error).message}`);
  }

  const text = await response.text();
  if (response.status === 401) throw new HubtelError("Hubtel rejected those credentials. Note that SMS and payments use different pairs.", 401);
  if (!response.ok) throw new HubtelError(`Hubtel answered ${response.status}: ${text.slice(0, 300)}`);

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HubtelError(`Hubtel answered ${response.status} with something that wasn't JSON.`);
  }
}

export interface HubtelCheckout {
  /** The hosted checkout page, where one was returned. */
  url: string | null;
  /** Hubtel's own id for the attempt. What a callback quotes. */
  reference: string;
  checkoutId: string | null;
}

/**
 * Opens a checkout and returns where to pay it.
 *
 * `clientReference` is ours and is what ties a callback back to an invoice.
 * Hubtel's callback is not signed, so it is treated as a *notification* rather
 * than as evidence: `checkStatus` is called before anything is marked paid. A
 * callback saying "paid" that nobody verified is a free invoice to whoever
 * guesses the URL.
 */
export async function createCheckout(input: {
  amount: number;
  description: string;
  clientReference: string;
  callbackUrl: string;
  returnUrl?: string;
  payeeName?: string;
  payeeEmail?: string;
  payeePhone?: string;
}): Promise<HubtelCheckout> {
  const auth = await basicAuth(SETTING.HUBTEL_CLIENT_ID, SETTING.HUBTEL_CLIENT_SECRET, "payments");
  const merchant = await getSetting(SETTING.HUBTEL_MERCHANT_ID);
  if (!merchant) throw new HubtelError("Hubtel has no merchant account number set. Add it under Settings → Payments.", 503);

  const data = await callJson<{
    responseCode: string;
    status: string;
    data?: { checkoutUrl?: string; checkoutId?: string; clientReference?: string };
  }>(`${CHECKOUT_BASE}/items/initiate`, auth, {
    method: "POST",
    body: {
      totalAmount: Number(input.amount.toFixed(2)),
      description: input.description.slice(0, 100),
      callbackUrl: input.callbackUrl,
      returnUrl: input.returnUrl ?? input.callbackUrl,
      merchantAccountNumber: merchant,
      cancellationUrl: input.returnUrl ?? input.callbackUrl,
      clientReference: input.clientReference,
      payeeName: input.payeeName,
      payeeEmail: input.payeeEmail,
      payeeMobileNumber: input.payeePhone ? normaliseGhanaNumber(input.payeePhone) : undefined,
    },
  });

  if (data.responseCode !== "0000") {
    throw new HubtelError(`Hubtel would not open that checkout (${data.responseCode}${data.status ? `: ${data.status}` : ""}).`);
  }

  return {
    url: data.data?.checkoutUrl ?? null,
    reference: data.data?.clientReference ?? input.clientReference,
    checkoutId: data.data?.checkoutId ?? null,
  };
}

export interface HubtelStatus {
  reference: string;
  paid: boolean;
  amount: number | null;
  /** "mobilemoney", "card" — how it actually settled. */
  channel: string | null;
  paidAt: Date | null;
}

/**
 * What Hubtel says about a payment, asked directly.
 *
 * Always called before an invoice is marked paid, including when a callback has
 * just said it was — see the note on `createCheckout`.
 */
export async function checkStatus(clientReference: string): Promise<HubtelStatus> {
  const auth = await basicAuth(SETTING.HUBTEL_CLIENT_ID, SETTING.HUBTEL_CLIENT_SECRET, "payments");
  const merchant = await getSetting(SETTING.HUBTEL_MERCHANT_ID);

  const data = await callJson<{
    responseCode: string;
    data?: Array<{ status?: string; amount?: number; paymentMethod?: string; date?: string }> | { status?: string; amount?: number; paymentMethod?: string; date?: string };
  }>(`${CHECKOUT_BASE}/transactions/${encodeURIComponent(merchant ?? "")}/status?clientReference=${encodeURIComponent(clientReference)}`, auth);

  // Hubtel returns either an object or a one-element array depending on the
  // endpoint's mood; both shapes are in its own documentation.
  const row = Array.isArray(data.data) ? data.data[0] : data.data;
  const status = (row?.status ?? "").toLowerCase();

  return {
    reference: clientReference,
    paid: status === "paid" || status === "success",
    amount: typeof row?.amount === "number" ? row.amount : null,
    channel: row?.paymentMethod ?? null,
    paidAt: row?.date ? new Date(row.date) : null,
  };
}

/**
 * Sends one text message.
 *
 * The sender id matters more than it looks: an alphanumeric one ("Dakyworld")
 * has to be registered with Hubtel before it will deliver, and an unregistered
 * one fails per-message rather than at setup. When none is configured the
 * merchant account number is used, which always works and looks like a number.
 */
export async function sendSms(to: string, message: string): Promise<{ messageId: string | null; to: string }> {
  const auth = await basicAuth(SETTING.HUBTEL_SMS_ID, SETTING.HUBTEL_SMS_SECRET, "SMS");
  // `toE164` first, `normaliseGhanaNumber` as the fallback. The Ghanaian
  // normaliser below is still right for the *payments* half of this file — a
  // mobile-money prompt can only go to a Ghanaian handset — but it returns null
  // for every international number, and a Ghanaian business owner living in
  // London is exactly the lead this channel exists to reach. See lib/phone.ts.
  const recipient = toE164(to, await defaultCallingCode())?.e164 ?? normaliseGhanaNumber(to);
  if (!recipient) throw new HubtelError(`"${to}" is not a mobile number this can send to.`, 400);

  const from = (await getSetting(SETTING.HUBTEL_SMS_SENDER)) || (await getSetting(SETTING.HUBTEL_MERCHANT_ID)) || "Dakyworld";
  const data = await callJson<{ status?: number; messageId?: string; statusDescription?: string }>(`${SMS_BASE}/v1/messages/send`, auth, {
    method: "POST",
    body: { From: from.slice(0, 11), To: recipient, Content: message.slice(0, 1000) },
  });

  // Hubtel's SMS API answers 200 with a non-zero status for a refusal, so a
  // successful HTTP call is not a sent message.
  if (data.status !== undefined && data.status !== 0) {
    throw new HubtelError(`Hubtel did not send that: ${data.statusDescription ?? `status ${data.status}`}.`);
  }
  return { messageId: data.messageId ?? null, to: recipient };
}

/** Confirms a payments pair works before it is stored. */
export async function verifyHubtelKeys(clientId: string, clientSecret: string, merchant: string): Promise<{ merchant: string }> {
  const auth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const response = await fetch(`${CHECKOUT_BASE}/transactions/${encodeURIComponent(merchant)}/status?clientReference=dakyworld-connection-check`, {
    headers: { authorization: auth },
  });
  if (response.status === 401) throw new HubtelError("Hubtel rejected those payment credentials.", 401);
  // A 404 here means the credentials were accepted and the reference simply
  // does not exist, which is exactly what a connection check wants to see.
  if (!response.ok && response.status !== 404) throw new HubtelError(`Hubtel answered ${response.status}.`);
  return { merchant };
}
