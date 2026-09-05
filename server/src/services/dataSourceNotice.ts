import type { LeadSource } from "@prisma/client";
import { companyProfile } from "./systemProfile.js";

/**
 * The sentence a first message has to carry when we found the recipient
 * ourselves rather than being contacted by them.
 *
 * WHY THIS EXISTS
 * ---------------
 * Article 13 GDPR covers data somebody gives you. Article 14 covers data you
 * got some other way, and it is the one that applies to everything this
 * pipeline does: a business scraped off Google Maps, a company found through a
 * directory, an address read off a homepage. It asks for more, not less, than
 * Article 13 — because the person had no idea it was happening.
 *
 * The part with no equivalent anywhere else in the regulation is Art 14(2)(f):
 * **the source the data came from**. Everything else on the list (who we are,
 * why, on what basis, for how long, what rights) can live in a privacy policy
 * and be linked to, which Art 14(3)(a) permits where it is proportionate. The
 * source cannot, because it is different for each person: "we found your
 * business on Google Maps" is a fact about them, not about us, and a policy
 * page can only ever describe it in the abstract.
 *
 * The deadline is the other reason this is appended by code. Art 14(3)(b) says
 * the information must be given **at the latest when the first communication
 * is made** — so it cannot be a thing somebody remembers to add, or a thing a
 * model is asked to include. It is either on every first message or the
 * obligation is missed on whichever message it was left off.
 *
 * WHY IT IS A FOOTER AND NOT A PARAGRAPH
 * --------------------------------------
 * A cold email works because it reads like a letter from one person. Three
 * sentences of data-protection prose in the body destroys that, and would make
 * every message worse in exchange for compliance that a footer already
 * delivers — the information has to be *provided*, not made the subject of the
 * message. It sits with the opt-out, in the same small type as the rest of the
 * legal furniture, and it is legible rather than hidden.
 *
 * WHAT IT MUST NEVER DO
 * ---------------------
 * Name a source we do not actually know. The recipient is the one person alive
 * who can check whether we found them on Google Maps, and being told the wrong
 * thing about their own data is worse than being told a vague true thing. So
 * `OTHER`, and anything the enum grows later, falls through to a phrasing that
 * is honest without being specific — the same rule the audit and the drafters
 * follow, where a claim that is not in the facts is a false statement about
 * somebody made to the one person who knows it.
 */

/**
 * How each way of finding a business reads to the business itself.
 *
 * Deliberately in their words rather than ours: `GOOGLE_MAPS` is "your Google
 * Business listing", not "a Maps scrape", because the point is that they can
 * recognise it and check it.
 */
const SOURCE_PHRASES: Record<LeadSource, string> = {
  GOOGLE_MAPS: "your Google Business listing",
  WEB_SCRAPE: "your own website",
  DIRECTORY: "a public business directory",
  SOCIAL: "your public social media profile",
  LINKEDIN: "your public LinkedIn profile",
  REFERRAL: "a referral from someone who knows your business",
  WARM_NETWORK: "someone we both know",
  CONTENT: "an enquiry you made through our website",
  // The three below describe our own pipeline rather than a place anything was
  // found, so none of them can answer "where did you get this". They take the
  // general phrasing, which is true of all of them.
  COLD_EMAIL: "",
  OUTREACH: "",
  OTHER: "",
};

/**
 * What is said when the source on the record cannot answer the question.
 *
 * Not a placeholder to be filled in later — it is the honest answer for a lead
 * whose origin genuinely was not recorded, and it still satisfies Art 14(2)(f)
 * in substance: publicly available business contact details, from public
 * sources. What it must not do is invent a specific one.
 */
const GENERAL_PHRASE = "publicly available business listings";

/** Whether the source on the record can name a place, or only a pipeline. */
export function namesASource(source: LeadSource | null | undefined): boolean {
  return Boolean(source && SOURCE_PHRASES[source]);
}

export function sourcePhrase(source: LeadSource | null | undefined): string {
  return (source && SOURCE_PHRASES[source]) || GENERAL_PHRASE;
}

/**
 * The privacy policy's address, derived from the website on the company
 * profile rather than written here, so a change of domain does not leave every
 * cold email pointing at a page that has moved.
 *
 * Returns null rather than guessing when there is no website on file. A notice
 * linking to nothing is worse than one that gives the address to write to,
 * which the rest of the sentence does either way.
 */
export async function privacyPolicyUrl(): Promise<string | null> {
  const { web } = await companyProfile();
  const trimmed = web?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    return `${url.origin}/privacy`;
  } catch {
    return null;
  }
}

export interface SourceNotice {
  /** One sentence, plain text, for the text alternative and the phone channels. */
  text: string;
  /** The same sentence with the policy linked, for the HTML footer. */
  html: string;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Builds the notice.
 *
 * Four things in one sentence, which is as short as Art 14 gets without
 * leaving something out: where the details came from, what they are (business
 * contact details, not personal ones), the basis, and where the rest of it is.
 * The right to object is not repeated here because the opt-out sentence in the
 * body and the unsubscribe link in the footer are both already that right,
 * exercised — a third statement of it would be the same promise three times in
 * one message.
 */
export function sourceNotice(args: {
  source: LeadSource | null | undefined;
  privacyUrl: string | null;
  companyName: string;
  privacyEmail: string;
}): SourceNotice {
  const where = sourcePhrase(args.source);
  const lead = `You are receiving this because ${args.companyName} found your business contact details on ${where}.`;
  const basis = "We use them under our legitimate interest in offering a business service, and for nothing else.";

  const closeText = args.privacyUrl
    ? `How we handle your data, and your rights over it: ${args.privacyUrl} — or write to ${args.privacyEmail}.`
    : `To see how we handle your data, or to have it deleted, write to ${args.privacyEmail}.`;

  const closeHtml = args.privacyUrl
    ? `How we handle your data, and your rights over it: <a href="${escapeHtml(args.privacyUrl)}" style="color:#8993A6">${escapeHtml(
        args.privacyUrl.replace(/^https?:\/\//, ""),
      )}</a> — or write to <a href="mailto:${escapeHtml(args.privacyEmail)}" style="color:#8993A6">${escapeHtml(
        args.privacyEmail,
      )}</a>.`
    : `To see how we handle your data, or to have it deleted, write to <a href="mailto:${escapeHtml(
        args.privacyEmail,
      )}" style="color:#8993A6">${escapeHtml(args.privacyEmail)}</a>.`;

  return {
    text: `${lead} ${basis} ${closeText}`,
    html: `${escapeHtml(lead)} ${escapeHtml(basis)} ${closeHtml}`,
  };
}

/**
 * The short form, for a channel with no footer to put it in.
 *
 * A WhatsApp message is forty words and an SMS segment is 160 characters, so
 * the full notice cannot ride on one — and padding a first message out to
 * three times its length with legal prose is not a message anybody answers.
 * This is the most that fits: where we found them, and where the rest is.
 * It is a link, which Art 14(3)(a) allows, and the deadline is still met
 * because it goes with the first message rather than after it.
 */
export function shortSourceNotice(args: {
  source: LeadSource | null | undefined;
  privacyUrl: string | null;
}): string {
  const where = sourcePhrase(args.source);
  return args.privacyUrl
    ? `Found you on ${where}. How we use your details: ${args.privacyUrl}`
    : `Found you on ${where}.`;
}
