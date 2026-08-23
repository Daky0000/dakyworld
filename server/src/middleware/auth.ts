import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { passwordProblem } from "../lib/passwordPolicy.js";
import { permissionByKey } from "../lib/permissions.js";
import { registerEnforced } from "./permissionGate.js";
import { readSessionCookie, resolveSession } from "../lib/session.js";
import { WITH_ACCESS, effectivePermissions, ownerRoleId, type UserWithAccess } from "../lib/accessRoles.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      dbUser?: UserWithAccess;
      sessionToken?: string;
      /**
       * Everything this caller may do, resolved once per request rather than
       * per check — a route that asks three questions should not cost three
       * array merges, and more importantly every check in one request must
       * agree with every other.
       */
      permissions?: Set<string>;
      /** `req.can("leads.import")`, for decisions inside a handler rather than in front of it. */
      can?: (permission: string) => boolean;
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

  // The Owner *role*, not the enum value, is what actually grants anything now.
  // Pinning this account to it on every boot is the counterpart to the enum
  // reset below: if somebody moves the bootstrap account onto a role with no
  // permissions, the next deploy puts it back, and the documented way into a
  // locked-out system keeps working.
  const accessRoleId = await ownerRoleId();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && (await verifyPassword(password, existing.passwordHash))) {
    if (existing.role !== "OWNER" || !existing.active || existing.accessRoleId !== accessRoleId) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { role: "OWNER", active: true, ...(accessRoleId ? { accessRoleId } : {}) },
      });
    }
    return; // already in sync
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: "OWNER", active: true, ...(accessRoleId ? { accessRoleId } : {}) },
    create: { email, passwordHash, name: "Dan Kwame Ayipah", role: "OWNER", accessRoleId },
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
      const accessRoleId = await ownerRoleId();
      req.dbUser = await prisma.user.upsert({
        where: { email: DEV_OWNER_EMAIL },
        update: accessRoleId ? { accessRoleId } : {},
        create: { email: DEV_OWNER_EMAIL, name: "Dan Kwame Ayipah (dev)", role: "OWNER", accessRoleId },
        include: WITH_ACCESS,
      });
      return attachPermissions(req), next();
    }

    const token = readSessionCookie(req);
    if (!token) return next();

    const session = await resolveSession(token);
    if (session?.user.active) {
      // The session's own join carries the bare user row. The role has to come
      // with it or every permission check on this request would answer "no" —
      // and it is read fresh on each request rather than cached in the session,
      // so a role edited on the Access screen takes effect on the next click
      // rather than at the person's next sign-in.
      req.dbUser =
        (await prisma.user.findUnique({ where: { id: session.user.id }, include: WITH_ACCESS })) ?? undefined;
      req.sessionToken = token;
      attachPermissions(req);
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Resolves the three permission inputs once, and hangs the answer off the request. */
function attachPermissions(req: Request) {
  const permissions = effectivePermissions(req.dbUser);
  req.permissions = permissions;
  req.can = (permission: string) => permissions.has(permission);
}

/** Gate for everything that isn't the login route or the healthcheck. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.dbUser) return res.status(401).json({ error: "Not authenticated" });
  next();
}

/**
 * A role marked `external` belongs to somebody outside the company — and the
 * old `CLIENT_VIEWER` carried no restriction at all: it appeared in the enum, could be
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
 *
 * Note this sits *on top of* permissions rather than instead of them. An
 * external role with `clients.view` ticked still gets nothing, because the
 * ticks describe internal screens and there is no per-client scoping behind
 * them yet. Two independent reasons to say no is the right number here.
 */
const EXTERNAL_ALLOWED = [/^\/auth\//, /^\/users\/me$/, /^\/health$/];

export function scopeExternal(req: Request, res: Response, next: NextFunction) {
  if (!req.dbUser?.accessRole?.external) return next();
  if (EXTERNAL_ALLOWED.some((allowed) => allowed.test(req.path))) return next();
  return res.status(403).json({ error: "This account does not have access to the internal system." });
}

/**
 * How a 403 reads. The catalogue's label is a sentence a person can act on
 * ("Import leads"); the key is what somebody has to tick on the Access screen
 * to fix it. Both, because the first is for whoever hit the wall and the second
 * is for whoever can take it down.
 */
function describe(permissions: string[]): string {
  const named = permissions.map((key) => permissionByKey(key)?.label ?? key);
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} or ${named[named.length - 1]}`;
  return `Your role does not include "${list}". Ask an Owner to add it on Team & Access.`;
}

/**
 * The gate. Everything below `requireAuth` that is not universally readable
 * goes behind one of these.
 *
 * `requirePermission` demands **all** of the keys, `requireAnyPermission` demands
 * one. Most routes want the first; the second exists for screens that several
 * different jobs can open by different routes into them.
 *
 * A route with no gate is a route everybody who can sign in may call. That is
 * occasionally right — `/users/me` — and usually an oversight, which is why
 * `checks/access.ts` prints the ungated list rather than letting it go unseen.
 */
export function requirePermission(...permissions: string[]) {
  // Registering here rather than at each call site is what keeps the coverage
  // check honest without anybody having to remember it: constructing a gate is
  // the same act as declaring that this key is enforced.
  registerEnforced(...permissions);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.dbUser) return res.status(401).json({ error: "Not authenticated" });
    const missing = permissions.filter((key) => !req.permissions?.has(key));
    if (missing.length > 0) return res.status(403).json({ error: describe(missing) });
    next();
  };
}

export function requireAnyPermission(...permissions: string[]) {
  registerEnforced(...permissions);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.dbUser) return res.status(401).json({ error: "Not authenticated" });
    if (!permissions.some((key) => req.permissions?.has(key))) {
      return res.status(403).json({ error: describe(permissions) });
    }
    next();
  };
}

export { DEV_NO_AUTH, IS_PRODUCTION };
