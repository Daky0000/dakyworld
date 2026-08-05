import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";

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
  res.json(req.dbUser);
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
});

// Pre-provisions a User row so the person appears in dropdowns before their
// first real login; their Clerk identity gets linked automatically the first
// time they sign in with this email (see attachUser in middleware/auth.ts —
// note: current implementation matches on clerkUserId, so wire the invite
// flow's email match at signup time once Clerk is live).
usersRouter.post("/", requireRole("OWNER"), async (req, res, next) => {
  try {
    const data = inviteInput.parse(req.body);
    const user = await prisma.user.create({ data });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});
