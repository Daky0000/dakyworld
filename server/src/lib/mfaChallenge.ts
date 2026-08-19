import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The ticket handed out between "the password was right" and "the code was
 * right".
 *
 * Signed rather than stored, so the half-finished login needs no table and no
 * cleanup job. It carries the user id and an expiry and nothing else, and it is
 * useless on its own — presenting one without a valid TOTP code gets you
 * nowhere, which is what lets it be a plain response field rather than a
 * cookie.
 *
 * Five minutes, because that is roughly how long it takes to find a phone.
 */

const TTL_MS = 5 * 60_000;
const PREFIX = "mfa1";

function key(): Buffer {
  const material = process.env.APP_SECRET || process.env.DATABASE_URL;
  if (!material) throw new Error("Cannot sign an MFA challenge: neither APP_SECRET nor DATABASE_URL is set");
  return createHmac("sha256", "dakyworld-os:mfa").update(material).digest();
}

function sign(body: string): string {
  return createHmac("sha256", key()).update(body).digest("base64url");
}

export function issueChallenge(userId: string): string {
  const body = `${PREFIX}.${userId}.${Date.now() + TTL_MS}`;
  return `${body}.${sign(body)}`;
}

/** The user id the challenge was issued for, or null if it is forged, altered or stale. */
export function readChallenge(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;

  const [prefix, userId, expiresAt, signature] = parts;
  if (prefix !== PREFIX) return null;

  const expected = Buffer.from(sign(`${prefix}.${userId}.${expiresAt}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  if (!Number(expiresAt) || Number(expiresAt) < Date.now()) return null;
  return userId;
}
