import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SETTING, getSetting, setSetting } from "./settings.js";

/**
 * Events other systems send us, and events we send out.
 *
 * Stripe keeps its own route: its signature scheme is its own, it needs the
 * raw request body, and getting either wrong means accepting forged payment
 * confirmations. Everything else — the contact form on dakyworld.com, a
 * partner system, a Zap — arrives here.
 *
 * **Signing is optional but on by default.** A shared secret is generated the
 * first time the endpoint is looked at, and a sender that doesn't sign is
 * recorded with `verified: false` rather than rejected: a form posting from
 * the website is a real source of leads and losing them to a configuration
 * mismatch is worse than accepting an unsigned one. What `verified` buys is
 * the ability to say "only act on signed events" per source, which the intake
 * does for anything that creates or changes a record.
 */

const SIGNATURE_HEADER = "x-dakyworld-signature";
const TIMESTAMP_HEADER = "x-dakyworld-timestamp";
/** How stale a signed request may be. Stops a captured request being replayed. */
const MAX_SKEW_MS = 5 * 60_000;

export { SIGNATURE_HEADER, TIMESTAMP_HEADER };

/** Reads the shared secret, minting one the first time it is needed. */
export async function webhookSecret(): Promise<string> {
  const existing = await getSetting(SETTING.WEBHOOK_SECRET);
  if (existing) return existing;
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  await setSetting(SETTING.WEBHOOK_SECRET, secret, { secret: true });
  return secret;
}

/** Replaces the secret. Every sender has to be updated afterwards. */
export async function rotateWebhookSecret(): Promise<string> {
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  await setSetting(SETTING.WEBHOOK_SECRET, secret, { secret: true });
  return secret;
}

export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Constant-time compare that survives length differences without throwing. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifyResult {
  verified: boolean;
  /** Why it isn't verified. Null when it is, or when nothing was signed at all. */
  reason: string | null;
  /** True when the sender didn't attempt to sign, as opposed to signing wrongly. */
  unsigned: boolean;
}

export async function verifySignature(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<VerifyResult> {
  const signature = header(headers, SIGNATURE_HEADER);
  const timestamp = header(headers, TIMESTAMP_HEADER);
  if (!signature) return { verified: false, reason: null, unsigned: true };

  if (!timestamp) return { verified: false, reason: `Signed without a ${TIMESTAMP_HEADER} header.`, unsigned: false };
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { verified: false, reason: "Timestamp isn't a number.", unsigned: false };
  if (Math.abs(Date.now() - sentAt) > MAX_SKEW_MS) {
    return { verified: false, reason: "Timestamp is more than five minutes out — a replayed or badly clocked request.", unsigned: false };
  }

  const secret = await webhookSecret();
  const expected = sign(secret, timestamp, rawBody);
  if (!safeEqual(signature, expected)) return { verified: false, reason: "Signature doesn't match the shared secret.", unsigned: false };
  return { verified: true, reason: null, unsigned: false };
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// --- Outbound --------------------------------------------------------------

export class WebhookError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WebhookError";
    this.status = status;
  }
}

/**
 * Sends an event to somebody else's endpoint, signed the same way we expect to
 * be signed. Deliberately one attempt with a short timeout: an integration
 * that needs guaranteed delivery needs a queue, and pretending otherwise with
 * a retry loop inside a request handler is how a slow partner takes this app
 * down with it.
 */
export async function dispatchWebhook(url: string, event: string, payload: unknown): Promise<{ status: number; ok: boolean }> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new WebhookError(400, "Webhooks are only sent over https.");

  const secret = await webhookSecret();
  const timestamp = String(Date.now());
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), data: payload });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: sign(secret, timestamp, body),
        [TIMESTAMP_HEADER]: timestamp,
        "User-Agent": "dakyworld-os",
      },
      body,
      signal: controller.signal,
    });
    return { status: response.status, ok: response.ok };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new WebhookError(504, "The endpoint didn't respond within ten seconds.");
    throw new WebhookError(502, `Could not reach the endpoint: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
