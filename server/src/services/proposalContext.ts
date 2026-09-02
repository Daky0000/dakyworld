import { prisma } from "../lib/prisma.js";
import { auditCompany, type AuditSubject, type CompanyAudit } from "./companyAudit.js";
import { TIER_LABEL } from "./carePlanCatalogue.js";

/**
 * Everything the proposal writer is allowed to know about one company.
 *
 * Two sources, deliberately kept apart:
 *
 *  - **The record.** What the scrape and the pipeline already hold — category,
 *    city, rating, the call that happened last week, the proposal that went
 *    unanswered. Facts about the relationship.
 *  - **The audit.** What is true about their setup right now, checked a few
 *    seconds ago. Facts about the problem.
 *
 * The second is what makes a proposal specific rather than plausible. Anything
 * not in either is off-limits: a proposal that guesses at their staff count or
 * their hosting bill is one question away from collapsing, and it will be
 * asked on the call.
 */

export interface ProposalContext {
  kind: "lead" | "client";
  leadId: string | null;
  clientId: string | null;
  companyName: string;
  contactName: string | null;
  contactEmail: string | null;
  /** Relationship facts, one per line, for the prompt. */
  facts: string[];
  audit: CompanyAudit;
  /** True when we have never spoken to them — changes the whole tone of the ask. */
  cold: boolean;
}

function line(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return `${label}: ${value}`;
}

function ago(date: Date | null | undefined): string | null {
  if (!date) return null;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * A handful of fields out of the raw scraper row that a proposal can actually
 * use. The full row is far too long for a prompt and mostly noise — opening
 * hours and a plus code do not sell anything.
 */
function enrichmentFacts(enrichment: unknown): string[] {
  if (!enrichment || typeof enrichment !== "object") return [];
  const row = enrichment as Record<string, unknown>;
  const facts: string[] = [];

  const text = (key: string) => (typeof row[key] === "string" && row[key] ? (row[key] as string) : null);
  const num = (key: string) => (typeof row[key] === "number" ? (row[key] as number) : null);

  const description = text("description");
  if (description) facts.push(`How they describe themselves: ${description.slice(0, 400)}`);

  const categories = Array.isArray(row.categories) ? (row.categories as unknown[]).filter((entry) => typeof entry === "string") : [];
  if (categories.length > 1) facts.push(`Listed under several categories: ${categories.slice(0, 6).join(", ")}`);

  const claimed = row.claimThisBusiness ?? row.isAdvertisement;
  if (claimed === true) facts.push("Their Google listing is unclaimed — nobody at the business controls what it says.");

  const imagesCount = num("imagesCount");
  if (imagesCount != null && imagesCount <= 3) {
    facts.push(`Only ${imagesCount} photo${imagesCount === 1 ? "" : "s"} on their listing, which is what a customer judges them on before anything else.`);
  }

  const hours = row.openingHours;
  if (Array.isArray(hours) && hours.length === 0) facts.push("No opening hours published on their listing.");

  return facts;
}

export async function leadProposalContext(leadId: string): Promise<ProposalContext> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      group: { select: { name: true } },
      scraperSource: { select: { name: true } },
      proposals: { orderBy: { createdAt: "desc" }, take: 3 },
      communications: { orderBy: { occurredAt: "desc" }, take: 6 },
      emails: { where: { status: "SENT" }, orderBy: { sentAt: "desc" }, take: 5, select: { subject: true, sentAt: true } },
    },
  });
  if (!lead) throw new Error("Lead not found");

  const facts = [
    line("Business", lead.companyName ?? lead.contactName),
    line("Contact", lead.contactName),
    line("Business type", lead.category),
    line("Where they are", [lead.city, lead.region, lead.country].filter(Boolean).join(", ") || null),
    line("Website", lead.website ?? "none"),
    line("Phone on file", lead.contactPhone),
    line("Email on file", lead.contactEmail ?? "none"),
    line("Google rating", lead.rating ? `${lead.rating} from ${lead.reviewsCount ?? 0} reviews` : null),
    line("Social profiles", lead.socialLinks ? Object.keys(lead.socialLinks as object).join(", ") : null),
    line("How we found them", `${lead.captureMethod.toLowerCase()}${lead.scraperSource ? ` — ${lead.scraperSource.name}` : ""}`),
    line("Pipeline status", lead.status),
    line("Estimated deal size on file", lead.estimatedDealSize ? `GHS ${lead.estimatedDealSize}` : null),
    line("Notes from discovery", lead.discoveryNotes),
    line("Discovery call", lead.discoveryCallAt ? `held ${ago(lead.discoveryCallAt)}` : "none held"),
  ].filter((entry): entry is string => entry !== null);

  facts.push(...enrichmentFacts(lead.enrichment));

  for (const proposal of lead.proposals) {
    facts.push(
      `Earlier proposal "${proposal.title}" (${proposal.serviceType}, GHS ${proposal.priceAmount}) — ${proposal.status.toLowerCase()}, sent ${ago(proposal.sentAt) ?? "never"}. Do not simply repeat it.`,
    );
  }
  for (const note of lead.communications) {
    facts.push(`Conversation ${ago(note.occurredAt)} (${note.type.toLowerCase()}): ${note.summary}${note.outcome ? ` — ${note.outcome}` : ""}`);
  }
  for (const sent of lead.emails) facts.push(`We emailed them ${ago(sent.sentAt)}: "${sent.subject}"`);

  const cold = lead.communications.length === 0 && lead.emails.length === 0 && !lead.discoveryCallAt;
  if (cold) {
    facts.push(
      "We have never spoken to this business. Nothing about their internal systems, budget, staff or plans is known — only what is observable from outside.",
    );
  }

  const audit = await auditCompany(toAuditSubject(lead));

  return {
    kind: "lead",
    leadId: lead.id,
    clientId: lead.clientId,
    companyName: lead.companyName ?? lead.contactName,
    contactName: lead.contactName,
    contactEmail: lead.contactEmail,
    facts,
    audit,
    cold,
  };
}

function toAuditSubject(lead: {
  companyName: string | null;
  contactName: string;
  website: string | null;
  contactEmail: string | null;
  rating: unknown;
  reviewsCount: number | null;
  socialLinks: unknown;
  category: string | null;
  city: string | null;
}): AuditSubject {
  return {
    companyName: lead.companyName ?? lead.contactName,
    website: lead.website,
    contactEmail: lead.contactEmail,
    // Prisma Decimal — Number() rather than a cast, so a Decimal instance
    // doesn't reach the prompt as "[object Object]".
    rating: lead.rating == null ? null : Number(lead.rating),
    reviewsCount: lead.reviewsCount,
    socialLinks: (lead.socialLinks as Record<string, string> | null) ?? null,
    category: lead.category,
    city: lead.city,
  };
}

export async function clientProposalContext(clientId: string): Promise<ProposalContext> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      contacts: { orderBy: { isPrimary: "desc" }, take: 3 },
      leads: { orderBy: { createdAt: "desc" }, take: 1 },
      projects: { orderBy: { createdAt: "desc" }, take: 5 },
      carePlans: { where: { status: "ACTIVE" }, take: 2 },
      proposals: { orderBy: { createdAt: "desc" }, take: 3 },
      communications: { orderBy: { occurredAt: "desc" }, take: 6 },
    },
  });
  if (!client) throw new Error("Client not found");

  const primary = client.contacts.find((contact) => contact.isPrimary) ?? client.contacts[0] ?? null;
  // A client usually began as a lead, and that lead is where the website and
  // the listing details still live.
  const origin = client.leads[0] ?? null;

  const facts = [
    line("Client", client.name),
    line("Company", client.company),
    line("Sector", client.sector),
    line("Main contact", primary ? `${primary.name}${primary.title ? `, ${primary.title}` : ""}` : null),
    line("Client since", ago(client.firstContactAt ?? client.createdAt)),
    line("What they have spent with us so far", `GHS ${client.lifetimeValue}`),
    line("Payment terms", client.creditTerms),
    line("Website", origin?.website ?? "not on file"),
  ].filter((entry): entry is string => entry !== null);

  for (const plan of client.carePlans) {
    facts.push(`Already on the ${TIER_LABEL[plan.tier]} monthly partnership at GHS ${plan.monthlyFee}/month — this proposal must not sell them what they already pay for.`);
  }
  for (const project of client.projects) {
    facts.push(`Project "${project.name}" (${project.serviceType}) — ${project.status.toLowerCase()}`);
  }
  for (const proposal of client.proposals) {
    facts.push(`Earlier proposal "${proposal.title}" — ${proposal.status.toLowerCase()}, GHS ${proposal.priceAmount}`);
  }
  for (const note of client.communications) {
    facts.push(`Conversation ${ago(note.occurredAt)} (${note.type.toLowerCase()}): ${note.summary}`);
  }

  const audit = await auditCompany({
    companyName: client.company ?? client.name,
    website: origin?.website ?? null,
    contactEmail: client.email ?? primary?.email ?? null,
    rating: origin?.rating == null ? null : Number(origin.rating),
    reviewsCount: origin?.reviewsCount ?? null,
    socialLinks: (origin?.socialLinks as Record<string, string> | null) ?? null,
    category: client.sector,
    city: origin?.city ?? null,
  });

  return {
    kind: "client",
    leadId: origin?.id ?? null,
    clientId: client.id,
    companyName: client.company ?? client.name,
    contactName: primary?.name ?? client.name,
    contactEmail: primary?.email ?? client.email,
    facts,
    audit,
    cold: false,
  };
}

export async function resolveProposalContext(args: { leadId?: string | null; clientId?: string | null }): Promise<ProposalContext> {
  if (args.leadId) return leadProposalContext(args.leadId);
  if (args.clientId) return clientProposalContext(args.clientId);
  throw new Error("A proposal needs a lead or a client to be about");
}
