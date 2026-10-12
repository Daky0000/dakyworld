import crypto from "node:crypto";

/**
 * Symmetric encryption for the API tokens the Owner pastes into the app
 * (currently the Apify token). They live in the database rather than in
 * Railway's variables, because the whole point is that the Owner can add a new
 * lead source without a redeploy — but a token sitting in plaintext in a table
 * would then be one bad database dump away from being someone else's.
 *
 * The key comes from APP_SECRET. If that isn't set the key is derived from
 * DATABASE_URL, which is stable per deployment and already secret; that keeps
 * the feature working with zero configuration, at the cost of every stored
 * secret becoming unreadable if the database is ever moved to a new URL. The
 * failure mode is benign — decryption returns null, the UI shows the token as
 * missing, and the Owner pastes it again.
 */

const ALGORITHM = "aes-256-gcm";
const PREFIX = "v1";

let warned = false;

function encryptionKey(): Buffer {
  const material = process.env.APP_SECRET || process.env.DATABASE_URL;
  if (!material) {
    throw new Error("Cannot encrypt settings: neither APP_SECRET nor DATABASE_URL is set");
  }
  if (!process.env.APP_SECRET && !warned) {
    warned = true;
    console.warn(
      "  ⚠ APP_SECRET is not set — stored integration tokens are keyed to DATABASE_URL " +
        "and will need re-entering if the database URL changes.",
    );
  }
  return crypto.createHash("sha256").update(`dakyworld-os:settings:${material}`).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Returns null rather than throwing — an unreadable token must not take a page down. */
export function decryptSecret(payload: string): string | null {
  try {
    const [version, iv, tag, ciphertext] = payload.split(".");
    if (version !== PREFIX || !iv || !tag || !ciphertext) return null;
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * A key for signing something the server hands out and expects back unchanged,
 * such as a change plan that travels through the browser before it is applied.
 *
 * Same material as the encryption key and derived the same way, but under its
 * own purpose string, so a signing key never equals the key that encrypts the
 * stored tokens and no two kinds of signature can be swapped for one another.
 * Rotating APP_SECRET (or moving the database, when it is unset) only
 * invalidates signatures still in flight: the person asks again.
 */
export function signingKey(purpose: string): Buffer {
  const material = process.env.APP_SECRET || process.env.DATABASE_URL;
  if (!material) {
    throw new Error("Cannot sign: neither APP_SECRET nor DATABASE_URL is set");
  }
  return crypto.createHash("sha256").update(`dakyworld-os:signing:${purpose}:${material}`).digest();
}

/** What the UI is allowed to see: enough to recognise the token, not enough to use it. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 5)}${"•".repeat(8)}${value.slice(-4)}`;
}
