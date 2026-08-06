import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "./prisma.js";

export const SESSION_COOKIE = "dw_session";
const SESSION_TTL_DAYS = 30;
/** Re-issue the expiry when a session is this far along, so active users don't get logged out mid-week. */
const REFRESH_AFTER_DAYS = 1;

const isProduction = () => process.env.NODE_ENV === "production";

/** The database stores only this digest — never the token that's in the cookie. */
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expiryFromNow(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { tokenHash: digest(token), userId, expiresAt: expiryFromNow() } });
  return token;
}

/**
 * Resolves a raw cookie token to its session, sliding the expiry forward for
 * sessions already a day old. Expired rows are deleted rather than ignored so
 * the table doesn't grow without bound.
 */
export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: true },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  const ageMs = Date.now() - session.createdAt.getTime();
  if (ageMs > REFRESH_AFTER_DAYS * 24 * 60 * 60 * 1000) {
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt: expiryFromNow() } }).catch(() => {});
  }

  return session;
}

export async function revokeSession(token: string) {
  await prisma.session.deleteMany({ where: { tokenHash: digest(token) } });
}

/** Used after a password change, so other devices don't keep a live session. */
export async function revokeAllSessionsFor(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    }
  }
  return null;
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // not readable from JavaScript, so an XSS bug can't lift the session
    secure: isProduction(), // plain HTTP on localhost would drop a Secure cookie
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: isProduction(), sameSite: "lax", path: "/" });
}
