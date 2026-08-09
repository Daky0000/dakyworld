import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { renderInvoicePdf } from "../services/pdf.js";
import { cloudinaryConfigured, uploadBuffer } from "../lib/cloudinary.js";
import { getStripe } from "../lib/stripe.js";

export const invoicesRouter = Router();

const lineItemInput = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().default(1),
  unitPrice: z.number().nonnegative(),
});

const invoiceInput = z.object({
  clientId: z.string().cuid(),
  projectId: z.string().cuid().optional().nullable(),
  carePlanId: z.string().cuid().optional().nullable(),
  currency: z.string().default("GHS"),
  dueDate: z.coerce.date(),
  lineItems: z.array(lineItemInput).min(1),
});

async function nextInvoiceNumber(): Promise<string> {
  const now = new Date();
  const prefix = `DAK-${now.toLocaleString("en-US", { month: "short" }).toUpperCase()}-${now.getFullYear()}`;
  const countThisMonth = await prisma.invoice.count({
    where: { invoiceNumber: { startsWith: prefix } },
  });
  return `${prefix}-${String(countThisMonth + 1).padStart(3, "0")}`;
}

invoicesRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const invoices = await prisma.invoice.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { issueDate: "desc" },
      include: { client: true, lineItems: true },
    });
    res.json(invoices);
  } catch (err) {
    next(err);
  }
});

invoicesRouter.get("/:id", async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { client: true, lineItems: true, project: true, carePlan: true },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

invoicesRouter.post("/", async (req, res, next) => {
  try {
    const data = invoiceInput.parse(req.body);
    const invoiceNumber = await nextInvoiceNumber();
    const lineItems = data.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      amount: li.quantity * li.unitPrice,
    }));
    const amountTotal = lineItems.reduce((sum, li) => sum + li.amount, 0);

    const invoice = await prisma.invoice.create({
      data: {
        clientId: data.clientId,
        projectId: data.projectId,
        carePlanId: data.carePlanId,
        currency: data.currency,
        dueDate: data.dueDate,
        invoiceNumber,
        amountTotal,
        lineItems: { create: lineItems },
      },
      include: { lineItems: true },
    });
    res.status(201).json(invoice);
  } catch (err) {
    next(err);
  }
});

invoicesRouter.post("/:id/generate-pdf", async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { client: true, lineItems: true },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const pdf = await renderInvoicePdf({
      invoiceNumber: invoice.invoiceNumber,
      clientName: invoice.client.name,
      currency: invoice.currency,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      amountTotal: invoice.amountTotal.toString(),
      lineItems: invoice.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity.toString(),
        unitPrice: li.unitPrice.toString(),
        amount: li.amount.toString(),
      })),
    });

    if (!(await cloudinaryConfigured())) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
      return res.send(pdf);
    }

    const url = await uploadBuffer(pdf, invoice.invoiceNumber, "dakyworld-os/invoices");
    const updated = await prisma.invoice.update({ where: { id: invoice.id }, data: { pdfUrl: url } });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

invoicesRouter.post("/:id/send", async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: { status: "SENT", sentAt: new Date() },
    });
    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/create-payment-link — creates a Stripe Checkout
// session for this invoice. Returns 503 with a clear message until real
// Stripe keys are added; the route itself is fully implemented.
invoicesRouter.post("/:id/create-payment-link", async (req, res, next) => {
  try {
    const stripe = await getStripe();
    if (!stripe) {
      return res.status(503).json({
        error: "Stripe is not configured — add the secret key under Settings → Payments to enable payment links.",
      });
    }
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { client: true } });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: invoice.currency.toLowerCase(),
            product_data: { name: `Invoice ${invoice.invoiceNumber}` },
            unit_amount: Math.round(Number(invoice.amountTotal) * 100),
          },
          quantity: 1,
        },
      ],
      customer_email: invoice.client.email ?? undefined,
      success_url: `${process.env.CLIENT_ORIGIN}/invoices/${invoice.id}?paid=1`,
      cancel_url: `${process.env.CLIENT_ORIGIN}/invoices/${invoice.id}`,
      metadata: { invoiceId: invoice.id },
    });

    await prisma.invoice.update({ where: { id: invoice.id }, data: { stripePaymentIntentId: session.id } });
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// Marks an invoice paid manually (bank transfer, etc). Stripe webhook (see
// index.ts) does this automatically for card payments.
invoicesRouter.post("/:id/mark-paid", async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: { status: "PAID", paidAt: new Date() },
    });
    res.json(invoice);
  } catch (err) {
    next(err);
  }
});
