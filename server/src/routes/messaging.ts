import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { SETTING, getSetting } from "../lib/settings.js";
import { markRead, parseWebhook, verifyTokenMatches, verifyWebhookSignature } from "../lib/whatsapp.js";
import { applyDeliveryStatus, recordInbound } from "../services/messageSender.js";
import { sendSlack } from "../lib/slack.js";

/**
 * Replies coming back, and delivery receipts.
 *
 * **This router is public and must stay public** — Meta cannot log in, and
 * neither can Hubtel. It is mounted above the JSON parser in index.ts for the
 * same reason the Stripe, Paystack and Slack routes are: Meta signs the exact
 * bytes it sent, and a body that has been parsed and re-stringified is not
 * those bytes.
 *
 * What guards it:
 *
 * - **WhatsApp deliveries carry an HMAC** over the raw body, keyed on the Meta
 *   app secret. With no secret configured, nothing inbound is acted on.
 * - **Hubtel signs nothing at all**, so the SMS callbacks require a secret in
 *   the query string that the Owner puts in the callback URL at Hubtel's end.
 *   With none configured they are refused.
 * - **Every delivery is recorded before it is acted on**, verified or not, so
 *   a payload that breaks a handler is still on disk and a run of failed
 *   signatures is visible rather than silent.
 *
 * Why the verification matters more here than on the generic webhook route: an
 * unverified inbound message would **open a 24-hour free-form window** to a
 * number of the caller's choosing, and an unverified "STOP" would opt a live
 * prospect out of everything. Both are things somebody who found the URL could
 * otherwise do.
 */
export const messagingRouter = Router();

const MAX_BODY = 128 * 1024;

function rawBody(req: Request): string {
  return Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
}

async function record(source: string, event: string | null, payload: unknown, verified: boolean) {
  return prisma.webhookEvent.create({
    data: { source, event, payload: (payload ?? {}) as never, verified },
  });
}

async function settle(id: string, result: unknown, error?: string) {
  await prisma.webhookEvent.update({
    where: { id },
    data: { handledAt: new Date(), result: (result ?? null) as never, error: error ?? null },
  });
}

// --- WhatsApp --------------------------------------------------------------

/**
 * Meta's one-time handshake, performed when the callback URL is saved in the
 * dashboard. It sends a challenge and a token we chose; echoing the challenge
 * back **as plain text** is what registers the URL. Answering it as JSON fails
 * with a message that says nothing about why.
 */
messagingRouter.get("/whatsapp", async (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode !== "subscribe") return res.status(400).send("Unexpected hub.mode.");
  if (!(await verifyTokenMatches(typeof token === "string" ? token : undefined))) {
    return res.status(403).send("Verify token does not match.");
  }
  res.type("text/plain").send(String(challenge ?? ""));
});

/**
 * Everything Meta sends afterwards: their replies, and receipts for ours.
 *
 * **Answered 200 before the work is done.** Meta retries anything it does not
 * hear from quickly, with increasing back-off, and a retry of an inbound
 * message would file the reply twice — so the acknowledgement goes first and
 * the handling happens after it, exactly as the Slack router does with its
 * three-second window.
 */
messagingRouter.post("/whatsapp", async (req: Request, res: Response) => {
  const raw = rawBody(req);
  if (raw.length > MAX_BODY) return res.status(413).json({ error: "That payload is too big." });

  const verified = await verifyWebhookSignature(req.headers["x-hub-signature-256"] as string | undefined, Buffer.isBuffer(req.body) ? req.body : raw);

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    await record("whatsapp", null, { unparseable: raw.slice(0, 2000) }, verified);
    return res.status(400).json({ error: "Could not read that body as JSON." });
  }

  const event = await record("whatsapp", "message", payload, verified);
  res.json({ received: true });

  if (!verified) {
    await settle(event.id, null, "Unsigned or wrongly signed — stored and not acted on. Check the Meta app secret under Settings → Messaging.");
    console.warn("[messaging] refused an unverified WhatsApp delivery");
    return;
  }

  // Past the acknowledgement, so nothing here may throw into the response.
  try {
    const { messages, statuses } = parseWebhook(payload);
    const handled: string[] = [];

    for (const inbound of messages) {
      const result = await recordInbound({
        channel: "WHATSAPP",
        from: inbound.from,
        text: inbound.text,
        providerMessageId: inbound.id,
        name: inbound.profileName,
        at: inbound.timestamp,
      });
      handled.push(result.message.id);

      // The blue ticks. Failing here must not lose the reply, which is already
      // filed — a business that looks absent is a smaller problem than a
      // dropped enquiry.
      void markRead(inbound.id).catch((err) => console.warn("[messaging] could not mark read:", (err as Error).message));

      await announce(result.optedOut, inbound.profileName ?? inbound.from, inbound.text);
    }

    for (const status of statuses) {
      await applyDeliveryStatus({
        providerMessageId: status.messageId,
        status: status.status,
        at: status.timestamp,
        error: status.error,
      });
    }

    await settle(event.id, { messages: handled.length, statuses: statuses.length });
  } catch (err) {
    console.error("[messaging] WhatsApp intake failed:", err);
    await settle(event.id, null, (err as Error).message);
  }
});

/**
 * A reply worth interrupting somebody for.
 *
 * A prospect answering a cold message is the most time-sensitive event this
 * app produces — the 24-hour window to reply in their own words is literally
 * a day long — and nobody is watching the Messages screen. Slack failing must
 * never lose the message, hence the catch.
 */
async function announce(optedOut: boolean, who: string, text: string | null) {
  const line = optedOut
    ? `*${who}* asked not to be contacted again on WhatsApp. They have been opted out everywhere.`
    : `*${who}* replied on WhatsApp: ${text ? `“${text.slice(0, 300)}”` : "(a photo or voice note)"}\nThe 24-hour window to answer in your own words is open now.`;
  await sendSlack({ title: optedOut ? "Opted out" : "A prospect replied", text: line }).catch((err) =>
    console.warn("[messaging] Slack notice failed:", (err as Error).message),
  );
}

// --- SMS, through Hubtel ---------------------------------------------------

/**
 * Hubtel signs nothing, so the URL carries the secret.
 *
 * Compared in constant time out of habit rather than necessity — it costs
 * nothing and the alternative is a comparison whose timing leaks the prefix.
 */
async function smsTokenOk(req: Request): Promise<boolean> {
  const expected = await getSetting(SETTING.SMS_INBOUND_TOKEN);
  const provided = typeof req.query.token === "string" ? req.query.token : "";
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Hubtel writes its callbacks in whatever case it feels like — `From` in the
 * documentation, `from` in practice, and query parameters rather than a body
 * on the older gateway. Read case-insensitively rather than trusting one.
 */
function field(payload: Record<string, unknown>, ...names: string[]): string | null {
  const lower = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const value = lower[name.toLowerCase()];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/** A text somebody sent back. Also how a STOP arrives on this channel. */
messagingRouter.post("/sms/inbound", async (req: Request, res: Response) => {
  const raw = rawBody(req);
  if (raw.length > MAX_BODY) return res.status(413).json({ error: "That payload is too big." });

  const ok = await smsTokenOk(req);
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    payload = Object.fromEntries(new URLSearchParams(raw).entries());
  }
  // The older gateway puts everything in the query string.
  payload = { ...(req.query as Record<string, unknown>), ...payload };
  delete payload.token;

  const event = await record("hubtel-sms", "inbound", payload, ok);
  if (!ok) {
    await settle(event.id, null, "No matching callback token — stored and not acted on. Set one under Settings → Messaging and put it in the Hubtel callback URL.");
    return res.status(403).json({ error: "Bad callback token." });
  }

  const from = field(payload, "From", "Msisdn", "Sender", "source");
  const text = field(payload, "Content", "Message", "Body", "text");
  if (!from) {
    await settle(event.id, null, "No sender number in the payload.");
    return res.status(400).json({ error: "No sender number." });
  }

  res.json({ received: true });

  try {
    const result = await recordInbound({
      channel: "SMS",
      from,
      text,
      providerMessageId: field(payload, "MessageId", "Id"),
    });
    await settle(event.id, { messageId: result.message.id, optedOut: result.optedOut });
    await sendSlack({
      title: result.optedOut ? "Opted out" : "A prospect replied",
      text: result.optedOut
        ? `*${from}* replied STOP by text. They have been opted out everywhere.`
        : `*${from}* replied by text: ${text ? `“${text.slice(0, 300)}”` : "(no text)"}`,
    }).catch(() => undefined);
  } catch (err) {
    console.error("[messaging] SMS intake failed:", err);
    await settle(event.id, null, (err as Error).message);
  }
});

/** Hubtel's delivery report — whether the handset actually got it. */
messagingRouter.post("/sms/status", async (req: Request, res: Response) => {
  const raw = rawBody(req);
  const ok = await smsTokenOk(req);

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    payload = Object.fromEntries(new URLSearchParams(raw).entries());
  }
  payload = { ...(req.query as Record<string, unknown>), ...payload };
  delete payload.token;

  const event = await record("hubtel-sms", "status", payload, ok);
  if (!ok) {
    await settle(event.id, null, "No matching callback token — stored and not acted on.");
    return res.status(403).json({ error: "Bad callback token." });
  }

  res.json({ received: true });

  try {
    const id = field(payload, "MessageId", "Id");
    // Hubtel reports a numeric status: 0 delivered, anything else a failure of
    // some kind. The word form turns up too, depending on the gateway.
    const rawStatus = field(payload, "Status", "StatusCode", "DeliveryStatus") ?? "";
    const status = rawStatus === "0" || /deliver/i.test(rawStatus) ? "delivered" : /submit|sent|pending/i.test(rawStatus) ? "sent" : "failed";

    if (!id) {
      await settle(event.id, null, "No message id in the delivery report.");
      return;
    }
    const updated = await applyDeliveryStatus({
      providerMessageId: id,
      status,
      error: status === "failed" ? `Hubtel reported status ${rawStatus || "unknown"}.` : null,
    });
    await settle(event.id, { matched: Boolean(updated), status });
  } catch (err) {
    console.error("[messaging] SMS status failed:", err);
    await settle(event.id, null, (err as Error).message);
  }
});
