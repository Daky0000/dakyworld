import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { PERMISSION_MODULES, knownPermissions } from "../lib/permissions.js";
import { gateBy } from "../middleware/permissionGate.js";

/**
 * Roles, and the catalogue of features they are made of.
 *
 * The split from `usersRouter` is the split between *what a role is* and *who
 * holds it*. They are different decisions with different blast radii: putting
 * one person on a tighter role affects one person, and editing what that role
 * contains affects everybody on it at once, which is why they sit on different
 * permissions (`team.access` and `team.roles`).
 */
export const accessRouter = Router();

accessRouter.use(
  gateBy({
    // Reading the roles is part of administering people — the Team screen needs
    // the list to render its dropdown.
    view: "team.view",
    create: "team.roles",
    edit: "team.roles",
    remove: "team.roles",
  }),
);

/**
 * Everything that can be granted, grouped as the Access screen draws it.
 *
 * Served from the code catalogue rather than from a table, because that is
 * where it lives — see the note at the top of lib/permissions.ts. A client
 * built against an older release simply sees fewer keys, which is the correct
 * failure.
 */
accessRouter.get("/permissions", (_req, res) => {
  res.json(PERMISSION_MODULES);
});

accessRouter.get("/roles", async (_req, res, next) => {
  try {
    const roles = await prisma.accessRole.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { users: true } } },
    });
    res.json(
      roles.map(({ _count, ...role }) => ({
        ...role,
        permissions: knownPermissions(role.permissions),
        userCount: _count.users,
      })),
    );
  } catch (err) {
    next(err);
  }
});

const roleInput = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(400).nullable().optional(),
  permissions: z.array(z.string().max(80)).max(200).default([]),
});

/** A slug that will not collide with a system role or with an existing custom one. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "role"
  );
}

/**
 * Creates a role.
 *
 * **It starts with whatever was ticked and nothing else** — there is no
 * inherited baseline, no "everything a Developer has, plus". Inheritance reads
 * as a convenience and behaves as a trapdoor: the day somebody widens the
 * parent, every role beneath it widens too, and nobody is looking at the child
 * when that happens.
 */
accessRouter.post("/roles", async (req, res, next) => {
  try {
    const input = roleInput.parse(req.body);

    const refusal = refuseOverreach(req, input.permissions);
    if (refusal) return res.status(403).json({ error: refusal });

    // Slugs are permanent, so a collision is resolved at creation rather than
    // by rejecting a perfectly reasonable name somebody typed.
    const base = slugify(input.name);
    const taken = new Set((await prisma.accessRole.findMany({ select: { key: true } })).map((r) => r.key));
    let key = base;
    for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;

    const role = await prisma.accessRole.create({
      data: {
        key,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        permissions: knownPermissions(input.permissions),
        system: false,
      },
    });
    res.status(201).json({ ...role, userCount: 0 });
  } catch (err) {
    next(err);
  }
});

const roleUpdate = roleInput.partial();

accessRouter.patch("/roles/:id", async (req, res, next) => {
  try {
    const input = roleUpdate.parse(req.body);
    const role = await prisma.accessRole.findUnique({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ error: "No such role" });

    // The Owner role answers every check without reading its permission list,
    // so editing that list would be theatre — a screen showing ticks that
    // decide nothing. Refusing says so plainly instead.
    if (role.superAdmin) {
      return res.status(409).json({ error: "The Owner role always has every feature. It cannot be edited." });
    }

    if (input.permissions) {
      const refusal = refuseOverreach(req, input.permissions);
      if (refusal) return res.status(403).json({ error: refusal });
    }

    const updated = await prisma.accessRole.update({
      where: { id: role.id },
      data: {
        // A system role keeps its shipped name and description — those are how
        // it is referred to in the documentation and in this codebase. What it
        // *contains* is entirely editable, which is the part that matters.
        ...(input.name && !role.system ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined && !role.system ? { description: input.description?.trim() || null } : {}),
        ...(input.permissions ? { permissions: knownPermissions(input.permissions) } : {}),
      },
      include: { _count: { select: { users: true } } },
    });

    // Everyone on this role is now working to a different set of rules. The
    // rules are already live — permissions are read per request — but a session
    // that has just been narrowed should be re-established rather than
    // discovering it one refusal at a time.
    if (input.permissions) {
      const holders = await prisma.user.findMany({ where: { accessRoleId: role.id }, select: { id: true } });
      await prisma.session.deleteMany({ where: { userId: { in: holders.map((h) => h.id) } } });
    }

    const { _count, ...rest } = updated;
    res.json({ ...rest, permissions: knownPermissions(rest.permissions), userCount: _count.users });
  } catch (err) {
    next(err);
  }
});

/**
 * Deletes a role.
 *
 * Refused while anybody holds it. The foreign key is `ON DELETE SET NULL`, so
 * the database would allow it and quietly leave those accounts with no access
 * at all — people locked out with nothing on any screen saying why. Making the
 * caller reassign first turns a silent outage into an obvious errand.
 */
accessRouter.delete("/roles/:id", async (req, res, next) => {
  try {
    const role = await prisma.accessRole.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) return res.status(404).json({ error: "No such role" });
    if (role.system) return res.status(409).json({ error: `"${role.name}" is a built-in role and cannot be deleted.` });
    if (role._count.users > 0) {
      const people = role._count.users === 1 ? "1 person is" : `${role._count.users} people are`;
      return res.status(409).json({ error: `${people} on "${role.name}". Move them to another role first.` });
    }

    await prisma.accessRole.delete({ where: { id: role.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Refuses a role that would carry more than the person building it holds.
 *
 * Same reasoning as the guard in `usersRouter`: a permission system that can be
 * used to widen itself is not one. Without this, `team.roles` is equivalent to
 * every permission in the catalogue — create a role with everything ticked, put
 * yourself on it, done.
 *
 * It costs an Owner nothing, because the Owner role passes every check.
 */
function refuseOverreach(req: { permissions?: Set<string> }, permissions: string[]): string | null {
  const beyond = knownPermissions(permissions).filter((key) => !req.permissions?.has(key));
  if (beyond.length === 0) return null;
  return `You cannot put a feature into a role that you do not have yourself: ${beyond.join(", ")}`;
}
