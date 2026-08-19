import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226), and the recovery
 * codes that go with them.
 *
 * Written against `node:crypto` rather than pulled from a package: the whole
 * algorithm is an HMAC, a counter and a modulo, and this app already refuses
 * native dependencies for the same reason `password.ts` does — Railway's
 * builder has no toolchain. Sixty lines here is cheaper than a supply chain.
 *
 * TOTP rather than an emailed code, deliberately. An emailed OTP is only as
 * strong as the mailbox, and the mailbox this company would use is the one the
 * app itself sends from — so a compromise of the mail token would hand over the
 * second factor as well as the first. An authenticator app shares nothing with
 * this system.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** One step either side, so a phone clock a few seconds out still works. */
const DRIFT_STEPS = 1;

// --- base32, because that is what authenticator apps read ---------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// --- the algorithm ------------------------------------------------------------

/** 20 bytes, which is the SHA-1 block size every authenticator app assumes. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function codeForStep(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Verifies a code and returns the time step it matched, or null.
 *
 * The step is returned rather than a bare boolean because the caller has to
 * store it: TOTP is only single-use if somebody remembers which code was
 * already spent. Without that, a code shoulder-surfed or lifted from a phishing
 * page stays valid for the rest of its thirty seconds.
 */
export function verifyTotp(secretBase32: string, code: string, atMs = Date.now()): number | null {
  const cleaned = code.replace(/\D/g, "");
  if (cleaned.length !== DIGITS) return null;

  const secret = base32Decode(secretBase32);
  if (secret.length === 0) return null;

  const current = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    const step = current + drift;
    const expected = Buffer.from(codeForStep(secret, step));
    const given = Buffer.from(cleaned);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return step;
  }
  return null;
}

/** The URI an authenticator app scans. The label is what the user sees in their app's list. */
export function totpUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// --- recovery codes -----------------------------------------------------------

const RECOVERY_CODE_COUNT = 10;

/**
 * The way back in when the phone is gone. Shown once, stored only as hashes —
 * a plain SHA-256 rather than scrypt because these are 50 bits of real
 * randomness, not a chosen word, so there is nothing for a dictionary to bite
 * on and the cost of a slow hash buys nothing.
 */
export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    // Crockford-ish: no letters that get misread off a printed sheet.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let c = 0; c < 10; c += 1) code += alphabet[randomInt(alphabet.length)];
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");
}

function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Consumes a recovery code, returning the remaining hashes, or null if it
 * didn't match. A used code is gone — that is the whole point of it being a
 * recovery code rather than a second password.
 */
export function consumeRecoveryCode(code: string, hashes: string[]): string[] | null {
  const candidate = hashRecoveryCode(code);
  const remaining = hashes.filter((stored) => stored !== candidate);
  return remaining.length === hashes.length ? null : remaining;
}
