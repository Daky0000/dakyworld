import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

// scrypt rather than bcrypt/argon2 deliberately: it's in Node's standard
// library, so there's no native module to compile on Railway's builder.
// N=16384 needs 128*N*r = 16MB, which sits under Node's 32MB scrypt default.
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

/** Encodes params alongside the hash so they can be raised later without invalidating existing passwords. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");

  let derived: Buffer;
  try {
    derived = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false; // corrupt or hostile params in the stored value
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
