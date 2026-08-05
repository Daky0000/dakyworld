import type { NextFunction, Request, Response } from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { prisma } from "../lib/prisma.js";
import type { User } from "@prisma/client";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      dbUser?: User;
    }
  }
}

const DEV_NO_AUTH = process.env.DEV_NO_AUTH === "true";
const DEV_OWNER_EMAIL = "dan@dakyworld.local";

/**
 * Runs Clerk's request-parsing middleware when auth is enabled. In
 * DEV_NO_AUTH mode this is a no-op — attachUser below supplies a fixed
 * Owner identity instead, so the app is fully usable before Clerk keys exist.
 */
export const clerkParser = DEV_NO_AUTH ? (_req: Request, _res: Response, next: NextFunction) => next() : clerkMiddleware();

/**
 * Resolves the authenticated request to a `dbUser` (our own User row), auto-
 * provisioning it on first sight. Must run after `clerkParser`.
 */
export async function attachUser(req: Request, res: Response, next: NextFunction) {
  try {
    if (DEV_NO_AUTH) {
      req.dbUser = await prisma.user.upsert({
        where: { email: DEV_OWNER_EMAIL },
        update: {},
        create: { email: DEV_OWNER_EMAIL, name: "Dan Kwame Ayipah (dev)", role: "OWNER" },
      });
      return next();
    }

    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    let dbUser = await prisma.user.findUnique({ where: { clerkUserId: userId } });
    if (!dbUser) {
      // First time this Clerk identity has hit the API. The very first user
      // ever created becomes Owner; everyone after defaults to Developer and
      // an Owner must promote them via the Team settings screen.
      const existingCount = await prisma.user.count();
      dbUser = await prisma.user.create({
        data: {
          clerkUserId: userId,
          email: `${userId}@pending.clerk`, // replaced once we sync real profile data from Clerk
          name: "New team member",
          role: existingCount === 0 ? "OWNER" : "DEVELOPER",
        },
      });
    }
    req.dbUser = dbUser;
    next();
  } catch (err) {
    next(err);
  }
}

/** Restricts a route to one or more roles. Use after attachUser. */
export function requireRole(...roles: Array<User["role"]>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.dbUser) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.dbUser.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(" or ")}` });
    }
    next();
  };
}
