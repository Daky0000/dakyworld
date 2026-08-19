import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { hashPassword } from "../lib/password.js";
import { assertPasswordAcceptable, WeakPasswordError } from "../lib/passwordPolicy.js";
import { revokeAllSessionsFor } from "../lib/session.js";
import { PUBLIC_USER } from "../lib/userSelect.js";

export const usersRouter = Router();

usersRouter.get("/", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true, skills: true, weeklyCapacityHours: true },
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

usersRouter.get("/me", async (req, res) => {
  // Field-by-field rather than the whole row — req.dbUser carries the password
  // hash and the second-factor secret.
  const { id, name, email, role, skills, weeklyCapacityHours, totpConfirmedAt } = req.dbUser!;
  res.json({ id, name, email, role, skills, weeklyCapacityHours, twoFactorEnabled: Boolean(totpConfirmedAt) });
});

// Only an Owner can change roles — this is the one place the permission
// model actually bites today, everything else is open within the team.
const roleUpdateInput = z.object({
  role: z.enum(["OWNER", "PROJECT_MANAGER", "DEVELOPER", "DESIGNER", "OPERATIONS_FINANCE", "CLIENT_VIEWER"]),
});

usersRouter.patch("/:id/role", requireRole("OWNER"), async (req, res, next) => {
  try {
    const { role } = roleUpdateInput.parse(req.body);

    // An Owner demoting the last Owner leaves a system nobody can administer,
    // and the only way back is a redeploy with OWNER_PASSWORD set.
    if (role !== "OWNER") {
      const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { role: true } });
      if (target?.role === "OWNER") {
        const owners = await prisma.user.count({ where: { role: "OWNER", active: true } });
        if (owners <= 1) return res.status(409).json({ error: "That is the only Owner. Promote somebody else first." });
      }
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role },
      // Was `prisma.user.update(...)` with no select, which returned the row —
      // password hash included — to whoever changed a role.
      select: PUBLIC_USER,
    });
    // A role is a permission, and permissions are read off the session's user
    // row on every request. Dropping their sessions makes the change take
    // effect now rather than whenever they next sign in.
    await revokeAllSessionsFor(req.params.id);
    res.json(user);
  } catch (err) {
    next(err);
  }
});

const inviteInput = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  role: z.enum(["PROJECT_MANAGER", "DEVELOPER", "DESIGNER", "OPERATIONS_FINANCE", "CLIENT_VIEWER"]).default("DEVELOPER"),
  password: z.string().min(1).max(200).optional(),
});

// Creates a team member. Without a password they still appear in assignment
// dropdowns but can't log in — give them one here or via PATCH :id/password,
// and pass it on out-of-band. There's no invitation email; this is a handful
// of internal people, not public signup.
usersRouter.post("/", requireRole("OWNER"), async (req, res, next) => {
  try {
    const { password, email, ...rest } = inviteInput.parse(req.body);
    if (password) assertPasswordAcceptable(password, { email, name: rest.name });

    const user = await prisma.user.create({
      data: {
        ...rest,
        email: email.trim().toLowerCase(),
        passwordHash: password ? await hashPassword(password) : null,
      },
      select: { id: true, name: true, email: true, role: true },
    });
    res.status(201).json(user);
  } catch (err) {
    if (err instanceof WeakPasswordError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

const setPasswordInput = z.object({ password: z.string().min(1).max(200) });

// An Owner setting someone else's password — the reset path, since there's no
// reset-by-email flow. Every session that member holds is dropped.
usersRouter.patch("/:id/password", requireRole("OWNER"), async (req, res, next) => {
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

/**
 * The way back for a team member whose phone is gone and whose recovery sheet
 * went with it.
 *
 * Owner-only, and it clears the enrolment rather than reading it — there is no
 * path anywhere in this system that reveals somebody's TOTP secret. Their
 * sessions go too: if the reason for the reset is that the phone was stolen,
 * leaving a live session on it defeats the exercise.
 */
usersRouter.delete("/:id/2fa", requireRole("OWNER"), async (req, res, next) => {
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
