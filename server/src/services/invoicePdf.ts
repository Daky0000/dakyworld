import { prisma } from "../lib/prisma.js";
import { renderInvoicePdf, type InvoicePdfData, type InvoiceStamp } from "./pdf.js";
import type { InvoiceStatus } from "@prisma/client";
import { TIER_LABEL } from "./carePlanCatalogue.js";

/**
 * The one route from an Invoice row to the branded PDF.
 *
 * There were two, and they had drifted: "Generate PDF" on an invoice rendered
 * the full document — who it is billed to, the status stamp, the terms — while
 * the email attachment path rendered a stripped version with a third of the
 * fields missing. A client could be sent an invoice email whose PDF named no
 * address and carried no stamp, beside the same invoice downloaded from the
 * app looking like a different document.
 *
 * This is the template both now go through. Anything that ever puts an invoice
 * in front of a client — the download button, an email attachment, a future
 * automation — calls this, so there is exactly one look an invoice can have.
 */

/** A client address is stored as one field; the letterhead wants it as lines. */
function addressLines(address: string | null): string[] {
  if (!address) return [];
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The stored status, as the client should read it on the document.
 *
 * Two translations. `VIEWED` is a fact about our tracking, not about the
 * client's obligation, so it prints as SENT. And a `SENT` invoice whose due
 * date has passed *is* overdue whether or not a job has got round to
 * restatusing the row — the printed document should never be gentler than the
 * calendar.
 */
function invoiceStamp(status: InvoiceStatus, dueDate: Date): InvoiceStamp {
  if (status === "PAID" || status === "DRAFT" || status === "OVERDUE") return status;
  return dueDate.getTime() < Date.now() ? "OVERDUE" : "SENT";
}

/**
 * Renders the invoice on the brand letterhead. Null when the id names no
 * invoice — the caller decides whether that is a skipped attachment or a 404.
 */
export async function renderInvoicePdfFor(invoiceId: string): Promise<{ filename: string; pdf: Buffer } | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: true, lineItems: true, project: true, carePlan: true },
  });
  if (!invoice) return null;

  const data: InvoicePdfData = {
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.client.name,
    clientCompany: invoice.client.company,
    clientAddressLines: addressLines(invoice.client.address),
    clientEmail: invoice.client.email,
    clientPhone: invoice.client.phone,
    currency: invoice.currency,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    paidDate: invoice.paidAt,
    status: invoiceStamp(invoice.status, invoice.dueDate),
    // The tier as the website writes it, not the raw enum: a client should not
    // read "TRANSFORMATION care plan" on a document they keep.
    reference: invoice.project?.name ?? (invoice.carePlan ? `${TIER_LABEL[invoice.carePlan.tier]} monthly partnership` : null),
    paymentTerms: invoice.client.creditTerms,
    amountTotal: invoice.amountTotal.toString(),
    lineItems: invoice.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity.toString(),
      unitPrice: li.unitPrice.toString(),
      amount: li.amount.toString(),
    })),
  };

  return { filename: `${invoice.invoiceNumber}.pdf`, pdf: await renderInvoicePdf(data) };
}