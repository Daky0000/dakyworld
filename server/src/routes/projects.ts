import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { PUBLIC_USER } from "../lib/userSelect.js";

export const projectsRouter = Router();

const projectInput = z.object({
  clientId: z.string().cuid(),
  name: z.string().min(1),
  serviceType: z.string().min(1),
  scopeSummary: z.string().min(1),
  status: z.enum(["PLANNING", "IN_PROGRESS", "ON_HOLD", "DELIVERED", "CANCELLED"]).optional(),
  startDate: z.coerce.date().optional().nullable(),
  endDate: z.coerce.date().optional().nullable(),
  budgetAmount: z.number().nonnegative().optional().nullable(),
});

projectsRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const projects = await prisma.project.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { createdAt: "desc" },
      include: {
        client: true,
        assignments: { include: { user: { select: { id: true, name: true } } } },
        _count: { select: { tasks: true, milestones: true } },
      },
    });
    res.json(projects);
  } catch (err) {
    next(err);
  }
});

projectsRouter.get("/:id", async (req, res, next) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        client: true,
        // select, never include — a whole User row carries the password hash
        // and the second-factor secret. See lib/userSelect.ts.
        assignments: { include: { user: { select: PUBLIC_USER } } },
        milestones: { orderBy: { dueDate: "asc" } },
        tasks: { include: { assignee: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
        timeEntries: { include: { user: { select: { id: true, name: true } } }, orderBy: { date: "desc" } },
        invoices: true,
      },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

projectsRouter.post("/", async (req, res, next) => {
  try {
    const data = projectInput.parse(req.body);
    const project = await prisma.project.create({ data });
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

projectsRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = projectInput.partial().parse(req.body);
    const project = await prisma.project.update({ where: { id: req.params.id }, data });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

// --- Assignments ---
projectsRouter.post("/:id/assignments", async (req, res, next) => {
  try {
    const { userId } = z.object({ userId: z.string().cuid() }).parse(req.body);
    const assignment = await prisma.projectAssignment.create({
      data: { projectId: req.params.id, userId },
    });
    res.status(201).json(assignment);
  } catch (err) {
    next(err);
  }
});

projectsRouter.delete("/:id/assignments/:userId", async (req, res, next) => {
  try {
    await prisma.projectAssignment.delete({
      where: { projectId_userId: { projectId: req.params.id, userId: req.params.userId } },
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Milestones ---
const milestoneInput = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
});

projectsRouter.post("/:id/milestones", async (req, res, next) => {
  try {
    const data = milestoneInput.parse(req.body);
    const milestone = await prisma.milestone.create({ data: { ...data, projectId: req.params.id } });
    res.status(201).json(milestone);
  } catch (err) {
    next(err);
  }
});

projectsRouter.patch("/milestones/:milestoneId", async (req, res, next) => {
  try {
    const data = milestoneInput.partial().extend({ completedAt: z.coerce.date().optional().nullable() }).parse(req.body);
    const milestone = await prisma.milestone.update({ where: { id: req.params.milestoneId }, data });
    res.json(milestone);
  } catch (err) {
    next(err);
  }
});

// --- Tasks ---
const taskInput = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  assigneeId: z.string().cuid().optional().nullable(),
  status: z.enum(["TODO", "IN_PROGRESS", "REVIEW", "DONE"]).optional(),
  dueDate: z.coerce.date().optional().nullable(),
  estimateHours: z.number().nonnegative().optional().nullable(),
});

projectsRouter.post("/:id/tasks", async (req, res, next) => {
  try {
    const data = taskInput.parse(req.body);
    const task = await prisma.task.create({ data: { ...data, projectId: req.params.id } });
    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

projectsRouter.patch("/tasks/:taskId", async (req, res, next) => {
  try {
    const data = taskInput.partial().parse(req.body);
    const task = await prisma.task.update({ where: { id: req.params.taskId }, data });
    res.json(task);
  } catch (err) {
    next(err);
  }
});

// --- Time entries ---
const timeEntryInput = z.object({
  userId: z.string().cuid(),
  taskId: z.string().cuid().optional().nullable(),
  date: z.coerce.date().optional(),
  hours: z.number().positive(),
  billable: z.boolean().default(true),
  notes: z.string().optional().nullable(),
});

projectsRouter.post("/:id/time-entries", async (req, res, next) => {
  try {
    const data = timeEntryInput.parse(req.body);
    const [entry] = await prisma.$transaction([
      prisma.timeEntry.create({ data: { ...data, projectId: req.params.id } }),
      prisma.project.update({
        where: { id: req.params.id },
        data: { actualHours: { increment: data.hours } },
      }),
    ]);
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});
