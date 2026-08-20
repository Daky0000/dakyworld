import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { verifyPaystackSignature } from "../lib/paystack.js";
import { settleFromProvider } from "../services/payments.js";

/**
 * "Somebody paid."
 *
 * Both handlers are mounted **above the global JSON parser** and given raw
 * bytes, for the reason the Stripe and Slack routes are: a signature covers the
 * exact bytes that were sent, and a body that has been parsed and re-serialised
 * differs from those by a space. The failure mode of getting this wrong is a
 * signature check that fails every time with a message saying nothing about
 * body parsing, which is a genuinely expensive afternoon.
 *
 * **Neither handler believes what it is told.** Both do the same thing: work
 * out which reference is being talked about, then go and ask the provider
 * whether that reference is actually paid (`settleFromProvider`). Paystack
 * signs its webhooks and Hubtel does not sign anything at all, so trusting the
 * payload would make a Hubtel callback a free invoice to anybody who guesses
 * the URL. Verifying costs one API call on a path that fires a handful of times
 * a day.
 *
 * **Both answer 200 quickly and are idempotent.** A provider retries anything
 * it does not get a 200 from, and a retried "paid" must not add a second
 * payment to a client's lifetime value.
 */

/** Every payload lands here before it is acted on, verified or not. */
async function record(source: string, event: string, payload: unknown, headers: Request["headers"], verified: boolean) {
  try {
    await prisma.webhookEvent.create({
      data: {
        source,
        event,
        payload: (payload ?? {}) as never,
        headers: JSON.parse(JSON.stringify(headers)) as never,
        verified,
      },
    });
  } catch (err) {
    console.error(`[webhooks] could not record a ${source} event:`, (err as Error).message);
  }
}

/**
 * Paystack.
 *
 * Signed with HMAC-SHA512 over the raw body, keyed by the *secret key* itself —
 * there is no separate webhook secret as there is with Stripe. An unverified
 * payload is recorded and refused: it is either a forgery or a key mismatch,
 * and both are worth being able to see afterwards.
 */
export async function paystackWebhook(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
  const signature = req.headers["x-paystack-signature"] as string | undefined;
  const verified = await verifyPaystackSignature(raw, signature);

  let payload: { event?: string; data?: { reference?: string } } = {};
  try {
    payload = JSON.parse(raw.toString("utf8")) as typeof payload;
  } catch {
    await record("paystack", "unparseable", { body: raw.toString("utf8").slice(0, 500) }, req.headers, verified);
    return res.status(400).send("not json");
  }

  await record("paystack", payload.event ?? "unknown", payload, req.headers, verified);
  if (!verified) return res.status(401).send("bad signature");

  // Answered before the work. Paystack retries after a few seconds, and a
  // verification call against their API is not something to hold it open for.
  res.status(200).json({ received: true });

  const reference = payload.data?.reference;
  if (payload.event !== "charge.success" || !reference) return;

  try {
    const settled = await settleFromProvider(reference);
    if (settled?.changed) console.log(`[webhooks] paystack settled ${settled.invoice.invoiceNumber}`);
  } catch (err) {
    console.error("[webhooks] paystack settlement failed:", (err as Error).message);
  }
}

/**
 * Hubtel.
 *
 * Carries no signature of any kind, so the payload is a *notification* and
 * nothing more — the reference is taken out of it and everything else is
 * ignored in favour of asking Hubtel directly. Recorded as `verified: false`
 * always, honestly, rather than claiming a check that did not happen.
 */
export async function hubtelWebhook(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));

  let payload: { Data?: { ClientReference?: string }; data?: { clientReference?: string } } = {};
  try {
    payload = JSON.parse(raw.toString("utf8")) as typeof payload;
  } catch {
    await record("hubtel", "unparseable", { body: raw.toString("utf8").slice(0, 500) }, req.headers, false);
    return res.status(400).send("not json");
  }

  await record("hubtel", "callback", payload, req.headers, false);
  res.status(200).json({ received: true });

  // Hubtel capitalises its JSON keys inconsistently between products, so both
  // spellings are read rather than guessed at.
  const reference = payload.Data?.ClientReference ?? payload.data?.clientReference;
  if (!reference) return;

  try {
    const settled = await settleFromProvider(reference);
    if (settled?.changed) console.log(`[webhooks] hubtel settled ${settled.invoice.invoiceNumber}`);
  } catch (err) {
    console.error("[webhooks] hubtel settlement failed:", (err as Error).message);
  }
}
