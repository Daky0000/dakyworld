import { prisma } from "../lib/prisma.js";
import { SETTING, getSetting } from "../lib/settings.js";
import type { LeadSource } from "@prisma/client";

/**
 * Deleting personal data when the period we published for it runs out.
 *
 * WHY THIS EXISTS, AND WHY IT DID NOT BEFORE
 * ------------------------------------------
 * Art 5(1)(e) GDPR — storage limitation — says personal data may be kept "no
 * longer than is necessary", and s.24 of Ghana's Act 843 says the same thing in
 * fewer words. Neither is satisfied by intending to delete something.
 *
 * On 4 Sep 2026 the privacy policy started publishing a period for every
 * category of data on dakyworld.com. That made the obligation concrete and it
 * also created a second, sharper problem: **a published retention period that
 * nothing enforces is a false statement in a privacy policy**, which is worse
 * than the vague "as long as necessary" it replaced. Vague and true beats
 * specific and untrue. So the periods below are the ones on the page, and this
 * is what makes them so.
 *
 * ONLY ONE CATEGORY IS SWEPT HERE, AND THAT IS DELIBERATE
 * -------------------------------------------------------
 * The policy publishes five periods. Four of them are not this module's to
 * enforce and saying why is the point:
 *
 * - **Billing records, 6 years** — a legal obligation to *keep*, not to delete.
 *   Sweeping those would be the violation.
 * - **Client systems data, 14 days after the engagement** — lives in the
 *   client's own systems, not ours. Ending it is an offboarding step a person
 *   does, and a scheduler cannot know an engagement ended.
 * - **Enquiries, 24 months from the last message** — the contact form is not
 *   connected to anything yet, so there is nothing to sweep. It becomes real on
 *   the day that form starts writing to this database, and there is a note
 *   below to catch it.
 * - **Analytics, up to 2 years** — Google's retention, set in GA4's own admin,
 *   which nothing here can reach.
 *
 * That leaves the one category this pipeline creates by the thousand and the
 * one with the weakest claim to be kept: **business contact details we went and
 * found ourselves**, on a business that never became anything.
 *
 * WHAT IT WILL NOT TOUCH
 * ----------------------
 * The guards are the substance of this file, because the failure mode is
 * deleting somebody's pipeline. A lead is only ever swept when *every* one of
 * these is true, and each is a separate reason it would be wrong:
 *
 * - **We found them; they did not come to us.** A referral or a website enquiry
 *   is data given willingly and is not covered by the twelve-month period.
 * - **Nothing was ever sent to them, and nothing came back.** One email, one
 *   call logged, one WhatsApp — any of them and this is a conversation with a
 *   history somebody may need.
 * - **No proposal, no client, no project.** Obvious, and worth asserting.
 * - **Nobody has touched the record in twelve months**, by `updatedAt` rather
 *   than `createdAt`: a lead somebody re-scored last week is a lead in use,
 *   whenever it was scraped.
 *
 * AND IT IS OFF UNTIL SOMEBODY TURNS IT ON
 * ----------------------------------------
 * `privacy.retentionEnforced` defaults to **false**, and the tick reports what
 * it *would* remove instead. Deleting rows from somebody's lead database on a
 * schedule they did not ask for is not a change to make on their behalf, and
 * the first run is the one where a wrong guard costs the most. The report is
 * what makes the decision an informed one: look at the number, look at a
 * sample, then switch it on.
 *
 * The tombstone is kept. `LeadVerdict` already outlives a deleted lead — that
 * is how a hunt knows not to re-judge a business it rejected — and the same
 * applies here: forgetting that we swept somebody means finding them again next
 * week and starting the twelve months over.
 */

/**
 * NOT the same thing as `capture.retentionDays`, which is easy to mistake for
 * this and is why the distinction is written down.
 *
 * That setting prunes `ScraperRun` history — how many rows a run returned, what
 * it cost, whether it failed — and its own comment says "Captured leads are
 * never touched", correctly: run history is bookkeeping about our own machine
 * and holds nobody's personal data. This module is the other half, and until
 * now there was no other half: the bookkeeping about the scrape expired after
 * ninety days and the businesses it found were kept for ever.
 */

/** Machine-sourced: we went and found them. Everything else came to us. */
const WE_FOUND_THEM: LeadSource[] = ["GOOGLE_MAPS", "WEB_SCRAPE", "DIRECTORY", "SOCIAL", "LINKEDIN"];

/**
 * Twelve months, as published at dakyworld.com/privacy §03.
 *
 * **Change this and the page, together.** A period that differs between the
 * code and the notice is the same defect as not enforcing one at all: whichever
 * is wrong, somebody was told something untrue.
 */
export const FOUND_CONTACT_MONTHS = 12;

/**
 * Twenty-four months from the last message, also published, and not yet
 * enforceable: the enquiry form on the website is a stub that tells people to
 * email instead, so no enquiry has ever reached this database.
 *
 * Left here as the note that catches it. The day contact.html starts posting to
 * an endpoint, this becomes a real sweep and a real obligation, and a constant
 * with nothing reading it is a much better prompt than remembering.
 */
export const ENQUIRY_MONTHS = 24;

function monthsAgo(months: number): Date {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

/**
 * Leads whose published period has run out.
 *
 * Reads, never writes, so it is safe to call from a report, a screen or a dry
 * run. `enforceRetention` is the only thing that deletes.
 */
export async function leadsDueForDeletion(limit = 500) {
  const cutoff = monthsAgo(FOUND_CONTACT_MONTHS);

  return prisma.lead.findMany({
    where: {
      source: { in: WE_FOUND_THEM },
      updatedAt: { lt: cutoff },
      // Never a business that turned into anything.
      clientId: null,
      status: { in: ["NEW", "DISQUALIFIED"] },
      // `none` on each relation rather than a count: one message, one logged
      // call or one proposal makes this a conversation rather than a row.
      emails: { none: {} },
      messages: { none: {} },
      communications: { none: {} },
      proposals: { none: {} },
    },
    select: { id: true, companyName: true, contactName: true, source: true, updatedAt: true, dedupeKey: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
}

export interface RetentionResult {
  /** How many were past their period. */
  due: number;
  /** How many were actually removed. Zero on a dry run, by design. */
  deleted: number;
  /** Whether the setting allows deleting at all. */
  enforced: boolean;
  /** A handful of names, for a log line somebody can sanity-check. */
  sample: string[];
}

/**
 * The sweep.
 *
 * Deletes only with `apply`, which the caller gets from the setting rather than
 * deciding for itself — a scheduler that could enable its own destructive path
 * is one line away from doing it by accident.
 */
export async function enforceRetention(options: { apply: boolean; limit?: number }): Promise<RetentionResult> {
  const due = await leadsDueForDeletion(options.limit ?? 500);
  const sample = due.slice(0, 5).map((lead) => lead.companyName ?? lead.contactName);

  if (!options.apply || due.length === 0) {
    return { due: due.length, deleted: 0, enforced: options.apply, sample };
  }

  // One statement, so a crash halfway cannot leave half a sweep behind — and
  // the cascades on Lead take the research, the screenshots, the audits and the
  // demo with it, which is the point: those hold the same person's data.
  const removed = await prisma.lead.deleteMany({ where: { id: { in: due.map((lead) => lead.id) } } });

  return { due: due.length, deleted: removed.count, enforced: true, sample };
}

/** Whether the Owner has switched deletion on. Off unless explicitly true. */
export async function retentionEnforced(): Promise<boolean> {
  return (await getSetting(SETTING.RETENTION_ENFORCED)) === "true";
}
