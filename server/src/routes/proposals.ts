import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { renderProposalPdf, type ProposalBody } from "../services/pdf.js";
import { renderProposalDocx } from "../services/proposalDocx.js";
import { cloudinaryConfigured, uploadBuffer } from "../lib/cloudinary.js";
import { AnalystError } from "../lib/anthropic.js";
import { writeProposal } from "../lib/proposalWriter.js";
import { resolveProposalContext } from "../services/proposalContext.js";
import { auditCompany, sortFindings } from "../services/companyAudit.js";

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
  /** The argued document, when this came from the writer. Stored as-is. */
  body: z.record(z.unknown()).optional().nullable(),
  audit: z.record(z.unknown()).optional().nullable(),
  generatedBy: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
});

/** Prisma wants DbNull rather than null to clear a Json column. */
function json(value: Record<string, unknown> | null | undefined) {
  if (value === undefined) return undefined;
  return (value ?? Prisma.DbNull) as Prisma.InputJsonValue;
}

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
    const { body, audit, ...data } = proposalInput.parse(req.body);
    const proposal = await prisma.proposal.create({
      data: { ...data, body: json(body), audit: json(audit) },
    });
    res.status(201).json(proposal);
  } catch (err) {
    next(err);
  }
});

proposalsRouter.patch("/:id", async (req, res, next) => {
  try {
    const { body, audit, ...data } = proposalInput.partial().parse(req.body);
    const proposal = await prisma.proposal.update({
      where: { id: req.params.id },
      data: { ...data, body: json(body), audit: json(audit) },
    });
    res.json(proposal);
  } catch (err) {
    next(err);
  }
});

// --- The writer ------------------------------------------------------------

/**
 * POST /api/proposals/draft — audits the company, then writes a proposal about
 * what it found. Returns the draft *without* saving it: the Owner reads it,
 * edits the number, and saves it as a normal proposal. Nothing generated here
 * reaches a prospect without a person in between.
 *
 * Slow by nature — a live site fetch, DNS lookups, and a high-effort model
 * call. That is the correct trade for a document that decides a deal.
 */
proposalsRouter.post("/draft", async (req, res, next) => {
  try {
    const input = z
      .object({
        leadId: z.string().cuid().optional().nullable(),
        clientId: z.string().cuid().optional().nullable(),
        /** The Owner's steer on angle or scope; overrides the writer's judgement. */
        brief: z.string().max(2000).optional().nullable(),
      })
      .refine((value) => value.leadId || value.clientId, { message: "Say which lead or client this proposal is for" })
      .parse(req.body);

    const context = await resolveProposalContext(input);
    const { draft, model, inputTokens, outputTokens } = await writeProposal(context, input.brief);

    res.json({
      draft,
      audit: { ...context.audit, findings: sortFindings(context.audit.findings) },
      subject: {
        kind: context.kind,
        leadId: context.leadId,
        clientId: context.clientId,
        companyName: context.companyName,
        contactName: context.contactName,
        contactEmail: context.contactEmail,
        cold: context.cold,
      },
      /** What the writer was given, so the Owner can see why it said what it said. */
      facts: context.facts,
      model,
      usage: { inputTokens, outputTokens },
    });
  } catch (err) {
    if (err instanceof AnalystError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * POST /api/proposals/audit — the evidence on its own, with no model call and
 * no cost. Useful before writing (is there enough here to be worth it?) and
 * before a call (what should I ask about?).
 */
proposalsRouter.post("/audit", async (req, res, next) => {
  try {
    const input = z
      .object({ leadId: z.string().cuid().optional().nullable(), clientId: z.string().cuid().optional().nullable() })
      .refine((value) => value.leadId || value.clientId, { message: "Say which lead or client to check" })
      .parse(req.body);

    const lead = input.leadId
      ? await prisma.lead.findUnique({ where: { id: input.leadId } })
      : null;
    if (input.leadId && !lead) return res.status(404).json({ error: "Lead not found" });

    const audit = lead
      ? await auditCompany({
          companyName: lead.companyName ?? lead.contactName,
          website: lead.website,
          contactEmail: lead.contactEmail,
          rating: lead.rating == null ? null : Number(lead.rating),
          reviewsCount: lead.reviewsCount,
          socialLinks: (lead.socialLinks as Record<string, string> | null) ?? null,
          category: lead.category,
          city: lead.city,
        })
      : (await resolveProposalContext(input)).audit;

    res.json({ ...audit, findings: sortFindings(audit.findings) });
  } catch (err) {
    next(err);
  }
});

// --- Preview and download --------------------------------------------------

/** The record, in the shape both renderers take. */
async function documentData(id: string) {
  const proposal = await prisma.proposal.findUnique({
    where: { id },
    include: { client: true, lead: true },
  });
  if (!proposal) return null;

  return {
    proposal,
    data: {
      title: proposal.title,
      // Addressed to the business, not to whoever answered the phone.
      clientName: proposal.client?.name ?? proposal.lead?.companyName ?? proposal.lead?.contactName ?? "Prospect",
      serviceType: proposal.serviceType,
      scopeSummary: proposal.scopeSummary,
      priceAmount: proposal.priceAmount.toString(),
      currency: proposal.currency,
      priceTier: proposal.priceTier,
      expiresAt: proposal.expiresAt,
      body: (proposal.body as ProposalBody | null) ?? null,
    },
  };
}

/** `Dakyworld-Proposal-Adjei-Dental-Centre` — what it should be called on disk. */
function fileStem(clientName: string): string {
  const slug = clientName
    .normalize("NFKD")
    .replace(/[^\dA-Za-z]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `Dakyworld-Proposal${slug ? `-${slug}` : ""}`;
}

/**
 * GET /api/proposals/:id/document.pdf — the finished document, streamed.
 *
 * A GET with no side effects, because that is what an `<iframe>` and a download
 * link can both point at: the preview in the app is the same bytes the client
 * receives, not an HTML approximation of them that can drift. `?download=1`
 * switches the disposition to attachment.
 */
proposalsRouter.get("/:id/document.pdf", async (req, res, next) => {
  try {
    const found = await documentData(req.params.id);
    if (!found) return res.status(404).json({ error: "Proposal not found" });

    const pdf = await renderProposalPdf(found.data);
    const disposition = req.query.download ? "attachment" : "inline";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${disposition}; filename="${fileStem(found.data.clientName)}.pdf"`);
    res.setHeader("Content-Length", pdf.length);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/proposals/:id/document.docx — the same document as Word, on the same
 * letterhead. Always an attachment: no browser previews .docx inline.
 */
proposalsRouter.get("/:id/document.docx", async (req, res, next) => {
  try {
    const found = await documentData(req.params.id);
    if (!found) return res.status(404).json({ error: "Proposal not found" });

    const docx = await renderProposalDocx(found.data);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${fileStem(found.data.clientName)}.docx"`);
    res.setHeader("Content-Length", docx.length);
    res.send(docx);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/proposals/document/preview.pdf — the same renderer, over a draft
 * that has not been saved. Lets the writer's review screen show the real
 * document before the Owner commits to it.
 */
proposalsRouter.post("/document/preview.pdf", async (req, res, next) => {
  try {
    const input = z
      .object({
        title: z.string().min(1),
        clientName: z.string().min(1),
        serviceType: z.string().default("Proposal"),
        scopeSummary: z.string().default(""),
        priceAmount: z.union([z.number(), z.string()]).default(0),
        currency: z.string().default("GHS"),
        priceTier: z.string().nullable().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
        body: z.record(z.unknown()).nullable().optional(),
      })
      .parse(req.body);

    const pdf = await renderProposalPdf({
      ...input,
      priceAmount: String(input.priceAmount),
      priceTier: input.priceTier ?? null,
      expiresAt: input.expiresAt ?? null,
      body: (input.body as ProposalBody | null) ?? null,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileStem(input.clientName)}.pdf"`);
    res.setHeader("Content-Length", pdf.length);
    res.send(pdf);
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

    // A proposal is addressed to the business, not to whoever answered the
    // phone — "Prepared for: Kwame Mensah" reads as a personal quote.
    const clientName =
      proposal.client?.name ?? proposal.lead?.companyName ?? proposal.lead?.contactName ?? "Prospect";
    const pdf = await renderProposalPdf({
      title: proposal.title,
      clientName,
      serviceType: proposal.serviceType,
      scopeSummary: proposal.scopeSummary,
      priceAmount: proposal.priceAmount.toString(),
      currency: proposal.currency,
      priceTier: proposal.priceTier,
      expiresAt: proposal.expiresAt,
      body: (proposal.body as ProposalBody | null) ?? null,
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
