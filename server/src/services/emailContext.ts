import type { LeadSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { demoUrl } from "./demoBuilder.js";
import { appUrl } from "./emailSender.js";

/**
 * What the drafter is allowed to know about the person being written to.
 *
 * A generic email is worse than no email — it reads as a mail merge, because
 * it is one. Everything here is a fact already in the database: the city the
 * scraper found, the rating on their Google listing, the proposal that went
 * out three weeks ago and was never answered, the invoice that is eleven days
 * overdue. The drafter is told these and told to use only these, which is what
 * keeps a "tailored" email from being a confidently invented one.
 */

/**
 * The finding ids behind the stored audit, for the scenario chooser.
 *
 * Read back out of the stored JSON rather than kept in a column of their own:
 * the audit is already there in full, and a second copy of the same list is a
 * second thing that can disagree with the first. GOOD findings are dropped —
 * "their certificate is fine" is not a reason to write to anybody.
 */
function findingIdsFrom(audit: unknown): string[] {
  const findings = (audit as { findings?: { id?: unknown; severity?: unknown }[] } | null)?.findings;
  if (!Array.isArray(findings)) return [];
  return findings
    .filter((finding) => typeof finding?.id === "string" && finding.severity !== "GOOD")
    .map((finding) => finding.id as string);
}

/**
 * And the ids from the four-reviewer report, which the chooser was already
 * built to accept and was never given.
 *
 * `coldEmailScenarios.ts` lists both vocabularies against every scenario —
 * `cert-untrusted` **and** `sec-cert-untrusted`, `no-spf` **and** `sec-no-spf`
 * — so the audit team's ids were expected here from the day that file was
 * written. Nothing passed them, so a lead whose review found six faults chose
 * its letter's shape from whatever the two quick checks happened to see.
 */
function findingIdsFromReport(report: unknown): string[] {
  const disciplines = (report as { disciplines?: { findings?: { id?: unknown; severity?: unknown }[] }[] } | null)?.disciplines;
  if (!Array.isArray(disciplines)) return [];
  return disciplines.flatMap((discipline) =>
    (Array.isArray(discipline?.findings) ? discipline.findings : [])
      .filter((finding) => typeof finding?.id === "string" && finding.severity !== "GOOD")
      .map((finding) => finding.id as string),
  );
}

export interface RecipientContext {
  kind: "lead" | "client" | "address" | "phone";
  /** Who the email actually goes to. */
  email: string | null;
  /**
   * The number, exactly as it is written on the record — not normalised.
   *
   * Normalising is `lib/phone.ts`'s job and it happens at the point of
   * sending, so what is held here stays the thing a person would recognise
   * if they read the lead. It is null far less often than `email` is, which
   * is the entire reason the phone channels exist.
   */
  phone?: string | null;
  name: string | null;
  /** Rendered for the prompt — plain lines, no JSON, nothing invented. */
  facts: string[];
  /**
   * When somebody last went and looked at this business — researched them,
   * checked their site, photographed their homepage. Null means nobody has,
   * and an email written from a record nobody has looked at can only be
   * generic. See services/leadPrep.ts.
   */
  preparedAt?: string | null;
  /** What the looking could not establish, in plain words. */
  prepNotes?: string[];
  /**
   * The audit finding ids behind `facts`, so the playbook scenario can be
   * chosen in code rather than inferred from prose. See
   * services/coldEmailScenarios.ts.
   */
  findingIds?: string[];
  /** Values available to `{{placeholders}}` in a template. */
  variables: Record<string, string>;
  leadId?: string;
  clientId?: string;
  /**
   * Where this business was found, for the Art 14 notice a first message has to
   * carry. Present only for a lead — a client gave us their details themselves,
   * which is Art 13 and a different obligation with nothing to disclose here.
   *
   * It is on the context rather than re-read at render time because
   * `resolveContext` has already loaded the lead, and a second query for one
   * enum would be a second chance for the two to disagree about which lead this
   * message is to.
   */
  leadSource?: LeadSource;
}

/**
 * The prospect's own domain, and the only place a searching model may read.
 *
 * Cold outreach is routed to a vendor that searches the live web while it
 * answers (`job: "outreach"`), which is what it was chosen for and is also the
 * one thing that could break `EVIDENCE_RULES`: a model that searches can come
 * back with a fault about this business that nobody in this system checked,
 * stated in a letter to the one person who knows whether it is true.
 *
 * Pinning the search to their own domain is what makes the live half safe
 * rather than merely current. Anything read there is the business's own
 * published words, so at worst it confirms what the scan already found — it
 * cannot import a claim from a directory, a review aggregator or a competitor.
 *
 * **One implementation, imported by both drafters.** Written twice it would be
 * one edit away from two different fences, which is the failure this codebase
 * has already had once over `vendorBase`.
 *
 * Undefined where there is no website, or where what is stored is not a URL.
 * The search is then unfenced, which is why the drafters' contracts carry the
 * rule in words as well as in the request.
 */
export function ownDomain(context: RecipientContext): string[] | undefined {
  const website = context.variables.website?.trim();
  if (!website) return undefined;
  try {
    const host = new URL(website.startsWith("http") ? website : `https://${website}`).hostname;
    return host ? [host.replace(/^www\./, "")] : undefined;
  } catch {
    return undefined;
  }
}

function line(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return `${label}: ${value}`;
}

function firstName(full: string | null | undefined): string {
  if (!full) return "there";
  const trimmed = full.trim();
  // A company name in the contact field ("Accra Dental Centre") has no first
  // name to take, and "Hi Accra," reads worse than no name at all.
  if (/\b(ltd|limited|llc|inc|company|centre|center|group|services|enterprise|school|church|foundation)\b/i.test(trimmed)) {
    return "there";
  }
  return trimmed.split(/\s+/)[0];
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

export async function leadContext(leadId: string): Promise<RecipientContext> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      group: { select: { name: true } },
      proposals: { orderBy: { createdAt: "desc" }, take: 3 },
      communications: { orderBy: { occurredAt: "desc" }, take: 5 },
      emails: { where: { status: "SENT" }, orderBy: { sentAt: "desc" }, take: 5, select: { subject: true, sentAt: true } },
      research: true,
      demos: { orderBy: { updatedAt: "desc" }, take: 2 },
      // Only the newest, and only its report — the Markdown and the pictures
      // on that row are megabytes and nothing here reads them.
      websiteAudits: { orderBy: { ranAt: "desc" }, take: 1, select: { report: true } },
    },
  });
  if (!lead) throw new Error("Lead not found");

  const facts = [
    line("Contact name", lead.contactName),
    line("Business", lead.companyName),
    line("Business type", lead.category),
    line("City", [lead.city, lead.region, lead.country].filter(Boolean).join(", ") || null),
    line("Website", lead.website ?? "none found — this is the strongest reason to write to them"),
    line("Google rating", lead.rating ? `${lead.rating} from ${lead.reviewsCount ?? 0} reviews` : null),
    line("How we found them", lead.source.replace(/_/g, " ").toLowerCase()),
    line("Which list", lead.group?.name),
    line("Pipeline status", lead.status),
    line("Lead score (0-100, how reachable and sellable-to)", lead.leadScore),
    line("Estimated deal size", lead.estimatedDealSize ? `GHS ${lead.estimatedDealSize}` : null),
    line("Discovery notes", lead.discoveryNotes),
    line("Discovery call", lead.discoveryCallAt ? `held ${ago(lead.discoveryCallAt)}` : null),
  ].filter((entry): entry is string => entry !== null);

  for (const proposal of lead.proposals) {
    facts.push(
      `Proposal "${proposal.title}" (${proposal.serviceType}, GHS ${proposal.priceAmount}) — ${proposal.status.toLowerCase()}, sent ${ago(proposal.sentAt) ?? "not yet"}`,
    );
  }
  for (const note of lead.communications) {
    facts.push(`Contact ${ago(note.occurredAt)} (${note.type.toLowerCase()}): ${note.summary}${note.outcome ? ` — ${note.outcome}` : ""}`);
  }
  for (const sent of lead.emails) {
    facts.push(`We already emailed them ${ago(sent.sentAt)}: "${sent.subject}"`);
  }
  if (lead.emails.length === 0) facts.push("We have never emailed this person before.");

  // The demo, when one has been built. The link is a fact like any other, and
  // the email that carries it is useless without it — a "go and look at this"
  // with nothing to look at is the worst email in the set.
  if (lead.demos.length) {
    const base = await appUrl();
    for (const demo of lead.demos) {
      const brief = (demo.brief ?? null) as { headline?: string; sections?: string[] } | null;
      facts.push(
        `A demo page has been built for them at ${demoUrl(demo.slug, base)} — ${demo.title}${
          brief?.headline ? `, headlined "${brief.headline}"` : ""
        }${brief?.sections?.length ? `, with sections: ${brief.sections.join(", ")}` : ""}. Status: ${demo.status.toLowerCase()}${
          demo.views > 0 ? `, opened ${demo.views} time${demo.views === 1 ? "" : "s"}` : ", not opened yet"
        }.`,
      );
    }
  }

  // Everything that came from going and looking: what research established,
  // what the audit found on their site and mail domain, and what a model saw
  // in a picture of their homepage. This is the half of the context that makes
  // a specific email possible, and it is deliberately appended last so the
  // record's own facts read first.
  if (lead.research?.facts?.length) {
    facts.push(...lead.research.facts);
  } else {
    facts.push(
      "Nobody has looked at this business yet — no research, no check of their site, no look at their homepage. Keep the email short rather than reaching for something specific that is not here.",
    );
  }

  return {
    kind: "lead",
    preparedAt: lead.research?.ranAt.toISOString() ?? null,
    prepNotes: lead.research?.notes ?? [],
    leadId: lead.id,
    leadSource: lead.source,
    email: lead.contactEmail,
    phone: lead.contactPhone,
    name: lead.contactName,
    facts,
    findingIds: [...new Set([...findingIdsFromReport(lead.websiteAudits[0]?.report), ...findingIdsFrom(lead.research?.audit)])],
    variables: {
      first_name: firstName(lead.contactName),
      contact_name: lead.contactName,
      company: lead.companyName ?? lead.contactName,
      city: lead.city ?? "",
      category: lead.category ?? "business",
      website: lead.website ?? "",
      rating: lead.rating ? String(lead.rating) : "",
    },
  };
}

export async function clientContext(clientId: string): Promise<RecipientContext> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      contacts: { orderBy: { isPrimary: "desc" }, take: 3 },
      projects: { orderBy: { createdAt: "desc" }, take: 5, include: { milestones: { orderBy: { dueDate: "asc" } } } },
      invoices: { orderBy: { issueDate: "desc" }, take: 5 },
      carePlans: { where: { status: "ACTIVE" }, take: 2 },
      emails: { where: { status: "SENT" }, orderBy: { sentAt: "desc" }, take: 5, select: { subject: true, sentAt: true } },
    },
  });
  if (!client) throw new Error("Client not found");

  const primary = client.contacts.find((contact) => contact.isPrimary) ?? client.contacts[0] ?? null;

  const facts = [
    line("Client", client.name),
    line("Company", client.company),
    line("Sector", client.sector),
    line("Main contact", primary ? `${primary.name}${primary.title ? `, ${primary.title}` : ""}` : null),
    line("Client since", ago(client.firstContactAt ?? client.createdAt)),
    line("Lifetime value", `GHS ${client.lifetimeValue}`),
    line("Payment terms", client.creditTerms),
  ].filter((entry): entry is string => entry !== null);

  for (const plan of client.carePlans) {
    facts.push(
      `On a ${plan.tier.replace(/_/g, " ").toLowerCase()} care plan at GHS ${plan.monthlyFee}/month${plan.includedHours ? `, ${plan.includedHours} hours included` : ""}`,
    );
  }
  for (const project of client.projects) {
    const open = project.milestones.filter((milestone) => !milestone.completedAt);
    facts.push(
      `Project "${project.name}" (${project.serviceType}) — ${project.status.toLowerCase()}` +
        (open.length > 0 ? `, next milestone "${open[0].title}"${open[0].dueDate ? ` due ${open[0].dueDate.toDateString()}` : ""}` : ", all milestones complete"),
    );
  }
  for (const invoice of client.invoices) {
    const overdue = invoice.status !== "PAID" && invoice.dueDate < new Date();
    facts.push(
      `Invoice ${invoice.invoiceNumber} for ${invoice.currency} ${invoice.amountTotal} — ${invoice.status.toLowerCase()}` +
        (overdue ? `, OVERDUE since ${invoice.dueDate.toDateString()}` : ""),
    );
  }
  for (const sent of client.emails) {
    facts.push(`We emailed them ${ago(sent.sentAt)}: "${sent.subject}"`);
  }

  return {
    kind: "client",
    clientId: client.id,
    email: primary?.email ?? client.email,
    phone: primary?.phone ?? client.phone,
    name: primary?.name ?? client.name,
    facts,
    variables: {
      first_name: firstName(primary?.name ?? client.name),
      contact_name: primary?.name ?? client.name,
      company: client.company ?? client.name,
      client_name: client.name,
      sector: client.sector ?? "",
    },
  };
}

/** A plain address with no record behind it — nothing to personalise from, and the drafter is told so. */
export function addressContext(email: string, name?: string | null): RecipientContext {
  return {
    kind: "address",
    email,
    name: name ?? null,
    facts: ["We hold no record for this address beyond the name given. Do not invent any detail about them."],
    variables: { first_name: firstName(name), contact_name: name ?? "", company: "" },
  };
}

/**
 * A bare number with no record behind it. The phone-channel twin of
 * `addressContext`, and it exists for the same reason: somebody typing a
 * number into the composer has given the drafter nothing to personalise
 * from, and the drafter has to be told that rather than left to infer it
 * from an empty list.
 */
export function phoneContext(phone: string, name?: string | null): RecipientContext {
  return {
    kind: "phone",
    email: null,
    phone,
    name: name ?? null,
    facts: ["We hold no record for this number beyond the name given. Do not invent any detail about them."],
    variables: { first_name: firstName(name), contact_name: name ?? "", company: "" },
  };
}

export async function resolveContext(args: {
  leadId?: string | null;
  clientId?: string | null;
  toEmail?: string | null;
  toPhone?: string | null;
  toName?: string | null;
}): Promise<RecipientContext> {
  if (args.leadId) return leadContext(args.leadId);
  if (args.clientId) return clientContext(args.clientId);
  if (args.toEmail) return addressContext(args.toEmail, args.toName);
  if (args.toPhone) return phoneContext(args.toPhone, args.toName);
  throw new Error("A message needs a lead, a client, an address, or a number");
}
