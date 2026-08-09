import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { renderProposalPdf } from "../services/pdf.js";
import { cloudinaryConfigured, uploadBuffer } from "../lib/cloudinary.js";

export const proposalsRouter = Router();

const proposalInput = z.object({
  leadId: z.string().cuid().optional().nullable(),
  clientId: z.string().cuid().optional().nullable(),
  title: z.string().min(1),
  serviceType: z.string().min(1),
  scopeSummary: z.string().min(1),
  priceAmount: z.number().nonnegative(),
  priceTier: z.string().optional().nullable(),
  currency: z.string().default("GHS"),
  expiresAt: z.coerce.date().optional().nullable(),
});

proposalsRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const proposals = await prisma.proposal.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { createdAt: "desc" },
      include: { client: true, lead: true },
    });
    res.json(proposals);
  } catch (err) {
    next(err);
  }
});

proposalsRouter.get("/:id", async (req, res, next) => {
  try {
    const proposal = await prisma.proposal.findUnique({
      where: { id: req.params.id },
      include: { client: true, lead: true, project: true },
    });
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    res.json(proposal);
  } catch (err) {
    next(err);
  }
});

proposalsRouter.post("/", async (req, res, next) => {
  try {
    const data = proposalInput.parse(req.body);
    const proposal = await prisma.proposal.create({ data });
    res.status(201).json(proposal);
  } catch (err) {
    next(err);
  }
});

proposalsRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = proposalInput.partial().parse(req.body);
    const proposal = await prisma.proposal.update({ where: { id: req.params.id }, data });
    res.json(proposal);
  } catch (err) {
    next(err);
  }
});

// POST /api/proposals/:id/generate-pdf — renders the proposal and uploads it,
// storing the URL on the record. Falls back to a raw PDF download if
// Cloudinary isn't configured yet.
proposalsRouter.post("/:id/generate-pdf", async (req, res, next) => {
  try {
    const proposal = await prisma.proposal.findUnique({
      where: { id: req.params.id },
      include: { client: true, lead: true },
    });
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });

    const clientName = proposal.client?.name ?? proposal.lead?.contactName ?? "Prospect";
    const pdf = await renderProposalPdf({
      title: proposal.title,
      clientName,
      serviceType: proposal.serviceType,
      scopeSummary: proposal.scopeSummary,
      priceAmount: proposal.priceAmount.toString(),
      currency: proposal.currency,
      priceTier: proposal.priceTier,
      expiresAt: proposal.expiresAt,
    });

    if (!(await cloudinaryConfigured())) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="proposal-${proposal.id}.pdf"`);
      return res.send(pdf);
    }

    const url = await uploadBuffer(pdf, `proposal-${proposal.id}`, "dakyworld-os/proposals");
    const updated = await prisma.proposal.update({ where: { id: proposal.id }, data: { pdfUrl: url } });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/proposals/:id/send — marks as sent (Section: Proposal & Negotiation status flow)
proposalsRouter.post("/:id/send", async (req, res, next) => {
  try {
    const proposal = await prisma.proposal.update({
      where: { id: req.params.id },
      data: { status: "SENT", sentAt: new Date() },
    });
    res.json(proposal);
  } catch (err) {
    next(err);
  }
});

// POST /api/proposals/:id/accept — marks Won and converts to a Project (per
// the "Proposal to Project" workflow in the spec).
proposalsRouter.post("/:id/accept", async (req, res, next) => {
  try {
    const proposal = await prisma.proposal.findUnique({
      where: { id: req.params.id },
      include: { client: true, lead: true, project: true },
    });
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    if (proposal.project) return res.status(409).json({ error: "Proposal already converted to a project" });

    let clientId = proposal.clientId;
    if (!clientId && proposal.lead) {
      // Auto-create the Client record from lead details on conversion.
      const client = await prisma.client.create({
        data: {
          name: proposal.lead.companyName ?? proposal.lead.contactName,
          email: proposal.lead.contactEmail,
          phone: proposal.lead.contactPhone,
          firstContactAt: proposal.lead.createdAt,
        },
      });
      clientId = client.id;
      await prisma.lead.update({ where: { id: proposal.lead.id }, data: { status: "CONVERTED", clientId } });
    }
    if (!clientId) return res.status(400).json({ error: "Proposal has no client or lead to convert" });

    const [updatedProposal, project] = await prisma.$transaction([
      prisma.proposal.update({ where: { id: proposal.id }, data: { status: "WON", respondedAt: new Date() } }),
      prisma.project.create({
        data: {
          clientId,
          proposalId: proposal.id,
          name: proposal.title,
          serviceType: proposal.serviceType,
          scopeSummary: proposal.scopeSummary,
          budgetAmount: proposal.priceAmount,
          status: "PLANNING",
        },
      }),
    ]);

    res.json({ proposal: updatedProposal, project });
  } catch (err) {
    next(err);
  }
});

proposalsRouter.post("/:id/reject", async (req, res, next) => {
  try {
    const reason = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    const proposal = await prisma.proposal.update({
      where: { id: req.params.id },
      data: { status: "LOST", respondedAt: new Date() },
    });
    if (proposal.leadId && reason.reason) {
      await prisma.lead.update({ where: { id: proposal.leadId }, data: { winLossReason: reason.reason, status: "LOST" } });
    }
    res.json(proposal);
  } catch (err) {
    next(err);
  }
});
