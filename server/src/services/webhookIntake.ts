import type { LeadSource, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { SETTING, getSetting } from "../lib/settings.js";
import { buildDedupeKey, cleanWebsite, scoreLead, type NormalizedLead } from "./leadMapping.js";
import { enrolNewLeads } from "./emailSequences.js";
import { registerTags } from "./leadTags.js";
import { looksAutomated } from "./botCheck.js";

/**
 * What to do with an event somebody else sent us.
 *
 * One handler exists today and it is the one that pays for itself: a contact
 * form on dakyworld.com posting here creates a lead, in the pipeline, scored,
 * de-duplicated against everything the scrapers have already found — instead
 * of an email in an inbox that somebody retypes on Monday.
 *
 * Everything else is recorded and left alone. That is deliberate: an event
 * this app doesn't understand is not a failure, it is a payload waiting for a
 * handler, and `WebhookEvent` keeps it so the handler can be written against
 * the real thing rather than against a guess.
 */

export interface IntakeResult {
  handled: boolean;
  /** What it produced, for the event record. */
  result: Record<string, unknown> | null;
  /** Why nothing happened, when nothing did. */
  note: string | null;
}

/** Where a webhook-created lead is filed. Configurable; OTHER suits a website form. */
async function webhookLeadSource(): Promise<LeadSource> {
  const configured = (await getSetting(SETTING.WEBHOOK_LEAD_SOURCE))?.trim().toUpperCase();
  const allowed: LeadSource[] = ["REFERRAL", "COLD_EMAIL", "OUTREACH", "CONTENT", "WARM_NETWORK", "DIRECTORY", "SOCIAL", "OTHER"];
  return (allowed as string[]).includes(configured ?? "") ? (configured as LeadSource) : "OTHER";
}

const str = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 2000) : null;
};

/** Reads the field whatever the sender decided to call it. */
function pick(payload: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const found = Object.entries(payload).find(([key]) => key.toLowerCase() === name.toLowerCase());
    const value = str(found?.[1]);
    if (value) return value;
  }
  return null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Turns a form post into a lead. Deliberately forgiving about field names —
 * a website form, a Typeform and a Zap all name the same five fields
 * differently, and rejecting one because it said `full_name` rather than
 * `name` would lose a real enquiry.
 */
export async function intakeFormLead(payload: Record<string, unknown>): Promise<IntakeResult> {
  // This is the one endpoint an anonymous caller can write to, so it is the one
  // that needs to tell a person from a script. Flagged posts are still recorded
  // as WebhookEvents — see services/botCheck.ts for why nothing is deleted.
  const bot = looksAutomated(payload);
  if (bot.reason) return { handled: false, result: null, note: `Not created: ${bot.reason}` };

  const name = pick(payload, ["name", "fullName", "full_name", "contactName", "firstName"]);
  const email = pick(payload, ["email", "emailAddress", "email_address", "contactEmail"])?.toLowerCase() ?? null;
  const phone = pick(payload, ["phone", "phoneNumber", "phone_number", "tel", "mobile"]);
  const company = pick(payload, ["company", "companyName", "organisation", "organization", "business"]);
  const website = cleanWebsite(pick(payload, ["website", "url", "site", "domain"]));
  const message = pick(payload, ["message", "notes", "enquiry", "inquiry", "details", "comments", "how_can_we_help"]);
  const service = pick(payload, ["service", "interestedIn", "subject", "plan", "topic"]);

  // Somebody with no name and no way to reach them isn't an enquiry.
  if (!name && !email && !phone) {
    return { handled: false, result: null, note: "No name, email or phone in that payload, so there was nobody to create." };
  }
  if (email && !EMAIL_PATTERN.test(email)) {
    return { handled: false, result: null, note: `“${email}” isn't a valid email address.` };
  }

  const lead: NormalizedLead = {
    contactName: name ?? company ?? email ?? phone ?? "Website enquiry",
    companyName: company ?? name ?? null,
    contactEmail: email,
    contactPhone: phone,
    website,
    address: null,
    city: pick(payload, ["city", "town", "location"]),
    region: null,
    country: pick(payload, ["country"]),
    category: service,
    rating: null,
    reviewsCount: null,
    latitude: null,
    longitude: null,
    socialLinks: null,
    externalId: null,
    // Somebody who filled in a form told you why they were there. It belongs
    // on the record, not in the raw payload nobody opens.
    discoveryNotes: [service ? `Interested in: ${service}` : null, message].filter(Boolean).join("\n\n") || null,
    tags: ["inbound", ...(service ? [service.toLowerCase().slice(0, 40)] : [])],
    closed: false,
    externalKey: email ? `email:${email}` : null,
  };

  const dedupeKey = buildDedupeKey(lead);
  const score = scoreLead(lead);
  const source = await webhookLeadSource();

  const base = {
    contactName: lead.contactName,
    contactEmail: lead.contactEmail,
    contactPhone: lead.contactPhone,
    companyName: lead.companyName,
    website: lead.website,
    city: lead.city,
    country: lead.country,
    category: lead.category,
    discoveryNotes: lead.discoveryNotes,
    tags: await registerTags(lead.tags),
    source,
    captureMethod: "API" as const,
    // An inbound enquiry is worth more than anything a scraper found: they
    // came to us. Straight past NEW into the stage somebody works.
    status: "QUALIFYING" as const,
    leadScore: Math.max(score, 60),
    enrichment: payload as Prisma.InputJsonValue,
  };

  const existing = dedupeKey ? await prisma.lead.findUnique({ where: { dedupeKey } }) : null;

  if (existing) {
    // Somebody already in the pipeline getting in touch is news. Fill the
    // blanks, add what they said, and never downgrade where they had got to.
    const updated = await prisma.lead.update({
      where: { id: existing.id },
      data: {
        contactEmail: existing.contactEmail ?? lead.contactEmail,
        contactPhone: existing.contactPhone ?? lead.contactPhone,
        companyName: existing.companyName ?? lead.companyName,
        website: existing.website ?? lead.website,
        city: existing.city ?? lead.city,
        discoveryNotes: [existing.discoveryNotes, lead.discoveryNotes].filter(Boolean).join("\n\n---\n\n") || null,
        tags: Array.from(new Set([...existing.tags, ...(await registerTags(lead.tags))])),
        leadScore: Math.max(existing.leadScore, base.leadScore),
        status: existing.status === "NEW" ? "QUALIFYING" : existing.status,
      },
    });
    return {
      handled: true,
      result: { leadId: updated.id, created: false, note: "Matched an existing lead and added the enquiry to it." },
      note: null,
    };
  }

  const created = await prisma.lead.create({ data: { ...base, dedupeKey } });
  // Whatever sequence watches for new leads should see this one too.
  await enrolNewLeads([created.id]).catch((err) => console.error("[webhooks] could not enrol the new lead:", (err as Error).message));

  return { handled: true, result: { leadId: created.id, created: true, score: base.leadScore }, note: null };
}

/** Which source names have a handler behind them. */
export const HANDLED_SOURCES = ["website-form", "contact-form", "lead"] as const;

export async function handleEvent(source: string, payload: Record<string, unknown>): Promise<IntakeResult> {
  if ((HANDLED_SOURCES as readonly string[]).includes(source)) return intakeFormLead(payload);
  return {
    handled: false,
    result: null,
    note: `Nothing is set up to act on “${source}” events yet — the payload has been kept so a handler can be written against it.`,
  };
}
