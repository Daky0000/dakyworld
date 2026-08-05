import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const owner = await prisma.user.upsert({
    where: { email: "dan@dakyworld.local" },
    update: {},
    create: { email: "dan@dakyworld.local", name: "Dan Kwame Ayipah (dev)", role: "OWNER" },
  });

  const client = await prisma.client.upsert({
    where: { id: "seed-client-searchpath" },
    update: {},
    create: {
      id: "seed-client-searchpath",
      name: "SearchPathArabia",
      email: "ops@searchpatharabia.example",
      sector: "Recruitment Platform",
      firstContactAt: new Date("2025-01-10"),
      lifetimeValue: 150000,
    },
  });

  const lead = await prisma.lead.create({
    data: {
      contactName: "Ama Boateng",
      contactEmail: "ama@kessben.example",
      companyName: "Kessben Retail Group",
      source: "LINKEDIN",
      status: "QUALIFIED",
      leadScore: 72,
      discoveryNotes: "Mobile checkout underperforming, wants a rebuild + WhatsApp automation.",
      estimatedDealSize: 22000,
    },
  });

  const proposal = await prisma.proposal.create({
    data: {
      leadId: lead.id,
      title: "Website Optimization & Checkout Automation",
      serviceType: "Website Rebuild",
      scopeSummary: "Mobile UX audit, checkout rebuild, WhatsApp order-confirmation automation.",
      priceAmount: 22000,
      priceTier: "Project",
      status: "SENT",
      sentAt: new Date(),
    },
  });

  const project = await prisma.project.create({
    data: {
      clientId: client.id,
      name: "Security Breach Remediation",
      serviceType: "Security & Breach Remediation",
      scopeSummary: "Remediate live admin-account breach, harden against recurrence.",
      status: "DELIVERED",
      startDate: new Date("2025-02-01"),
      endDate: new Date("2025-02-03"),
      budgetAmount: 15000,
      assignments: { create: { userId: owner.id } },
      milestones: {
        create: [
          { title: "Breach contained", dueDate: new Date("2025-02-02"), completedAt: new Date("2025-02-02") },
          { title: "Site fully restored", dueDate: new Date("2025-02-03"), completedAt: new Date("2025-02-03") },
        ],
      },
    },
  });

  const carePlan = await prisma.carePlan.create({
    data: {
      clientId: client.id,
      tier: "GROWTH",
      monthlyFee: 12500,
      includedHours: 12,
      status: "ACTIVE",
    },
  });

  await prisma.invoice.create({
    data: {
      clientId: client.id,
      projectId: project.id,
      invoiceNumber: "DAK-JAN-2026-001",
      amountTotal: 15000,
      status: "PAID",
      dueDate: new Date("2025-02-15"),
      paidAt: new Date("2025-02-10"),
      lineItems: { create: [{ description: "Security Breach Remediation — final payment", quantity: 1, unitPrice: 15000, amount: 15000 }] },
    },
  });

  console.log("Seed complete:", { owner: owner.email, client: client.name, lead: lead.contactName, proposal: proposal.title, project: project.name, carePlan: carePlan.tier });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
