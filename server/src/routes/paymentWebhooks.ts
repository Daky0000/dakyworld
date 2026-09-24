import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { verifyPaystackSignature } from "../lib/paystack.js";
import { enqueuePaystackEvent, processPaystackEvents } from "../services/paystackEvents.js";
import { settleFromProvider } from "../services/payments.js";

/** Provider callbacks use raw bodies. Paystack signatures are checked before
 * parsing, and accepted Paystack events enter a durable queue before HTTP 200. */

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

/** HMAC-SHA512 authentication and durable, redacted Paystack ingestion. */
export async function paystackWebhook(req: Request, res: Response) {
  try {
    if (!Buffer.isBuffer(req.body)) return res.status(400).send("raw body required");
    const signature = req.headers["x-paystack-signature"];
    if (typeof signature !== "string" || !await verifyPaystackSignature(req.body, signature)) return res.status(401).send("bad signature");
    let payload;
    try { payload = JSON.parse(req.body.toString("utf8")); }
    catch { return res.status(400).send("not json"); }
    if (!payload || typeof payload.event !== "string" || payload.event.length > 100 || !payload.data || typeof payload.data !== "object") return res.status(400).send("invalid event");
    await enqueuePaystackEvent(req.body, payload.event, payload.data);
    res.status(200).json({ received: true });
    void processPaystackEvents().catch(() => console.error("[paystack] Queue worker failed; scheduler will retry"));
  } catch {
    // Never acknowledge an event which has not reached durable storage.
    return res.status(503).json({ error: "Please retry delivery" });
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
    const settled = await settleFromProvider(reference, "hubtel");
    if (settled?.changed) console.log(`[webhooks] hubtel settled ${settled.invoice.invoiceNumber}`);
  } catch (err) {
    console.error("[webhooks] hubtel settlement failed:", (err as Error).message);
  }
}
