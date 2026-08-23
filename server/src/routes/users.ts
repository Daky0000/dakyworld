import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashPassword } from "../lib/password.js";
import { assertPasswordAcceptable, WeakPasswordError } from "../lib/passwordPolicy.js";
import { revokeAllSessionsFor } from "../lib/session.js";
import { PUBLIC_USER } from "../lib/userSelect.js";
import { knownPermissions } from "../lib/permissions.js";
import { effectivePermissions } from "../lib/accessRoles.js";
import { requirePermission } from "../middleware/auth.js";
import { registerEnforced } from "../middleware/permissionGate.js";

export const usersRouter = Router();

// This router is gated route by route rather than with one `gateBy`, because
// two of its endpoints must stay open to everybody who can sign in: `/me`, and
// the roster the assignment dropdowns are built from.
registerEnforced("team.view");

/**
 * What an account looks like on the Team screen.
 *
 * `PUBLIC_USER` plus the access columns and the second-factor state. Still a
 * `select` rather than the row: the password hash, the TOTP secret and the
 * recovery hashes live on `User` and none of them may leave the server. Adding
 * a sensitive column to the model must never widen this by default — which is
 * the whole reason `lib/userSelect.ts` exists.
 */
const TEAM_MEMBER = {
  ...PUBLIC_USER,
  createdAt: true,
  totpConfirmedAt: true,
  extraPermissions: true,
  deniedPermissions: true,
  accessRole: { select: { id: true, key: true, name: true, system: true, superAdmin: true, external: true, permissions: true } },
} as const;

/**
 * The roster, for the assignment dropdowns.
 *
 * Deliberately **not** behind `team.view`. A Developer who cannot administer
 * anybody still has to be able to put a task in a colleague's name, and a
 * dropdown that comes back empty reads as a broken screen rather than as a
 * permission. It carries a name, an address and a job title — nothing about
 * what anybody is allowed to do.
 */
usersRouter.get("/", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        skills: true,
        weeklyCapacityHours: true,
        accessRole: { select: { name: true } },
      },
    });
    res.json(users.map(({ accessRole, ...user }) => ({ ...user, roleName: accessRole?.name ?? null })));
  } catch (err) {
    next(err);
  }
});

/**
 * Who you are and what you may do.
 *
 * The client renders its whole navigation from `permissions`, so this is the
 * one place the effective set is published. It is the *resolved* answer — role
 * plus extras minus denials — because the client has no business re-deriving
 * that calculation and getting a different answer from the server.
 */
usersRouter.get("/me", async (req, res) => {
  // Field by field rather than the whole row — req.dbUser carries the password
  // hash and the second-factor secret.
  const { id, name, email, role, skills, weeklyCapacityHours, totpConfirmedAt, accessRole } = req.dbUser!;
  res.json({
    id,
    name,
    email,
    role,
    skills,
    weeklyCapacityHours,
    twoFactorEnabled: Boolean(totpConfirmedAt),
    roleId: accessRole?.id ?? null,
    roleName: accessRole?.name ?? null,
    permissions: [...effectivePermissions(req.dbUser)].sort(),
  });
});

/** The administrative list — everybody, including deactivated accounts. */
usersRouter.get("/manage", requirePermission("team.view"), async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: TEAM_MEMBER,
    });

    // "Can this person actually sign in" is a real question on this screen —
    // an account pre-provisioned for an assignment dropdown has no password and
    // looks identical to one that does. Asked as a separate query returning
    // ids, because the answer must never be arrived at by selecting the hash
    // and testing it in application code.
    const withPassword = new Set(
      (await prisma.user.findMany({ where: { passwordHash: { not: null } }, select: { id: true } })).map((u) => u.id),
    );

    res.json(
      users.map(({ totpConfirmedAt, ...user }) => ({
        ...user,
        twoFactorEnabled: Boolean(totpConfirmedAt),
        canSignIn: withPassword.has(user.id),
        // The resolved set, so the screen can show what somebody can actually
        // do without re-implementing the precedence rules and disagreeing with
        // the server about the answer.
        effectivePermissions: [...effectivePermissions(user)].sort(),
      })),
    );
  } catch (err) {
    next(err);
  }
});

const inviteInput = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  accessRoleId: z.string().min(1).optional(),
  password: z.string().min(1).max(200).optional(),
});

/**
 * Creates a team member. Without a password they still appear in assignment
 * dropdowns but can't log in — give them one here or via PATCH :id/password,
 * and pass it on out-of-band. There's no invitation email; this is a handful
 * of internal people, not public signup.
 *
 * **A new account with no role has no access to anything.** That is the answer
 * to "what should somebody see before I have decided": nothing. The old
 * behaviour defaulted them to DEVELOPER, which on the day this shipped meant
 * every lead, every client, every proposal and every invoice in the business,
 * chosen by a `.default()` in a Zod schema.
 */
usersRouter.post("/", requirePermission("team.invite"), async (req, res, next) => {
  try {
    const { password, email, accessRoleId, ...rest } = inviteInput.parse(req.body);
    if (password) assertPasswordAcceptable(password, { email, name: rest.name });

    if (accessRoleId) {
      const refusal = await refuseUngrantableRole(req, accessRoleId);
      if (refusal) return res.status(403).json({ error: refusal });
    }

    const user = await prisma.user.create({
      data: {
        ...rest,
        email: email.trim().toLowerCase(),
        passwordHash: password ? await hashPassword(password) : null,
        accessRoleId: accessRoleId ?? null,
      },
      select: TEAM_MEMBER,
    });
    res.status(201).json(user);
  } catch (err) {
    if (err instanceof WeakPasswordError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

const profileInput = z.object({
  name: z.string().min(1).max(120).optional(),
  skills: z.array(z.string().min(1).max(60)).max(40).optional(),
  weeklyCapacityHours: z.number().min(0).max(168).optional(),
});

/** Name, skills and capacity — the parts of a person that are not permissions. */
usersRouter.patch("/:id", requirePermission("team.edit"), async (req, res, next) => {
  try {
    const input = profileInput.parse(req.body);
    const user = await prisma.user.update({ where: { id: req.params.id }, data: input, select: TEAM_MEMBER });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

const accessInput = z.object({
  accessRoleId: z.string().min(1).nullable(),
  /** Given on top of the role. */
  extraPermissions: z.array(z.string().max(80)).max(200).default([]),
  /** Taken away even though the role carries it. Wins over both. */
  deniedPermissions: z.array(z.string().max(80)).max(200).default([]),
});

/**
 * The screen this whole feature exists for: give somebody a role, then add or
 * remove individual features for them.
 *
 * Four refusals, each protecting against a different way this goes wrong.
 */
usersRouter.patch("/:id/access", requirePermission("team.access"), async (req, res, next) => {
  try {
    const input = accessInput.parse(req.body);

    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, accessRole: { select: { key: true, superAdmin: true } } },
    });
    if (!target) return res.status(404).json({ error: "No such user" });

    // 1. Nobody edits their own access. An Owner who ticks the wrong box on
    //    their own account is locked out of the screen that would undo it, and
    //    the only way back is a redeploy with OWNER_PASSWORD set. Somebody else
    //    with the permission can always do it for them.
    if (target.id === req.dbUser!.id) {
      return res.status(409).json({ error: "You cannot change your own access. Ask another Owner." });
    }

    // 2. The last Owner stays an Owner. Demoting them leaves a system nobody
    //    can administer.
    if (target.accessRole?.superAdmin) {
      const stillOwner = input.accessRoleId
        ? await prisma.accessRole.findUnique({ where: { id: input.accessRoleId }, select: { superAdmin: true } })
        : null;
      if (!stillOwner?.superAdmin) {
        const owners = await prisma.user.count({ where: { active: true, accessRole: { superAdmin: true } } });
        if (owners <= 1) return res.status(409).json({ error: "That is the only Owner. Promote somebody else first." });
      }
    }

    // 3. You cannot hand out what you do not hold. Without this, giving
    //    somebody "Assign access" would give them everything: their first act
    //    could be to tick every box on their own colleague's account, or to
    //    create a role carrying the whole catalogue and put a friend on it.
    //    A permission system that can be used to widen itself is not one.
    if (input.accessRoleId) {
      const refusal = await refuseUngrantableRole(req, input.accessRoleId);
      if (refusal) return res.status(403).json({ error: refusal });
    }
    const overreach = knownPermissions(input.extraPermissions).filter((key) => !req.permissions?.has(key));
    if (overreach.length > 0) {
      return res.status(403).json({ error: `You cannot grant a feature you do not have yourself: ${overreach.join(", ")}` });
    }

    const user = await prisma.user.update({
      where: { id: target.id },
      data: {
        accessRoleId: input.accessRoleId,
        // Unknown keys are dropped on the way in as well as on the way out, so
        // a stale grant cannot be reintroduced by an old client.
        extraPermissions: knownPermissions(input.extraPermissions),
        deniedPermissions: knownPermissions(input.deniedPermissions),
      },
      select: TEAM_MEMBER,
    });

    // 4. Permissions are read off the user row on every request, so this is
    //    already live — but a session is also the thing that proves who they
    //    are, and somebody whose access has just been narrowed should be made
    //    to sign in again rather than discovering it one 403 at a time.
    await revokeAllSessionsFor(target.id);
    res.json(user);
  } catch (err) {
    next(err);
  }
});

const setPasswordInput = z.object({ password: z.string().min(1).max(200) });

// Setting someone else's password — the reset path, since there's no
// reset-by-email flow. Every session that member holds is dropped.
usersRouter.patch("/:id/password", requirePermission("team.password"), async (req, res, next) => {
  try {
    const { password } = setPasswordInput.parse(req.body);
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { email: true, name: true },
    });
    if (!target) return res.status(404).json({ error: "No such user" });

    assertPasswordAcceptable(password, target);

    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash: await hashPassword(password) },
    });
    await revokeAllSessionsFor(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof WeakPasswordError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

const activeInput = z.object({ active: z.boolean() });

/**
 * Switching an account off, which is what happens when somebody leaves.
 *
 * Deactivating rather than deleting, because a deleted user takes their name
 * off every task, time entry, email and lead they ever touched — the history
 * stops making sense to keep a table tidy.
 */
usersRouter.patch("/:id/active", requirePermission("team.deactivate"), async (req, res, next) => {
  try {
    const { active } = activeInput.parse(req.body);
    if (req.params.id === req.dbUser!.id) {
      return res.status(409).json({ error: "You cannot deactivate your own account." });
    }

    if (!active) {
      const target = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { accessRole: { select: { superAdmin: true } } },
      });
      if (target?.accessRole?.superAdmin) {
        const owners = await prisma.user.count({ where: { active: true, accessRole: { superAdmin: true } } });
        if (owners <= 1) return res.status(409).json({ error: "That is the only Owner. Promote somebody else first." });
      }
    }

    const user = await prisma.user.update({ where: { id: req.params.id }, data: { active }, select: TEAM_MEMBER });
    // A deactivated account with a live session is still a live account.
    if (!active) await revokeAllSessionsFor(req.params.id);
    res.json(user);
  } catch (err) {
    next(err);
  }
});

/**
 * The way back for a team member whose phone is gone and whose recovery sheet
 * went with it.
 *
 * It clears the enrolment rather than reading it — there is no path anywhere in
 * this system that reveals somebody's TOTP secret. Their sessions go too: if
 * the reason for the reset is that the phone was stolen, leaving a live session
 * on it defeats the exercise.
 */
usersRouter.delete("/:id/2fa", requirePermission("team.twofactor"), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, totpConfirmedAt: true },
    });
    if (!target) return res.status(404).json({ error: "No such user" });
    if (!target.totpConfirmedAt) return res.status(409).json({ error: `${target.name} does not have two-factor on.` });

    await prisma.user.update({
      where: { id: target.id },
      data: { totpSecret: null, totpConfirmedAt: null, totpRecoveryHashes: [], totpLastStep: null },
    });
    await revokeAllSessionsFor(target.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Refuses a role that carries more than the caller does.
 *
 * The same escalation guard as the one on `extraPermissions`, applied to the
 * role as a whole — otherwise the check on individual grants is trivially
 * sidestepped by putting the person on a role that already has them.
 */
async function refuseUngrantableRole(req: { permissions?: Set<string> }, accessRoleId: string): Promise<string | null> {
  const role = await prisma.accessRole.findUnique({
    where: { id: accessRoleId },
    select: { name: true, superAdmin: true, permissions: true },
  });
  if (!role) return "No such role";
  if (role.superAdmin && !req.permissions?.has("team.roles")) {
    return "Only somebody who can manage roles may make another Owner.";
  }
  const beyond = knownPermissions(role.permissions).filter((key) => !req.permissions?.has(key));
  if (beyond.length > 0) return `"${role.name}" includes features you do not have yourself: ${beyond.join(", ")}`;
  return null;
}
