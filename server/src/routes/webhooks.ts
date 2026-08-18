import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "../lib/webhooks.js";
import { handleEvent } from "../services/webhookIntake.js";

/**
 * Events in, from everything that isn't Stripe.
 *
 * **This router is public and must stay public** — a contact form on
 * dakyworld.com cannot log in, and neither can a partner's system. What
 * protects it instead:
 *
 * - **The raw body is read before anything is parsed**, because the signature
 *   covers the exact bytes sent. Mounted before the JSON parser in index.ts
 *   for that reason, exactly like the Stripe route beside it.
 * - **Every event is recorded before it is acted on**, verified or not, so a
 *   payload that breaks a handler is still on disk and a run of failed
 *   signatures is visible rather than silent.
 * - **Only signed events may change anything.** An unsigned post is stored and
 *   left alone. The one exception is the website's own form, which is
 *   deliberately allowed unsigned: a static GitHub Pages site has nowhere to
 *   keep a secret, and losing real enquiries to that is worse than accepting
 *   an unsigned one from a source that creates a lead and nothing else.
 * - **Size is capped**, so this can't be used to fill the database.
 */
export const webhooksRouter = Router();

/** Sources allowed to act while unsigned. See above. */
const UNSIGNED_OK = new Set(["website-form", "contact-form"]);
const MAX_BODY = 128 * 1024;

function parseBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    // Form posts arrive urlencoded, which is what a plain HTML form sends.
    try {
      const params = new URLSearchParams(raw);
      const entries = [...params.entries()];
      return entries.length ? Object.fromEntries(entries) : null;
    } catch {
      return null;
    }
  }
}

/** Headers worth keeping: enough to identify the sender, nothing that could be a credential. */
function safeHeaders(req: Request): Record<string, string> {
  const keep = ["user-agent", "content-type", "origin", "referer", TIMESTAMP_HEADER];
  return Object.fromEntries(
    keep
      .map((name) => [name, req.headers[name]])
      .filter(([, value]) => typeof value === "string")
      .map(([name, value]) => [name as string, value as string]),
  );
}

async function receive(req: Request, res: Response) {
  const source = String(req.params.source ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60);
  if (!source) return res.status(400).json({ error: "Name the source in the path: /api/webhooks/<source>." });

  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  if (raw.length > MAX_BODY) return res.status(413).json({ error: "That payload is too big." });

  const payload = parseBody(raw);
  if (!payload) return res.status(400).json({ error: "Could not read that body as JSON or as form fields." });

  const signature = await verifySignature(req.headers, raw);

  const event = await prisma.webhookEvent.create({
    data: {
      source,
      event: typeof payload.event === "string" ? payload.event.slice(0, 120) : null,
      payload: payload as never,
      headers: safeHeaders(req) as never,
      verified: signature.verified,
    },
  });

  // A wrong signature is different from no signature: one is a sender that
  // hasn't been configured, the other is one that has been configured wrongly
  // — or somebody guessing. Neither acts, and both are recorded.
  if (!signature.verified && !(signature.unsigned && UNSIGNED_OK.has(source))) {
    const note = signature.unsigned
      ? `Unsigned events from “${source}” are recorded but not acted on. Sign it with ${SIGNATURE_HEADER}.`
      : (signature.reason ?? "Signature check failed.");
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { error: note } });
    return res.status(signature.unsigned ? 202 : 401).json({ received: true, acted: false, reason: note });
  }

  try {
    const outcome = await handleEvent(source, payload);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        handledAt: outcome.handled ? new Date() : null,
        result: (outcome.result ?? undefined) as never,
        error: outcome.note,
      },
    });
    return res.status(202).json({ received: true, acted: outcome.handled, ...(outcome.note ? { note: outcome.note } : {}) });
  } catch (err) {
    const message = (err as Error).message;
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { error: message } });
    // The sender is told we took it, because we did — the event is stored and
    // can be replayed. Making them retry into a handler that will fail the
    // same way just multiplies the rows.
    console.error(`[webhooks] handler for ${source} failed:`, message);
    return res.status(202).json({ received: true, acted: false, note: "Recorded, but the handler failed. It has been kept." });
  }
}

webhooksRouter.post("/:source", receive);

/** A sender can check its URL and signature without creating anything. */
webhooksRouter.get("/:source/ping", (req, res) => {
  res.json({
    source: req.params.source,
    ready: true,
    signWith: { signature: SIGNATURE_HEADER, timestamp: TIMESTAMP_HEADER, algorithm: "HMAC-SHA256 over `${timestamp}.${body}`" },
  });
});
