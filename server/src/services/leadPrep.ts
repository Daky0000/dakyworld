import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { auditCompany, sortFindings, type CompanyAudit } from "./companyAudit.js";
import { lookAtHomepage, lookForPrompt, type HomepageLook } from "./homepageLook.js";
import { researchLead, type FillableField, type LeadResearchResult } from "./leadResearch.js";
import { normaliseSiteUrl, type Screenshot } from "./siteShot.js";

/**
 * Look before you write.
 *
 * The order matters and it is the whole design. Writing to a business you have
 * not looked at produces a mail merge, whatever model writes it — there is
 * nothing in the record to be specific about. So nothing drafts an email to a
 * lead until this has run:
 *
 *   1. **Research.** Who are they, established from live sources, with the
 *      blanks on the record filled in and every value carrying its URL.
 *   2. **Audit.** Their site and their mail domain, checked by fetching and by
 *      asking DNS — the evidence a claim can be made from.
 *   3. **Look.** A screenshot of their homepage, read by a model, for the half
 *      of the argument that markup cannot show.
 *
 * Each stage degrades on its own. No Perplexity key means no research and a
 * note saying so; no Apify token means no screenshot and a note saying so; a
 * lead with no website skips the third stage entirely and gets the strongest
 * argument Dakyworld has instead. What comes out is always usable, and always
 * says what it could not do.
 *
 * The output is stored on `LeadResearch`, one row per lead, so the next draft
 * to the same person costs nothing and so the Owner can read what the email
 * was argued from after it has gone.
 */

/** After this, a look at a business is old enough to be worth taking again. */
export const STALE_AFTER_DAYS = 30;

export interface LeadPrep {
  leadId: string;
  ranAt: string;
  research: LeadResearchResult | null;
  audit: CompanyAudit | null;
  shot: Screenshot | null;
  look: HomepageLook | null;
  /** What was written into the lead record, and where each value came from. */
  filled: Partial<Record<FillableField | "discoveryNotes" | "socialLinks", { value: string; source: string }>>;
  /** Proposed contact details, held back for a person to accept. */
  proposedContact: LeadResearchResult["proposedContact"];
  /** The whole thing as plain lines — this is what the drafter reads. */
  facts: string[];
  /** What could not be checked, in plain words. Never a failure. */
  notes: string[];
  costUsd: number;
}

export interface PrepOptions {
  /** Skip the live-source pass — for a lead whose record is already complete. */
  skipResearch?: boolean;
  /** Skip the screenshot and the model that reads it. */
  skipLook?: boolean;
  /** Write the discovery note even though the lead already has one. */
  replaceDiscoveryNotes?: boolean;
}

/** True when this lead has never been looked at, or was looked at too long ago. */
export function isStale(ranAt: Date | null | undefined, now = new Date()): boolean {
  if (!ranAt) return true;
  return now.getTime() - ranAt.getTime() > STALE_AFTER_DAYS * 86_400_000;
}

export async function prepareLead(leadId: string, options: PrepOptions = {}): Promise<LeadPrep> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error("Lead not found");

  const notes: string[] = [];
  let costUsd = 0;

  // --- 1. Who are they -----------------------------------------------------
  let research: LeadResearchResult | null = null;
  if (!options.skipResearch) {
    try {
      research = await researchLead({
        contactName: lead.contactName,
        companyName: lead.companyName,
        contactEmail: lead.contactEmail,
        contactPhone: lead.contactPhone,
        website: lead.website,
        category: lead.category,
        address: lead.address,
        city: lead.city,
        region: lead.region,
        country: lead.country,
        rating: lead.rating ? Number(lead.rating) : null,
        reviewsCount: lead.reviewsCount,
      });
      costUsd += research.costUsd;
      if (!research.searchedLiveSources) {
        notes.push(
          `${research.researchedBy} answered the research from what it already knows rather than from live sources. Treat everything it filled in as "probably" until a Perplexity key is connected.`,
        );
      }
      notes.push(...research.couldNotFind.map((entry) => `Could not establish: ${entry}`));
    } catch (err) {
      notes.push(`Nothing was researched about them: ${(err as Error).message}`);
    }
  }

  // --- 2. Write what was found into the blanks -----------------------------
  const filled = research ? await applyResearch(lead, research, Boolean(options.replaceDiscoveryNotes)) : {};

  // Re-read only what the fill can have changed, rather than the whole row
  // again — the audit and the look have to run against the filled-in record,
  // not the one that came in.
  const subject = {
    companyName: (filled.companyName?.value ?? lead.companyName) || lead.contactName,
    website: filled.website?.value ?? lead.website,
    contactEmail: lead.contactEmail,
    rating: filled.rating ? Number(filled.rating.value) : lead.rating ? Number(lead.rating) : null,
    reviewsCount: filled.reviewsCount ? Number(filled.reviewsCount.value) : lead.reviewsCount,
    socialLinks: (research && Object.keys(research.socialLinks).length
      ? { ...((lead.socialLinks ?? {}) as Record<string, string>), ...research.socialLinks }
      : ((lead.socialLinks ?? null) as Record<string, string> | null)) as Record<string, string> | null,
    category: filled.category?.value ?? lead.category,
    city: filled.city?.value ?? lead.city,
  };

  // --- 3. What is checkable ------------------------------------------------
  let audit: CompanyAudit | null = null;
  try {
    audit = await auditCompany(subject);
    notes.push(...audit.notes);
  } catch (err) {
    notes.push(`Their site and mail domain could not be checked: ${(err as Error).message}`);
  }

  // --- 4. What it looks like ----------------------------------------------
  let look: HomepageLook | null = null;
  let shot: Screenshot | null = null;
  if (subject.website && !options.skipLook) {
    const looked = await lookAtHomepage({ website: subject.website, companyName: subject.companyName, audit });
    look = looked.look;
    shot = looked.shot;
    costUsd += looked.costUsd;
    notes.push(...looked.notes);
  }

  const facts = buildFacts({ research, audit, look, filled });
  const ranAt = new Date();

  await prisma.leadResearch.upsert({
    where: { leadId },
    create: {
      leadId,
      ranAt,
      filled: filled as unknown as Prisma.InputJsonValue,
      research: (research as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      audit: (audit as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      shot: (shot as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      look: (look as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      facts,
      notes,
      costUsd,
    },
    update: {
      ranAt,
      filled: filled as unknown as Prisma.InputJsonValue,
      research: (research as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      audit: (audit as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      shot: (shot as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      look: (look as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      facts,
      notes,
      costUsd,
    },
  });

  return {
    leadId,
    ranAt: ranAt.toISOString(),
    research,
    audit,
    shot,
    look,
    filled,
    proposedContact: research?.proposedContact ?? null,
    facts,
    notes,
    costUsd,
  };
}

/**
 * Writes research into the lead — and only into its empty fields.
 *
 * A scrape that found the address beats a search that found a different one,
 * every time: the scrape read it off the business's own listing, and the
 * search read it off whatever page ranked. So this only ever fills a blank,
 * which also means running it twice is harmless.
 */
async function applyResearch(
  lead: {
    id: string;
    companyName: string | null;
    category: string | null;
    address: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    website: string | null;
    rating: unknown;
    reviewsCount: number | null;
    socialLinks: unknown;
    discoveryNotes: string | null;
  },
  research: LeadResearchResult,
  replaceDiscoveryNotes: boolean,
): Promise<LeadPrep["filled"]> {
  const filled: LeadPrep["filled"] = {};
  const data: Prisma.LeadUpdateInput = {};

  const isEmpty = (value: unknown) => value === null || value === undefined || value === "";

  const text: FillableField[] = ["companyName", "category", "address", "city", "region", "country", "website"];
  for (const field of text) {
    const found = research.found[field];
    if (!found || !isEmpty(lead[field])) continue;

    // A website is the one text field with a shape, and it decides which
    // argument the email makes: a value here that is not a URL turns "they
    // have no website" — the strongest opening Dakyworld has — into a pitch
    // about a site that does not exist. Anything that does not parse is
    // dropped rather than stored.
    const value = field === "website" ? normaliseSiteUrl(found.value) : found.value;
    if (!value) continue;

    data[field] = value;
    filled[field] = { value, source: found.source };
  }

  // The two numbers, which are only worth taking together: a rating with no
  // review count behind it is a number nobody should quote back to anyone.
  const ratingFound = research.found.rating;
  const reviewsFound = research.found.reviewsCount;
  if (ratingFound && reviewsFound && isEmpty(lead.rating)) {
    const rating = Number(ratingFound.value.replace(/[^\d.]/g, ""));
    const reviews = Number(reviewsFound.value.replace(/[^\d]/g, ""));
    if (Number.isFinite(rating) && rating > 0 && rating <= 5 && Number.isFinite(reviews)) {
      data.rating = rating;
      data.reviewsCount = reviews;
      filled.rating = { value: String(rating), source: ratingFound.source };
      filled.reviewsCount = { value: String(reviews), source: reviewsFound.source };
    }
  }

  // Socials merge rather than replace: a scrape and a search commonly each
  // find one network the other missed.
  if (Object.keys(research.socialLinks).length) {
    const existing = (lead.socialLinks ?? {}) as Record<string, string>;
    const merged = { ...research.socialLinks, ...existing };
    if (Object.keys(merged).length !== Object.keys(existing).length) {
      data.socialLinks = merged;
      filled.socialLinks = { value: Object.keys(merged).join(", "), source: "research" };
    }
  }

  if (research.discoveryNote && (replaceDiscoveryNotes || isEmpty(lead.discoveryNotes))) {
    // Labelled, and labelled in the stored value rather than only in the UI.
    // This field is read by the proposal writer and the email drafter as
    // "notes from discovery", and desk research presented as a conversation is
    // exactly the kind of confident wrong claim that loses a first call.
    const stamped = `Desk research, ${new Date().toISOString().slice(0, 10)} — not a call. ${research.discoveryNote}`;
    data.discoveryNotes = stamped;
    filled.discoveryNotes = { value: stamped, source: research.sources[0]?.url ?? "research" };
  }

  if (Object.keys(data).length > 0) await prisma.lead.update({ where: { id: lead.id }, data });
  return filled;
}

/**
 * The prep as the drafter reads it.
 *
 * Plain lines, each one carrying its own evidence, because the drafter is told
 * it may use only the facts it is given and a fact without a source is one
 * nobody can defend on the call that follows.
 */
function buildFacts(input: {
  research: LeadResearchResult | null;
  audit: CompanyAudit | null;
  look: HomepageLook | null;
  filled: LeadPrep["filled"];
}): string[] {
  const facts: string[] = [];

  if (input.research?.discoveryNote) {
    facts.push(
      `What research found about them (${input.research.researchedBy}${input.research.searchedLiveSources ? ", from live sources" : ", from memory rather than live sources"}): ${input.research.discoveryNote}`,
    );
  }

  if (input.audit) {
    const findings = sortFindings(input.audit.findings);
    for (const finding of findings) {
      facts.push(
        finding.severity === "GOOD"
          ? `Already good, and worth acknowledging: ${finding.observed} (${finding.evidence})`
          : `Checked just now — ${finding.severity.toLowerCase()}: ${finding.observed} (${finding.evidence})`,
      );
    }
    if (input.audit.checked.length) {
      facts.push(
        `What was actually checked: ${input.audit.checked.join("; ")}. Anything not on that list was not looked at, and nothing may be claimed about it.`,
      );
    }
  }

  if (input.look) facts.push(...lookForPrompt(input.look));

  return facts;
}

/** The stored prep, if there is one, without running anything. */
export async function storedPrep(leadId: string) {
  return prisma.leadResearch.findUnique({ where: { leadId } });
}
