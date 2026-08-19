import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "./prisma.js";

/**
 * `__Host-` is not decoration. The prefix is a promise the browser enforces:
 * it will only accept the cookie if it is Secure, has `Path=/` and carries no
 * `Domain` — which means no other host under dakyworld.com can set or overwrite
 * it. Without that, anything that ever gets to run on a sibling subdomain can
 * plant a session cookie of its own choosing.
 *
 * Only in production, because the prefix requires Secure and Secure cookies are
 * dropped over plain http://localhost.
 */
const SECURE_COOKIE = "__Host-dw_session";
const PLAIN_COOKIE = "dw_session";

const isProduction = () => process.env.NODE_ENV === "production";
const cookieName = () => (isProduction() ? SECURE_COOKIE : PLAIN_COOKIE);

/** Kept exported for anything that reasons about the cookie by name. */
export const SESSION_COOKIE = PLAIN_COOKIE;

const SESSION_TTL_DAYS = 30;
/** Re-issue the expiry when a session is this far along, so active users don't get logged out mid-week. */
const REFRESH_AFTER_DAYS = 1;
/**
 * A ceiling the sliding refresh cannot push past. Without it a session used
 * once a week never expires at all, and a token stolen today is still good next
 * year — the sliding window renews it every time the thief uses it.
 */
const ABSOLUTE_MAX_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The database stores only this digest — never the token that's in the cookie. */
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expiryFromNow(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * DAY_MS);
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { tokenHash: digest(token), userId, expiresAt: expiryFromNow() } });
  return token;
}

/**
 * Resolves a raw cookie token to its session, sliding the expiry forward for
 * sessions already a day old but never past the absolute ceiling. Dead rows are
 * deleted rather than ignored so the table doesn't grow without bound.
 */
export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: true },
  });
  if (!session) return null;

  const ageMs = Date.now() - session.createdAt.getTime();
  const expired = session.expiresAt.getTime() <= Date.now();
  const tooOld = ageMs > ABSOLUTE_MAX_DAYS * DAY_MS;

  if (expired || tooOld) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (ageMs > REFRESH_AFTER_DAYS * DAY_MS) {
    // Clamped, so the refresh can extend a session towards the ceiling but
    // never through it.
    const ceiling = new Date(session.createdAt.getTime() + ABSOLUTE_MAX_DAYS * DAY_MS);
    const next = new Date(Math.min(expiryFromNow().getTime(), ceiling.getTime()));
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt: next } }).catch(() => {});
  }

  return session;
}

export async function revokeSession(token: string) {
  await prisma.session.deleteMany({ where: { tokenHash: digest(token) } });
}

/** Used after a password change, a role change or a 2FA reset, so other devices don't keep a live session. */
export async function revokeAllSessionsFor(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

/** Housekeeping for rows nobody will ever present again. Called from the scheduler. */
export async function purgeExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - ABSOLUTE_MAX_DAYS * DAY_MS);
  const { count } = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lte: new Date() } }, { createdAt: { lte: cutoff } }] },
  });
  return count;
}

/** Both names are read, so a deploy that flips to the `__Host-` cookie doesn't sign everybody out mid-session. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  const found = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SECURE_COOKIE || name === PLAIN_COOKIE) {
      found.set(name, decodeURIComponent(part.slice(eq + 1).trim()));
    }
  }
  return found.get(cookieName()) || found.get(SECURE_COOKIE) || found.get(PLAIN_COOKIE) || null;
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(cookieName(), token, {
    httpOnly: true, // not readable from JavaScript, so an XSS bug can't lift the session
    secure: isProduction(), // plain HTTP on localhost would drop a Secure cookie
    // "lax" rather than "strict" deliberately: the Google Drive consent screen
    // returns the user by top-level navigation from accounts.google.com, and a
    // strict cookie is not sent on that, so the redirect would land logged out.
    // Cross-site *writes* are still blocked, which is the CSRF case that matters.
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * DAY_MS,
  });
}

export function clearSessionCookie(res: Response) {
  const options = { httpOnly: true, secure: isProduction(), sameSite: "lax" as const, path: "/" };
  // Both, so signing out of a session issued before the rename actually clears it.
  res.clearCookie(SECURE_COOKIE, { ...options, secure: true });
  res.clearCookie(PLAIN_COOKIE, options);
}
