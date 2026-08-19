import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { passwordProblem } from "../lib/passwordPolicy.js";
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

/**
 * Whether this process is running on a hosting platform rather than somebody's
 * laptop, established from variables the platform sets about itself.
 *
 * This exists because the guard below used to rest on `NODE_ENV` alone, and
 * **nothing in this repository sets `NODE_ENV`.** On Railway it is injected by
 * the Nixpacks builder. That was fine right up until you notice what is on the
 * other side of it: `DEV_NO_AUTH=true` is set on the live service, so the only
 * thing standing between the public internet and an API that treats every
 * caller as the Owner was a variable this codebase neither sets nor controls. A
 * builder change, a runtime migration, or somebody moving the service could have
 * removed it, and the failure would have been silent and total — no error, no
 * crash, just every lead, client, invoice and mailbox credential readable
 * without a login.
 *
 * Two independent signals now have to agree that this is not a deployment, and
 * a missing `NODE_ENV` fails closed instead of open.
 */
const DEPLOYED = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.DYNO ||
    process.env.VERCEL ||
    process.env.KUBERNETES_SERVICE_HOST,
);

/** Local convenience only. A stray env var must never disable login on a deployed system. */
const DEV_NO_AUTH = !IS_PRODUCTION && !DEPLOYED && process.env.DEV_NO_AUTH === "true";

/** True when the variable was set and deliberately ignored — worth saying out loud at boot. */
export const DEV_NO_AUTH_REFUSED = process.env.DEV_NO_AUTH === "true" && !DEV_NO_AUTH;

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

  // A warning, never a refusal. This variable is the documented way back into a
  // locked-out system, so a boot that refuses it turns a weak password into an
  // outage.
  //
  // It runs on *every* boot, before the early return below. Sitting after it —
  // where this started — meant the warning fired only on the one deploy that
  // actually changed the password, and never again: a weak OWNER_PASSWORD would
  // be flagged once, into a log nobody was reading at the time, and then stay
  // weak in silence. A standing reminder is the whole point of it. It costs one
  // line per deploy and disappears the moment it is fixed.
  const problem = passwordProblem(password, { email });
  if (problem) console.warn(`  ⚠ OWNER_PASSWORD is weak: ${problem} Change it in Railway and redeploy.`);

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

/**
 * A `CLIENT_VIEWER` is, by definition, somebody outside the company — and the
 * role carried no restriction at all: it appeared in the enum, could be
 * assigned from the Team screen, and then read every lead, every client, every
 * invoice and every email in the business, because nothing between `requireAuth`
 * and the routers ever looked at it.
 *
 * There is no client portal yet, and no column linking a user to the client
 * they belong to, so there is nothing to scope a client's view *down to*. Until
 * there is, the honest position is a closed door rather than an open one: the
 * role can be assigned and the account can sign in and see itself, and that is
 * all. Widen this deliberately, per route, when the portal exists — never by
 * deleting the check.
 */
const CLIENT_VIEWER_ALLOWED = [/^\/auth\//, /^\/users\/me$/, /^\/health$/];

export function scopeClientViewer(req: Request, res: Response, next: NextFunction) {
  if (req.dbUser?.role !== "CLIENT_VIEWER") return next();
  if (CLIENT_VIEWER_ALLOWED.some((allowed) => allowed.test(req.path))) return next();
  return res.status(403).json({ error: "This account does not have access to the internal system." });
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
