import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { hashPassword } from "../lib/password.js";
import { revokeAllSessionsFor } from "../lib/session.js";

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
  // Field-by-field rather than the whole row — req.dbUser carries passwordHash.
  const { id, name, email, role, skills, weeklyCapacityHours } = req.dbUser!;
  res.json({ id, name, email, role, skills, weeklyCapacityHours });
});

// Only an Owner can change roles — this is the one place the permission
// model actually bites today, everything else is open within the team.
const roleUpdateInput = z.object({
  role: z.enum(["OWNER", "PROJECT_MANAGER", "DEVELOPER", "DESIGNER", "OPERATIONS_FINANCE", "CLIENT_VIEWER"]),
});

usersRouter.patch("/:id/role", requireRole("OWNER"), async (req, res, next) => {
  try {
    const { role } = roleUpdateInput.parse(req.body);
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { role } });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

const inviteInput = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["PROJECT_MANAGER", "DEVELOPER", "DESIGNER", "OPERATIONS_FINANCE", "CLIENT_VIEWER"]).default("DEVELOPER"),
  password: z.string().min(10, "Use at least 10 characters").optional(),
});

// Creates a team member. Without a password they still appear in assignment
// dropdowns but can't log in — give them one here or via PATCH :id/password,
// and pass it on out-of-band. There's no invitation email; this is a handful
// of internal people, not public signup.
usersRouter.post("/", requireRole("OWNER"), async (req, res, next) => {
  try {
    const { password, email, ...rest } = inviteInput.parse(req.body);
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
    next(err);
  }
});

const setPasswordInput = z.object({ password: z.string().min(10, "Use at least 10 characters") });

// An Owner setting someone else's password — the reset path, since there's no
// reset-by-email flow. Every session that member holds is dropped.
usersRouter.patch("/:id/password", requireRole("OWNER"), async (req, res, next) => {
  try {
    const { password } = setPasswordInput.parse(req.body);
    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash: await hashPassword(password) },
    });
    await revokeAllSessionsFor(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
