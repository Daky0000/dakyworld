import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Invoice numbers are `DAK-AUG-2026-001` — the month, and how many invoices
 * that month has already produced.
 *
 * Counting rows means two invoices raised in the same instant can pick the
 * same number, which the unique index then rejects. That used to be a
 * theoretical race; the care plan scheduler, which can bill every plan due on
 * the 1st in the same tick, makes it a real one. Hence `createNumberedInvoice`,
 * which simply takes the next number and tries again.
 */

export async function nextInvoiceNumber(at = new Date(), skip = 0): Promise<string> {
  const prefix = `DAK-${at.toLocaleString("en-US", { month: "short" }).toUpperCase()}-${at.getFullYear()}`;
  const countThisMonth = await prisma.invoice.count({ where: { invoiceNumber: { startsWith: prefix } } });
  return `${prefix}-${String(countThisMonth + 1 + skip).padStart(3, "0")}`;
}

function isNumberCollision(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    String((err.meta as { target?: string | string[] })?.target ?? "").includes("invoiceNumber")
  );
}

/** Runs `create` with a free invoice number, retrying past a collision. */
export async function createNumberedInvoice<T>(create: (invoiceNumber: string) => Promise<T>, at = new Date()): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await create(await nextInvoiceNumber(at, attempt));
    } catch (err) {
      if (attempt < 5 && isNumberCollision(err)) continue;
      throw err;
    }
  }
}
