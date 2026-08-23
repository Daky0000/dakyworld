import type { AccessRole, User } from "@prisma/client";
import { prisma } from "./prisma.js";
import { ALL_PERMISSION_KEYS, ENUM_TO_SYSTEM_ROLE, SYSTEM_ROLES, knownPermissions } from "./permissions.js";

/** A user row with the role attached — what every permission decision is made from. */
export type UserWithAccess = User & { accessRole: AccessRole | null };

/** Load a user the way the middleware does, so callers outside the request path agree with it. */
export const WITH_ACCESS = { accessRole: true } as const;

/**
 * The three columns a permission decision actually reads.
 *
 * Typed structurally rather than as `UserWithAccess` so that a narrowed
 * `select` — which is what every route that returns a user uses, because the
 * row carries a password hash — can be passed straight in. Demanding the whole
 * row here would push callers towards fetching it, which is the pressure that
 * produced `include: { user: true }` and the leak `lib/userSelect.ts` documents.
 */
export type AccessInputs = {
  extraPermissions: string[];
  deniedPermissions: string[];
  accessRole: { superAdmin: boolean; permissions: string[] } | null;
};

/**
 * What this person may actually do, all three inputs resolved.
 *
 *     (their role's permissions  +  extraPermissions)  −  deniedPermissions
 *
 * Order matters and the order is: **deny wins.** A permission taken away from
 * one person stays away even if somebody later adds it to their role or to
 * their extras — the alternative is a revocation that silently reverses itself
 * weeks later when an unrelated edit happens elsewhere, which is the kind of
 * thing nobody notices until it is in a log.
 *
 * The Owner role short-circuits before any of it. That is not an optimisation:
 * it is what guarantees the Access screen cannot produce a system nobody can
 * administer. Every other role can be edited down to nothing safely, because
 * there is always one that does not read the list.
 */
export function effectivePermissions(user: AccessInputs | null | undefined): Set<string> {
  if (!user?.accessRole) return new Set();
  if (user.accessRole.superAdmin) return new Set(ALL_PERMISSION_KEYS);

  const granted = new Set(knownPermissions(user.accessRole.permissions));
  for (const key of knownPermissions(user.extraPermissions)) granted.add(key);
  for (const key of user.deniedPermissions) granted.delete(key);
  return granted;
}

/** Convenience for the many places that only ask one question. */
export function userCan(user: AccessInputs | null | undefined, permission: string): boolean {
  if (!user?.accessRole) return false;
  if (user.accessRole.superAdmin) return true;
  if (user.deniedPermissions.includes(permission)) return false;
  return user.accessRole.permissions.includes(permission) || user.extraPermissions.includes(permission);
}

/**
 * Creates the six roles the system ships with, and puts every account that has
 * no role onto the one matching its old enum value.
 *
 * Runs on every boot, and is written to be safe on every boot after the first:
 *
 * - **Permissions are set on create and never on update.** A system role is a
 *   starting point, not a fixture — the Owner is meant to edit Developer down
 *   to something tighter, and a seeder that reinstated the shipped list on the
 *   next deploy would quietly undo that. This is the single most important
 *   line in the file.
 * - Name, description and the two flags *are* kept in step, because those are
 *   the seeder's to own and are not editable for system roles anyway.
 * - The backfill only touches `accessRoleId IS NULL`, so it fills in new or
 *   migrated accounts and never reassigns somebody a human moved deliberately.
 */
export async function ensureSystemRoles(): Promise<void> {
  for (const seed of SYSTEM_ROLES) {
    await prisma.accessRole.upsert({
      where: { key: seed.key },
      // Note the absence of `permissions` — see the note above.
      update: {
        name: seed.name,
        description: seed.description,
        system: true,
        superAdmin: Boolean(seed.superAdmin),
        external: Boolean(seed.external),
        sortOrder: seed.sortOrder,
      },
      create: {
        key: seed.key,
        name: seed.name,
        description: seed.description,
        system: true,
        superAdmin: Boolean(seed.superAdmin),
        external: Boolean(seed.external),
        sortOrder: seed.sortOrder,
        permissions: knownPermissions(seed.permissions),
      },
    });
  }

  const unassigned = await prisma.user.findMany({
    where: { accessRoleId: null },
    select: { id: true, role: true },
  });
  if (unassigned.length === 0) return;

  const roles = await prisma.accessRole.findMany({ where: { system: true }, select: { id: true, key: true } });
  const byKey = new Map(roles.map((role) => [role.key, role.id]));

  let linked = 0;
  for (const user of unassigned) {
    const roleId = byKey.get(ENUM_TO_SYSTEM_ROLE[user.role] ?? "");
    if (!roleId) continue;
    await prisma.user.update({ where: { id: user.id }, data: { accessRoleId: roleId } });
    linked += 1;
  }
  if (linked) console.log(`  → ${linked} account${linked === 1 ? "" : "s"} placed on their matching role`);
}

/** The Owner role, which the bootstrap account is pinned to. */
export async function ownerRoleId(): Promise<string | null> {
  const role = await prisma.accessRole.findUnique({ where: { key: "owner" }, select: { id: true } });
  return role?.id ?? null;
}
