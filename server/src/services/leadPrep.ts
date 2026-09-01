import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { auditCompany, auditTags, headlineFinding, sortFindings, type CompanyAudit } from "./companyAudit.js";
import { registerTags } from "./leadTags.js";
import { scoreLead, type NormalizedLead } from "./leadMapping.js";
import { lookAtHomepage, lookForPrompt, type HomepageLook } from "./homepageLook.js";
import { researchLead, type FillableField, type LeadResearchResult } from "./leadResearch.js";
import { MAX_BATCH, captureHomepages, normaliseSiteUrl, type Screenshot, type ShotResult } from "./siteShot.js";
import { runWebsiteAudit } from "./audit/team.js";

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
  filled: Partial<
    Record<
      FillableField | "discoveryNotes" | "socialLinks" | "contactEmail" | "contactPhone" | "tags" | "leadScore",
      { value: string; source: string }
    >
  >;
  /** Proposed contact details, held back for a person to accept. */
  proposedContact: LeadResearchResult["proposedContact"];
  /** The whole thing as plain lines — this is what the drafter reads. */
  facts: string[];
  /** What could not be checked, in plain words. Never a failure. */
  notes: string[];
  /** Whether there is anything here worth writing to them about. */
  strength: CaseStrength;
  /**
   * The CRITICAL and HIGH faults, in the order they were found.
   *
   * More than one of these changes the letter: it names one and the rest are
   * attached as the report. See `redFlags()` below.
   */
  redFlags: { say: string; severity: string; kind: "seen" | "checked" }[];
  /**
   * True when this business has no website, so the demo page is the argument
   * rather than an optional extra. See `demoIsTheArgument()`.
   */
  needsDemo: boolean;
  /**
   * The website audit team's run, when one was asked for.
   *
   * Deliberately a summary rather than the report: the report is a row of its
   * own with its own PDF and Markdown, and inlining it here would put a
   * hundred kilobytes of findings into every response that mentions a lead.
   */
  websiteAudit: { auditId: string; overallScore: number; verdict: string; pdfFileId: string | null; markdownFileId: string | null } | null;
  costUsd: number;
}

export interface PrepOptions {
  /** Skip the live-source pass — for a lead whose record is already complete. */
  skipResearch?: boolean;
  /** Skip the screenshot and the model that reads it. */
  skipLook?: boolean;
  /** Write the discovery note even though the lead already has one. */
  replaceDiscoveryNotes?: boolean;
  /**
   * A screenshot already taken for this website, from a batched run. Used only
   * when the address still matches — research can fill in a website that was
   * blank, and a picture of the old one would then be a picture of nothing.
   */
  captured?: { website: string; result: ShotResult } | null;
  /**
   * Run the four-reviewer website audit afterwards and produce the report.
   *
   * Off for a batch and on for the button, because it is the slow, thorough
   * half: two more model calls, a second Apify run for the phone view, and a
   * rendered PDF at the end. Sixty leads prepared overnight want the scan; one
   * lead somebody is about to write to wants the report.
   *
   * The scan's own work is handed over rather than repeated — the DNS audit
   * and the desktop screenshot are both already in hand by the time this runs.
   *
   * **It also runs itself when the scan found more than one red flag**, and
   * that is not a convenience. A letter that names one fault and says several
   * others were found has to be able to hand the rest over, or it is a stranger
   * saying "there are other problems with your business" and offering nothing —
   * which is worse than saying nothing at all. The report is what makes that
   * sentence honest, so it is produced by the same pass that discovers there is
   * more than one thing to say. Pass `false` to refuse it outright.
   */
  withAuditTeam?: boolean;
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
  //
  // Photographed at the address that *answered*, not the one on the record.
  // Those differ more often than they should: a lead holding `ghacem.com`
  // whose DNS only knows `www.ghacem.com` had its screenshot taken of the dead
  // hostname, so the look never ran, so the only material left was the
  // technical check — and the letter that went out was about a DNS record. The
  // audit had already found the working address one step earlier; nothing used
  // it.
  const liveUrl = audit?.site?.reachable ? (audit.site.finalUrl ?? subject.website) : subject.website;

  let look: HomepageLook | null = null;
  let shot: Screenshot | null = null;
  let desktopShot: ShotResult | null = null;
  if (liveUrl && !options.skipLook) {
    // A batched picture is reused only when it was taken of this same address
    // *and* it worked. A failed shot of the address on file tells us nothing
    // about the one that answers.
    const alreadyTaken =
      options.captured && options.captured.website === liveUrl && options.captured.result.shot ? options.captured.result : null;
    const looked = await lookAtHomepage({
      captured: alreadyTaken,
      website: liveUrl,
      companyName: subject.companyName,
      trade: subject.category,
      town: subject.city,
      rating: subject.rating,
      reviewsCount: subject.reviewsCount,
      audit,
    });
    look = looked.look;
    shot = looked.shot;
    desktopShot = looked.captured;
    costUsd += looked.costUsd;
    notes.push(...looked.notes);
    if (liveUrl !== subject.website) {
      notes.push(`The address on the record (${subject.website}) does not answer, so the page was read at ${liveUrl} instead.`);
    }
  }

  // Everything above was a claim about them; everything the audit and the look
  // produced was observed. The observed half writes last so it can see what
  // research already filled and not fight it.
  Object.assign(filled, await applyObserved(lead, audit, look, filled));

  // The one case where overwriting a stored value is a correction rather than
  // a loss: the address on file provably does not resolve and another form of
  // it provably does. Leaving the dead one there means every future scan, demo
  // and click starts from an address that goes nowhere. The fault itself is
  // not lost — it is a finding, a tag, and a line in the audit.
  const corrected = correctedHost(subject.website, audit?.site?.finalUrl ?? null);
  if (corrected) {
    await prisma.lead.update({ where: { id: leadId }, data: { website: corrected } });
    filled.website = { value: corrected, source: `${subject.website} does not resolve; this host answers` };
  }

  const strength = caseStrength(audit, look);
  const flags = redFlags(audit, look);
  const needsDemo = demoIsTheArgument({ website: subject.website, audit });
  if (subject.website && !look) {
    notes.push(
      "Nobody has seen how their site actually looks — only what it is made of. The design, the layout and the first impression are the half a business owner cares about, and none of it was checked.",
    );
  }
  const facts = buildFacts({ research, audit, look, filled, strength, hasWebsite: Boolean(subject.website), redFlags: flags });

  // --- 5. The audit team, when it was asked for ----------------------------
  //
  // Deliberately last, and deliberately after `facts` is built. The scan
  // decides what the *letter* argues, and it has always done that on its own;
  // the audit team produces the *report*, which is a different document for a
  // different reader. Running it here rather than folding it into the stages
  // above means nothing about the email pipeline changes when this is off.
  //
  // Two things are handed over rather than redone: the DNS audit, which asked
  // the same questions of the same domain a minute ago, and the desktop
  // screenshot, which cost an Apify container boot. The phone view is the only
  // new picture.
  let websiteAudit: LeadPrep["websiteAudit"] = null;
  // Asked for, or earned by the findings: more than one red flag means the
  // letter will name one and attach the rest, and there is nothing to attach
  // without this. `withAuditTeam: false` still refuses — a caller that has
  // said no is not overruled by arithmetic.
  const auditTeamWanted = options.withAuditTeam ?? flags.length > 1;
  if (auditTeamWanted) {
    // The address that answered, in preference to the one on file. `corrected`
    // is only ever a hostname swap, so it is the fallback rather than the
    // first choice — `liveUrl` is already where the page actually came from.
    const auditUrl = liveUrl ?? corrected;
    if (!auditUrl) {
      notes.push("The audit team was not run: there is no website to review. For a business with no site at all, that absence is the whole argument and there is nothing to audit.");
    } else {
      try {
        const run = await runWebsiteAudit(
          {
            leadId,
            businessName: subject.companyName,
            website: auditUrl,
            trade: look?.states?.trade ?? subject.category,
            town: look?.states?.town ?? subject.city,
          },
          { companyAudit: audit, desktopShot },
        );
        websiteAudit = {
          auditId: run.auditId,
          overallScore: run.report.overallScore,
          verdict: run.report.verdict,
          pdfFileId: run.pdfFileId,
          markdownFileId: run.markdownFileId,
        };
        costUsd += run.report.costUsd;
        notes.push(...run.report.notes.filter((note) => !notes.includes(note)));
        if (options.withAuditTeam === undefined) {
          notes.push(
            `The full review was run because ${flags.length} serious faults were found: the letter names one and the report carries the rest.`,
          );
        }
      } catch (err) {
        // The scan is what the email is written from. Losing it because the
        // report could not be produced would cost the useful half to save the
        // thorough one.
        notes.push(`The audit team did not finish: ${(err as Error).message} The scan above is unaffected.`);
      }
    }
  }

  // Said last, and said only once the report either exists or provably does
  // not. A drafter told "the rest are attached" on a lead whose report failed
  // to render writes a letter referring to an attachment that is not there,
  // which is the one mistake here a prospect definitely notices.
  if (flags.length > 1) {
    facts.push(
      websiteAudit?.pdfFileId
        ? `MORE THAN ONE RED FLAG — ${flags.length} serious faults were found, and the full report is attached to this email as a PDF. Name ONLY the strongest one in the letter. Then say, in one sentence and in your own words, that a few other things came up while looking and that they are in the attached report. Do not list them, do not summarise them, and do not count them out. The other faults, for your information only: ${flags
            .slice(1)
            .map((flag) => flag.say)
            .join("; ")}`
        : `MORE THAN ONE RED FLAG — ${flags.length} serious faults were found, but no report could be produced this time, so there is nothing to attach. Write about the strongest one only and do not refer to a report or an attachment. The others, for your information only: ${flags
            .slice(1)
            .map((flag) => flag.say)
            .join("; ")}`,
    );
  }

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
    strength,
    redFlags: flags,
    needsDemo,
    websiteAudit,
    costUsd,
  };
}

/**
 * Preparing a list of leads, with the screenshots batched.
 *
 * Almost the entire cost of looking at a business is the Apify run booting a
 * container and a browser, and that boot is identical whether the run shoots
 * one page or twenty. Sixty freshly captured leads prepared one at a time is
 * sixty boots: half an hour of waiting and sixty times the compute, for the
 * same sixty pictures three runs would have taken.
 *
 * So the pictures are taken first, in groups, and handed to each lead's own
 * preparation. Leads whose website only turns up *during* research fall back
 * to a run of their own — rarer, and correctness beats the saving.
 */
export interface BatchPrepResult {
  prepared: LeadPrep[];
  failed: { leadId: string; error: string }[];
  /** How many Apify runs it took, against how many pages were shot. */
  screenshotRuns: number;
  screenshotsTaken: number;
  costUsd: number;
}

export async function prepareLeads(leadIds: string[], options: PrepOptions = {}): Promise<BatchPrepResult> {
  const unique = [...new Set(leadIds)];
  const leads = await prisma.lead.findMany({ where: { id: { in: unique } }, select: { id: true, website: true } });
  const byId = new Map(leads.map((lead) => [lead.id, lead]));

  // 1. Every picture we can predict the need for, in as few runs as possible.
  const shots = new Map<string, { website: string; result: ShotResult }>();
  let screenshotRuns = 0;
  let screenshotsTaken = 0;

  if (!options.skipLook) {
    const withSites = leads.filter((lead): lead is { id: string; website: string } => Boolean(lead.website));
    for (let at = 0; at < withSites.length; at += MAX_BATCH) {
      const chunk = withSites.slice(at, at + MAX_BATCH);
      const captured = await captureHomepages(chunk.map((lead) => lead.website));
      screenshotRuns += 1;
      for (const lead of chunk) {
        const result = captured.get(lead.website);
        if (!result) continue;
        if (result.shot) screenshotsTaken += 1;
        shots.set(lead.id, { website: lead.website, result });
      }
    }
  }

  // 2. Then each lead's own work, which is per-lead however it is scheduled.
  const prepared: LeadPrep[] = [];
  const failed: { leadId: string; error: string }[] = [];
  let costUsd = 0;

  for (const leadId of unique) {
    if (!byId.has(leadId)) {
      failed.push({ leadId, error: "Lead not found" });
      continue;
    }
    try {
      const prep = await prepareLead(leadId, {
        // A batch never runs the four-reviewer report on its own. One lead
        // somebody is about to write to earns it when the faults pile up;
        // sixty leads prepared overnight would be sixty reports, two model
        // calls and an Apify run each, that nobody asked for. Explicitly
        // asking still works.
        ...options,
        withAuditTeam: options.withAuditTeam ?? false,
        captured: shots.get(leadId) ?? null,
      });
      prepared.push(prep);
      costUsd += prep.costUsd;
    } catch (err) {
      // One bad lead must not lose the run everybody else has already paid for.
      failed.push({ leadId, error: (err as Error).message });
    }
  }

  return { prepared, failed, screenshotRuns, screenshotsTaken, costUsd };
}

/**
 * The address on file with only its hostname corrected.
 *
 * Not the URL the browser finally landed on: `ghacem.com` answers at
 * `www.ghacem.com`, which redirects again to `/en`, and storing that would put
 * a language-specific landing page in the field where the site belongs. The
 * broken part was the host, so the host is the only part replaced.
 *
 * Null when nothing needs correcting, which is the normal case.
 */
function correctedHost(stored: string | null, answered: string | null): string | null {
  if (!stored || !answered) return null;
  try {
    const was = new URL(stored);
    const now = new URL(answered);
    if (was.hostname === now.hostname) return null;
    was.hostname = now.hostname;
    return was.toString();
  } catch {
    return null;
  }
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
 * What the *looking* found, written onto the record.
 *
 * `applyResearch` above writes what a search claimed. This writes what was
 * observed: a trade printed on their own homepage, a town named on it, an
 * address in their own footer, the profiles they link to themselves. That is
 * a stronger class of evidence than a search result, and it is the half that
 * closes the em-dashes against Category and Location on a scraped lead.
 *
 * The contact rule differs here for a reason worth stating. A researched
 * address is held back because a search can attach the wrong company to a
 * name. An address printed on the homepage of the site we just fetched cannot
 * be somebody else's — the worst case is that it is a stale one for the right
 * business. So a published address is written when the lead has none, and
 * never over one that is already there.
 */
async function applyObserved(
  lead: {
    id: string;
    category: string | null;
    city: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    socialLinks: unknown;
    tags: string[];
    leadScore: number;
    contactName: string;
    companyName: string | null;
    website: string | null;
    address: string | null;
    region: string | null;
    country: string | null;
    rating: unknown;
    reviewsCount: number | null;
  },
  audit: CompanyAudit | null,
  look: HomepageLook | null,
  alreadyFilled: LeadPrep["filled"],
): Promise<LeadPrep["filled"]> {
  const filled: LeadPrep["filled"] = {};
  const data: Prisma.LeadUpdateInput = {};
  const isEmpty = (value: unknown) => value === null || value === undefined || value === "";

  const site = audit?.site?.finalUrl ?? audit?.site?.requested ?? "their homepage";

  // --- What the page states about itself ---------------------------------
  if (look?.states.trade && isEmpty(lead.category) && !alreadyFilled.category) {
    data.category = look.states.trade;
    filled.category = { value: look.states.trade, source: site };
  }
  if (look?.states.town && isEmpty(lead.city) && !alreadyFilled.city) {
    data.city = look.states.town;
    filled.city = { value: look.states.town, source: site };
  }

  // --- Contact details they published themselves --------------------------
  const publishedEmail = audit?.published?.emails[0] ?? null;
  if (publishedEmail && isEmpty(lead.contactEmail)) {
    data.contactEmail = publishedEmail;
    filled.contactEmail = { value: publishedEmail, source: site };
  }
  const publishedPhone = audit?.published?.phones[0] ?? look?.states.phone ?? null;
  if (publishedPhone && isEmpty(lead.contactPhone)) {
    data.contactPhone = publishedPhone;
    filled.contactPhone = { value: publishedPhone, source: site };
  }

  // --- Profiles they link to themselves -----------------------------------
  const published = audit?.published?.socials ?? {};
  if (Object.keys(published).length) {
    const existing = (lead.socialLinks ?? {}) as Record<string, string>;
    const merged = { ...published, ...existing };
    if (Object.keys(merged).length !== Object.keys(existing).length) {
      data.socialLinks = merged;
      filled.socialLinks = { value: Object.keys(merged).join(", "), source: site };
    }
  }

  // --- Tags, which are how a list gets built later ------------------------
  //
  // A tag is added and never removed here. A finding that has gone away is
  // good news and belongs in the next look's findings, not in a silent
  // untagging that makes an earlier campaign impossible to reconstruct.
  const observedTags = [
    ...(audit ? auditTags(audit) : []),
    ...(look && !look.offerClear ? ["Offer unclear"] : []),
    ...(look && !look.contactClear ? ["No contact above the fold"] : []),
    ...(look?.looksDated ? ["Dated design"] : []),
  ];
  if (observedTags.length) {
    const slugs = await registerTags(observedTags, { autoCreated: true });
    const merged = [...new Set([...lead.tags, ...slugs])];
    if (merged.length !== lead.tags.length) {
      data.tags = merged;
      filled.tags = { value: merged.join(", "), source: site };
    }
  }

  // --- The score, recomputed on what is now known -------------------------
  //
  // `Math.max` for the same reason the scraper uses it: a re-run must never
  // demote a lead somebody has since worked on. Filling in an email and a
  // phone number genuinely does make a lead more reachable, which is most of
  // what this number means.
  const rescored = scoreLead({
    contactName: lead.contactName,
    companyName: lead.companyName,
    contactEmail: (data.contactEmail as string | undefined) ?? lead.contactEmail,
    contactPhone: (data.contactPhone as string | undefined) ?? lead.contactPhone,
    website: lead.website,
    address: lead.address,
    city: (data.city as string | undefined) ?? lead.city,
    region: lead.region,
    country: lead.country,
    category: (data.category as string | undefined) ?? lead.category,
    rating: lead.rating ? Number(lead.rating) : null,
    reviewsCount: lead.reviewsCount,
    socialLinks: ((data.socialLinks as Record<string, string> | undefined) ?? (lead.socialLinks as Record<string, string> | null)) ?? null,
  } as NormalizedLead);
  if (rescored > lead.leadScore) {
    data.leadScore = rescored;
    filled.leadScore = { value: `${lead.leadScore} → ${rescored}`, source: "recalculated from what is now known" };
  }

  if (Object.keys(data).length > 0) await prisma.lead.update({ where: { id: lead.id }, data });
  return filled;
}

/**
 * The one thing an email should open on, chosen across everything that was
 * found rather than only across the technical checks.
 *
 * This was a real defect and it produced a real email. `headlineFinding` only
 * ever read `audit.findings`, so a CRITICAL observation from *looking at the
 * page* — nothing on the first screen says what they sell; the site makes a
 * twenty-year-old manufacturer look like a start-up — could never win the
 * opening, while a MEDIUM DNS detail always could. The result was a letter to
 * a cement company about which hostname resolves. Accurate, and worth nothing
 * to the person reading it.
 *
 * Two rules decide it:
 *
 *  1. **Severity first**, judged by what it costs the business.
 *  2. **At equal severity, what a customer can see beats what a tool can
 *     measure.** An owner can check "your homepage never says what you make"
 *     by opening their own site. They cannot check an SPF record, they do not
 *     care, and they will not spend money on one.
 */
export interface StrongestPoint {
  /** The sentence to open on, already in the owner's own language. */
  say: string;
  /** Why it costs them something, in customers or enquiries. */
  costs: string;
  /** What makes it checkable — a URL, a header, or "open your own homepage". */
  evidence: string;
  severity: string;
  /** Whether this came from looking at the page or from measuring it. */
  kind: "seen" | "checked";
}

export function strongestPoint(audit: CompanyAudit | null, look: HomepageLook | null): StrongestPoint | null {
  const candidates: StrongestPoint[] = [];

  for (const observation of look?.observations ?? []) {
    if (observation.severity === "GOOD") continue;
    candidates.push({
      // `plainly` is the version with no web vocabulary in it, which is the
      // only version worth putting in front of a business owner.
      say: observation.plainly || observation.observed,
      costs: observation.soWhat,
      evidence: `visible on their own homepage (${observation.where})`,
      severity: observation.severity,
      kind: "seen",
    });
  }

  for (const finding of audit?.findings ?? []) {
    if (finding.severity === "GOOD") continue;
    candidates.push({ say: finding.observed, costs: "", evidence: finding.evidence, severity: finding.severity, kind: "checked" });
  }

  if (candidates.length === 0) return null;

  const rank: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  candidates.sort((a, b) => {
    const bySeverity = (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    // The tie-break that fixes the cement email.
    return Number(b.kind === "seen") - Number(a.kind === "seen");
  });
  return candidates[0];
}

/**
 * Is there a case here at all.
 *
 * This exists because of the email that prompted it: a letter that opened on
 * missing link-preview tags and closed on missing analytics. Both were true.
 * Neither mattered. The site it was about is a good site, and the pipeline
 * produced a cold email anyway, because nothing in it was allowed to say "there
 * is nothing worth writing about here".
 *
 * That is the failure mode of any system that always produces an output. So
 * the strength of the case is worked out from the worst thing actually found,
 * and a weak one is told to the drafter in those words and shown to the person
 * before they send it. A business that is doing fine is allowed to be doing
 * fine; writing to them about nothing is how a name gets burnt for the year
 * they *do* need somebody.
 */
export type CaseStrength = "STRONG" | "MODERATE" | "WEAK" | "NONE";

const RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

export function caseStrength(audit: CompanyAudit | null, look: HomepageLook | null): CaseStrength {
  const severities = [
    ...(audit?.findings ?? []).map((finding) => finding.severity),
    ...(look?.observations ?? []).map((observation) => observation.severity),
  ].filter((severity) => severity !== "GOOD");

  const worst = Math.max(0, ...severities.map((severity) => RANK[severity] ?? 0));
  if (worst >= 3) return "STRONG";
  if (worst === 2) return "MODERATE";
  if (worst === 1) return "WEAK";
  return "NONE";
}

/**
 * The faults serious enough for a stranger to be written to about.
 *
 * A "red flag" is CRITICAL or HIGH, from either half of the scan. MEDIUM is
 * housekeeping — real, worth fixing, and not worth a paragraph in a first
 * letter — and counting it here would make almost every business look alarming,
 * which is the fastest way to make the word mean nothing.
 *
 * The count is what decides the shape of the letter. One red flag is an email
 * about that one thing. Several is the case this exists for: the letter still
 * names **one**, because a list of faults is a report and nobody replies to a
 * report from a stranger, and the rest go out as the attached PDF with a
 * sentence saying so. See `outreachDoctrine.ts` → "When there is more than one
 * red flag".
 */
export function redFlags(audit: CompanyAudit | null, look: HomepageLook | null): { say: string; severity: string; kind: "seen" | "checked" }[] {
  const serious = (severity: string) => severity === "CRITICAL" || severity === "HIGH";
  const flags: { say: string; severity: string; kind: "seen" | "checked" }[] = [];

  for (const observation of look?.observations ?? []) {
    if (!serious(observation.severity)) continue;
    flags.push({ say: observation.plainly || observation.observed, severity: observation.severity, kind: "seen" });
  }
  for (const finding of audit?.findings ?? []) {
    if (!serious(finding.severity)) continue;
    flags.push({ say: finding.observed, severity: finding.severity, kind: "checked" });
  }
  return flags;
}

/**
 * Whether a demo page is the argument rather than an optional extra.
 *
 * A business with no website is the one case where there is nothing to observe,
 * nothing to measure and nothing to photograph — so every letter to one was
 * written from the *absence* of evidence, which reads as a lecture about
 * websites in general however carefully it is worded. The page itself is the
 * argument: their name, their trade, their town, at a link they can open on
 * their phone. That is far easier to say yes to than a meeting, and it is the
 * thing rather than a claim about the thing.
 *
 * So for a lead with no site the demo is part of preparing them, not a button
 * somebody remembers to press afterwards.
 */
export function demoIsTheArgument(input: { website: string | null | undefined; audit: CompanyAudit | null }): boolean {
  if (input.website?.trim()) return false;
  // A blank `website` and a site that provably does not exist are the same
  // case. What is *not* the same case is a site that could not be fetched: a
  // WAF, a timeout or a certificate nobody has renewed is a site their
  // customers can still reach, and building a replacement for it would be
  // pitching against a page we never opened.
  return true;
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
  strength: CaseStrength;
  hasWebsite: boolean;
  redFlags: { say: string; severity: string; kind: "seen" | "checked" }[];
}): string[] {
  const facts: string[] = [];

  if (input.research?.discoveryNote) {
    facts.push(
      `What research found about them (${input.research.researchedBy}${input.research.searchedLiveSources ? ", from live sources" : ", from memory rather than live sources"}): ${input.research.discoveryNote}`,
    );
  }

  if (input.audit) {
    // Named separately and first, because left to itself a drafter opens on
    // whichever finding reads most neatly rather than the one that costs them
    // most — which is how a letter ends up leading with missing link-preview
    // tags at a business whose site has been insecure since 2019.
    const headline = strongestPoint(input.audit, input.look);
    if (headline && (input.strength === "STRONG" || input.strength === "MODERATE")) {
      facts.push(
        `THE STRONGEST THING TO OPEN ON (${headline.severity.toLowerCase()}, ${
          headline.kind === "seen" ? "something they can see on their own page" : "measured"
        }): ${headline.say}${headline.costs ? ` What it costs them: ${headline.costs}` : ""} You can say this because: ${headline.evidence}`,
      );
    } else {
      facts.push(
        "THERE IS NO STRONG CASE HERE. Their site and their email set-up were checked and nothing serious is wrong with either — the worst of it is minor housekeeping. Do not inflate it into a problem: a business that is doing fine, told by a stranger that it is not, remembers that. Either write three honest sentences that say what is good and offer one small improvement, or say plainly in the rationale that this lead is not worth a cold email and let the sender decide.",
      );
    }

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

  if (!input.hasWebsite) {
    // The one case with no evidence to argue from, which is exactly why the
    // letter needs something other than an argument. See `demoIsTheArgument`.
    facts.push(
      "THEY HAVE NO WEBSITE, SO THE DEMO PAGE IS THE ASK. A page has been built for them — their name, their trade, their town, at a link they can open on their phone. Offer that link and nothing else: no meeting, no call, no list of what a website contains. If the facts above carry a demo link, put it in the letter on its own line. If they do not, the page could not be built this time, so offer to send one instead of pretending it exists.",
    );
  }

  if (input.look) {
    facts.push(...lookForPrompt(input.look));
  } else if (input.hasWebsite) {
    // Without this the drafter has only the technical checks and no way to
    // know that the interesting half is missing — which is how a letter about
    // a DNS record gets written to a business whose real problem is that their
    // homepage looks fifteen years old.
    facts.push(
      "NOBODY HAS ACTUALLY SEEN THEIR PAGE. Their site was checked by machine but never looked at, so nothing is known about how it looks, whether it says what they sell, or whether it suits the business. Do not write as though you have seen it, and do not stretch a technical check into a design opinion. If the checks alone give you nothing a business owner would pay to fix, say so.",
    );
  }

  return facts;
}

/** The stored prep, if there is one, without running anything. */
export async function storedPrep(leadId: string) {
  return prisma.leadResearch.findUnique({ where: { leadId } });
}
