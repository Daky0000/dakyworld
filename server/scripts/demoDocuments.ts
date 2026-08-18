/**
 * Renders one of each document the app sends a client, filled with a worked
 * example, so the templates can be looked at rather than reasoned about.
 *
 *   npm run demo:docs           → writes to server/tmp/demo-documents/
 *   npm run demo:docs -- <dir>  → writes somewhere else
 *
 * No database and no API keys: the letterhead falls back to the shipped
 * company details when it can't reach one, which is the whole reason this runs
 * on a laptop with nothing else started.
 *
 * The example is a made-up client. Two invoices are produced on purpose — one
 * part-paid and past its due date, one settled — because the states are where
 * an invoice template usually falls apart, and looking at only the happy one
 * is how a broken "PAID" chip ships.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderInvoicePdf, type InvoicePdfData } from "../src/services/pdf.js";
import { renderContractPdf, type ContractPdfData } from "../src/services/contractPdf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(here, "../tmp/demo-documents"));

/** Dates relative to today, so the demo never goes stale or reads as history. */
const today = new Date();
const daysFromNow = (days: number) => new Date(today.getTime() + days * 86_400_000);

const CLIENT = {
  name: "Abena Mensah",
  company: "Adom Foods Limited",
  addressLines: ["12 Boadi Road, Ayeduase", "Kumasi, Ashanti Region", "Ghana"],
  email: "accounts@adomfoods.com.gh",
  phone: "+233 302 998 114",
};

const payLink = (invoiceNumber: string) => `pay.dakyworld.com/${invoiceNumber}`;

const PAYMENT = {
  bankName: "Absa Bank Ghana",
  accountName: "Dakyworld Limited",
  accountNumber: "003 512 004 9871",
  branch: "Adum, Kumasi",
  swift: "BARBGHAC",
  momoNetwork: "MTN MoMo",
  momoNumber: "+233 545 950 611",
  momoName: "Dakyworld",
};

// --- Invoice one: a build, part-paid and now overdue ------------------------

const overdueInvoice: InvoicePdfData = {
  invoiceNumber: "DW-2026-0142",
  clientName: CLIENT.name,
  clientCompany: CLIENT.company,
  clientAddressLines: CLIENT.addressLines,
  clientEmail: CLIENT.email,
  clientPhone: CLIENT.phone,
  clientReference: "PO-4471",
  currency: "GHS",
  issueDate: daysFromNow(-27),
  dueDate: daysFromNow(-6),
  status: "OVERDUE",
  reference: "Website rebuild — phase 2",
  paymentTerms: "Net 21 days",
  lineItems: [
    {
      description: "Website rebuild — design and build",
      detail: "14 pages, mobile-first, CMS handover included",
      quantity: "1",
      unitPrice: "35000",
      amount: "35000",
    },
    {
      description: "Product catalogue migration",
      detail: "412 SKUs moved from the old site, with images re-cut",
      quantity: "1",
      unitPrice: "6500",
      amount: "6500",
    },
    {
      description: "Staff training",
      detail: "Two sessions, recorded, for the marketing team",
      quantity: "2",
      unitPrice: "1200",
      amount: "2400",
    },
    {
      description: "Hosting and domain, first year",
      detail: "Recharged at cost — renews 14 September 2027",
      quantity: "1",
      unitPrice: "1800",
      amount: "1800",
    },
  ],
  subtotal: "45700",
  discount: { label: "Care plan client discount (5%)", amount: "2285" },
  tax: { label: "VAT and levies (21.9%)", amount: "9506.27" },
  amountTotal: "52921.27",
  amountPaid: "17500",
  balanceDue: "35421.27",
  payment: { ...PAYMENT, payLink: payLink("DW-2026-0142") },
  notes:
    "Phase 2 was accepted on 28 July 2026 and the site went live the same week. The deposit of GHS 17,500 received on 3 July has been applied above.",
  termsNote:
    "Payable within 21 days of the issue date. After 14 days overdue, interest accrues at 2% per month and support may be paused until the account is settled. Registered in Ghana. Please quote the invoice number on any transfer.",
};

// --- Invoice two: a monthly care plan, settled ------------------------------

const paidInvoice: InvoicePdfData = {
  invoiceNumber: "DW-2026-0151",
  clientName: CLIENT.name,
  clientCompany: CLIENT.company,
  clientAddressLines: CLIENT.addressLines,
  clientEmail: CLIENT.email,
  currency: "GHS",
  issueDate: daysFromNow(-12),
  dueDate: daysFromNow(2),
  paidDate: daysFromNow(-4),
  status: "PAID",
  reference: "Care plan — Growth, September 2026",
  paymentTerms: "Net 14 days",
  lineItems: [
    {
      description: "Growth care plan",
      detail: "1 September – 30 September 2026",
      quantity: "1",
      unitPrice: "12500",
      amount: "12500",
    },
    {
      description: "Additional support hours",
      detail: "Stock-sync incident, 4 and 5 September",
      quantity: "3.5",
      unitPrice: "450",
      amount: "1575",
    },
  ],
  subtotal: "14075",
  tax: { label: "VAT and levies (21.9%)", amount: "3082.43" },
  amountTotal: "17157.43",
  amountPaid: "17157.43",
  balanceDue: "0",
  payment: { ...PAYMENT, payLink: payLink("DW-2026-0151") },
  notes: "Received with thanks by bank transfer on 8 September 2026. Nothing further is due on this invoice.",
  termsNote: "This invoice is settled in full and is issued as your receipt.",
};

// --- The agreement behind both ---------------------------------------------

const contract: ContractPdfData = {
  title: "Website rebuild and Growth care plan",
  reference: "DW-MSA-2026-014",
  agreementDate: daysFromNow(-96),
  startDate: daysFromNow(-89),
  term: "12 months from the start date",
  noticePeriod: "30 days",
  client: {
    legalName: "Adom Foods Limited",
    shortName: "The Client",
    registrationNumber: "CS-2019-0448127",
    addressLines: CLIENT.addressLines,
    email: CLIENT.email,
    phone: CLIENT.phone,
    signatory: { name: "Abena Mensah", title: "Managing Director" },
  },
  currency: "GHS",
  deliverables: [
    "A new website of up to fourteen pages: information architecture, design, build, and content structure, working on phones, tablets and desktop.",
    "Migration of the existing product catalogue — up to 450 items — with images re-cut to the new layout.",
    "Hosting set-up, domain configuration, SSL, and a backup routine that runs daily with a 30-day retention.",
    "Business email on Google Workspace for up to twelve users, migrated from the current provider with no loss of mail.",
    "Two recorded training sessions for the marketing team, plus a written handover of every account and credential.",
    "From go-live, the Growth care plan: monitoring, security patching, backups, up to eight hours of changes each month, and a four-hour response on priority-one incidents during business hours.",
  ],
  exclusions: [
    "Paid advertising, ad spend, and social media management.",
    "Writing product copy or commissioning photography, beyond arranging what is supplied.",
    "Hardware, printers, office networking, and any on-site attendance — the services are delivered remotely.",
    "Third-party licence and subscription fees, which are recharged at cost.",
    "Custom software beyond the website itself, including mobile applications and integrations not named in this schedule.",
  ],
  fees: [
    {
      description: "Website rebuild",
      detail: "Design, build, migration and handover, as set out in Schedule 1",
      amount: "35000",
      billing: "ONE_OFF",
    },
    {
      description: "Product catalogue migration",
      detail: "Up to 450 items",
      amount: "6500",
      billing: "ONE_OFF",
    },
    {
      description: "Google Workspace migration and set-up",
      detail: "Twelve users. Licence fees are recharged at cost.",
      amount: "4200",
      billing: "ONE_OFF",
    },
    {
      description: "Growth care plan",
      detail: "Monthly, beginning the month after go-live",
      amount: "12500",
      billing: "MONTHLY",
    },
  ],
  paymentSchedule: [
    { trigger: "On signature of this agreement", share: "40%", amount: "18280" },
    { trigger: "On sign-off of the approved design", share: "30%", amount: "13710" },
    { trigger: "On go-live and handover", share: "30%", amount: "13710" },
    { trigger: "Care plan, monthly in advance", share: "—", amount: "12500" },
  ],
  paymentTerms: "Invoices are payable within 21 days of the issue date. Care plan invoices are issued on the first of each month.",
  specialConditions: [
    "Work outside the eight monthly care-plan hours is charged at GHS 450 per hour, agreed in writing before it starts.",
    "The Client's marketing team retains publishing access to the CMS after handover; changes they make are outside the warranty in clause 10.",
    "The Provider will not be named alongside a competitor of the Client in any case study without written consent.",
  ],
};

// --- Render -----------------------------------------------------------------

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const documents: [string, Promise<Buffer>][] = [
    ["invoice-overdue.pdf", renderInvoicePdf(overdueInvoice)],
    ["invoice-paid.pdf", renderInvoicePdf(paidInvoice)],
    ["service-agreement.pdf", renderContractPdf(contract)],
  ];

  for (const [name, pending] of documents) {
    const buffer = await pending;
    const target = path.join(outDir, name);
    fs.writeFileSync(target, buffer);
    console.log(`${name.padEnd(24)} ${(buffer.length / 1024).toFixed(0)} KB  ${target}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
