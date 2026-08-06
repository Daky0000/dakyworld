import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { readSessionCookie, resolveSession } from "../lib/session.js";
import type { User } from "@prisma/client";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      dbUser?: User;
      sessionToken?: string;
    }
  }
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";
/** Deliberately ignored in production — a stray env var must never disable login on the live system. */
const DEV_NO_AUTH = !IS_PRODUCTION && process.env.DEV_NO_AUTH === "true";
const DEV_OWNER_EMAIL = "dan@dakyworld.local";

/**
 * Creates the first Owner from OWNER_EMAIL / OWNER_PASSWORD, and keeps that
 * password in step with the env var on every boot. That makes a lockout
 * unrecoverable-by-design impossible: change the variable in Railway,
 * redeploy, and you're back in.
 *
 * The flip side is that this account's password belongs to Railway — changing
 * it in the app would be undone by the next deploy — so `/api/auth/password`
 * refuses to touch it.
 */
export async function bootstrapOwner() {
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password) return;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && (await verifyPassword(password, existing.passwordHash))) {
    if (existing.role !== "OWNER" || !existing.active) {
      await prisma.user.update({ where: { id: existing.id }, data: { role: "OWNER", active: true } });
    }
    return; // already in sync
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: "OWNER", active: true },
    create: { email, passwordHash, name: "Dan Kwame Ayipah", role: "OWNER" },
  });
  console.log(`  → Owner account ${existing ? "password reset" : "created"} for ${email} from OWNER_PASSWORD`);
}

/**
 * Resolves the session cookie to `req.dbUser`. Never rejects on its own —
 * `requireAuth` below decides which routes actually need a user, so the login
 * route stays reachable.
 */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    if (DEV_NO_AUTH) {
      req.dbUser = await prisma.user.upsert({
        where: { email: DEV_OWNER_EMAIL },
        update: {},
        create: { email: DEV_OWNER_EMAIL, name: "Dan Kwame Ayipah (dev)", role: "OWNER" },
      });
      return next();
    }

    const token = readSessionCookie(req);
    if (!token) return next();

    const session = await resolveSession(token);
    if (session?.user.active) {
      req.dbUser = session.user;
      req.sessionToken = token;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Gate for everything that isn't the login route or the healthcheck. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.dbUser) return res.status(401).json({ error: "Not authenticated" });
  next();
}

/** Restricts a route to one or more roles. Use after requireAuth. */
export function requireRole(...roles: Array<User["role"]>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.dbUser) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.dbUser.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(" or ")}` });
    }
    next();
  };
}

export { DEV_NO_AUTH, IS_PRODUCTION };
