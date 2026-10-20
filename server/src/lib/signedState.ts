import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * A value that leaves for another site's sign-in screen and comes back, proved
 * to be ours and to belong to the person who started it.
 *
 * The connect flows (Netlify, Vercel, the DakyX Pages app) send someone away
 * with a website id and expect them back. Without a signature, a callback URL
 * opened by somebody else, or forwarded to a customer, would attach whatever
 * account it carried to whatever site it named. Keyed from APP_SECRET, falling
 * back to DATABASE_URL like lib/secrets.ts, and good for thirty minutes.
 */

const TTL_MS = 30 * 60_000;

function key(): Buffer {
  const material = process.env.APP_SECRET || process.env.DATABASE_URL || "";
  if (!material) throw new Error("Cannot sign a connect state: neither APP_SECRET nor DATABASE_URL is set.");
  return createHash("sha256").update(`dakyworld-os:connect-state:${material}`).digest();
}

export function signState(payload: Record<string, string>, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, at: now.toString(36) })).toString("base64url");
  const mac = createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** The payload, when the state is ours, unexpired and for this person; null otherwise. */
export function readState(state: string | undefined, userId: string, now = Date.now()): Record<string, string> | null {
  const [body, mac] = (state ?? "").split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key()).update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let payload: Record<string, string>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const at = parseInt(payload.at ?? "", 36);
  if (!Number.isFinite(at) || now - at > TTL_MS || at > now + 60_000) return null;
  if (payload.user !== userId) return null;
  return payload;
}
