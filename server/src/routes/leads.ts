import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

export const leadsRouter = Router();

const leadInput = z.object({
  contactName: z.string().min(1),
  contactEmail: z.string().email().optional().nullable(),
  contactPhone: z.string().optional().nullable(),
  companyName: z.string().optional().nullable(),
  source: z.enum(["REFERRAL", "LINKEDIN", "COLD_EMAIL", "OUTREACH", "CONTENT", "WARM_NETWORK", "OTHER"]).default("OTHER"),
  status: z.enum(["NEW", "QUALIFYING", "QUALIFIED", "DISQUALIFIED", "CONVERTED", "LOST"]).default("NEW"),
  leadScore: z.number().int().min(0).max(100).default(0),
  discoveryCallAt: z.coerce.date().optional().nullable(),
  discoveryNotes: z.string().optional().nullable(),
  estimatedDealSize: z.number().nonnegative().optional().nullable(),
  winLossReason: z.string().optional().nullable(),
  clientId: z.string().cuid().optional().nullable(),
});

// GET /api/leads?status=QUALIFIED
leadsRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const leads = await prisma.lead.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { createdAt: "desc" },
      include: { client: true, proposals: { select: { id: true, status: true } } },
    });
    res.json(leads);
  } catch (err) {
    next(err);
  }
});

// GET /api/leads/:id
leadsRouter.get("/:id", async (req, res, next) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { client: true, proposals: true, communications: { orderBy: { occurredAt: "desc" } } },
    });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    res.json(lead);
  } catch (err) {
    next(err);
  }
});

// POST /api/leads
leadsRouter.post("/", async (req, res, next) => {
  try {
    const data = leadInput.parse(req.body);
    const lead = await prisma.lead.create({ data });
    res.status(201).json(lead);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/leads/:id
leadsRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = leadInput.partial().parse(req.body);
    const lead = await prisma.lead.update({ where: { id: req.params.id }, data });
    res.json(lead);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/leads/:id
leadsRouter.delete("/:id", async (req, res, next) => {
  try {
    await prisma.lead.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
