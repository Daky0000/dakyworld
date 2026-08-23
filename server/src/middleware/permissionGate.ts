import type { NextFunction, Request, Response } from "express";
import { permissionByKey } from "../lib/permissions.js";

/**
 * One line at the top of a router that gates every endpoint under it by what
 * the request is trying to do.
 *
 * The alternative was `requirePermission(...)` written onto each of roughly
 * three hundred routes, and the failure mode of that is not a compile error —
 * it is one `POST` somebody forgot, sitting open, discovered by the person it
 * should have stopped. A default keyed on the HTTP method closes every route in
 * a module at once and makes the exceptions the thing you have to write down.
 *
 * The mapping is the obvious one and is deliberately not clever:
 *
 *     GET / HEAD        → view
 *     POST              → create
 *     PATCH / PUT       → edit
 *     DELETE            → remove
 *
 * `view` is required for **every** request, whatever else is. Somebody who
 * cannot see the invoice list has no business posting to it, and without that
 * floor a role with `invoices.create` and nothing else could write rows into a
 * module it cannot read — which is not a permission anybody meant to grant.
 *
 * `routes` is the exception list, checked before the method default and first
 * match wins. That is where the actions that are not CRUD live: sending,
 * importing, running something that spends money. A POST that sends an email
 * to a stranger and a POST that saves a draft are not the same decision, and
 * the whole point of this system is being able to give somebody the second
 * without the first.
 *
 * Paths in `routes` are matched against the path **within the router**, so they
 * read the same way as the `router.post(...)` line they correspond to.
 */
export type GateRules = {
  view: string;
  create?: string;
  edit?: string;
  remove?: string;
  routes?: Array<{ method?: HttpMethod | HttpMethod[]; path: RegExp; permission: string }>;
};

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * Every permission key that some router actually gates on, collected as the
 * gates are constructed at import time.
 *
 * `checks/access.ts` reads this to assert that no key in the catalogue is
 * decorative. A permission the Access screen offers and no route consults is
 * worse than a missing feature: it is a tick that reads as a restriction and
 * enforces nothing, and the only way to discover it is to grant it to somebody
 * and watch them do the thing anyway.
 */
export const ENFORCED_PERMISSIONS = new Set<string>();

function register(...keys: Array<string | undefined>) {
  for (const key of keys) if (key) ENFORCED_PERMISSIONS.add(key);
}

export function gateBy(rules: GateRules) {
  register(rules.view, rules.create, rules.edit, rules.remove);
  for (const route of rules.routes ?? []) register(route.permission);

  const byMethod: Record<string, string | undefined> = {
    GET: rules.view,
    HEAD: rules.view,
    POST: rules.create,
    PATCH: rules.edit,
    PUT: rules.edit,
    DELETE: rules.remove,
  };

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.dbUser) return res.status(401).json({ error: "Not authenticated" });

    const needed = new Set<string>([rules.view]);

    const override = (rules.routes ?? []).find((route) => {
      if (!route.path.test(req.path)) return false;
      if (!route.method) return true;
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      return methods.includes(req.method as HttpMethod);
    });

    if (override) needed.add(override.permission);
    else {
      const fromMethod = byMethod[req.method];
      // A method with no key declared is a method this module does not offer.
      // Refusing outright rather than falling through to `view` alone means a
      // DELETE against a router that never meant to have one is a 403 and not
      // a 404 discovered later.
      if (!fromMethod && req.method !== "GET" && req.method !== "HEAD") {
        return res.status(403).json({ error: "That action is not available." });
      }
      if (fromMethod) needed.add(fromMethod);
    }

    const missing = [...needed].filter((key) => !req.permissions?.has(key));
    if (missing.length === 0) return next();

    const named = missing.map((key) => permissionByKey(key)?.label ?? key);
    const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} or ${named[named.length - 1]}`;
    return res.status(403).json({ error: `Your role does not include "${list}". Ask an Owner to add it on Team & Access.` });
  };
}

/**
 * Declares a permission that is enforced inside a handler rather than in front
 * of one.
 *
 * Two things in this system cannot be decided from a method and a path, because
 * what they mean depends on the *body*: assigning a lead is a PATCH that
 * happens to carry an `ownerId`, and changing an agent's autonomy is a PATCH
 * that happens to carry `autonomyLevel`. Both share a route with ordinary
 * edits, and splitting the route to suit the permission model would be the tail
 * wagging the dog.
 *
 * So those two are checked with `req.can(...)` at the point the field is read,
 * and named here so the coverage check can still see them. Anything registered
 * this way must have a real `req.can` behind it — this function grants nothing
 * and proves nothing on its own.
 */
export function registerEnforced(...keys: string[]) {
  for (const key of keys) ENFORCED_PERMISSIONS.add(key);
}
