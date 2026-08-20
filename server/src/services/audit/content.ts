import { callModel } from "../../lib/models/call.js";
import { PROVIDERS } from "../../lib/models/registry.js";
import type { CompanyAudit } from "../companyAudit.js";
import type { AuditEvidence } from "./evidence.js";
import { DISCIPLINE_AGENTS, scoreFindings, sortBySeverity, trimFindings, type AuditFindingDetail, type DisciplineReport } from "./types.js";
import { composeWriterSystem, resolveBrief } from "../writers/brief.js";

/**
 * The content review: whether the words do the selling the design cannot.
 *
 * A page can be handsome, fast and perfectly secure and still fail to say what
 * the business does, who it is for, why anyone should choose it, or what to do
 * next. That failure is invisible to every other reviewer on this team — the
 * markup is fine, the certificate is fine, the picture looks smart — and it is
 * the one that most often explains why a site "gets traffic but no enquiries".
 *
 * The reviewer reads the visible text of the homepage with the markup taken
 * out. That is a real constraint worth being honest about: it sees the words in
 * source order, not in the order the layout puts them, and it has not seen the
 * other pages. Both are stated in the section's own notes rather than
 * pretended away.
 *
 * Two counted facts are handed to it alongside the prose, because they are the
 * ones most often wrong and they are not opinions: how many words there are,
 * and how many ways a visitor can actually make contact from the page.
 */

/** Below this, a homepage does not contain enough to rank for anything or to answer a question. */
const THIN_WORDS = 150;
/** How much of the page's text the reviewer is given. Enough for a homepage, several times over. */
const MAX_TEXT_CHARS = 12_000;

/** The cap the schema asks for in words, applied to what comes back. */
const MAX_OBSERVATIONS = 9;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "saysWhatTheyDo", "whoItIsFor", "observations"],
  properties: {
    headline: { type: "string", description: "One sentence, under fifteen words: the state of the writing on this site. No jargon." },
    summary: {
      type: "string",
      description:
        "Two or three sentences a business owner reads instead of the list. What the words on this page do and do not achieve, and the one change that would matter most.",
    },
    saysWhatTheyDo: {
      type: "string",
      description:
        "In one sentence: what a stranger would conclude this business sells, from the words alone. If the answer is 'it is not clear', say exactly that and say what the words suggest instead.",
    },
    whoItIsFor: {
      type: "string",
      description: "Who the writing appears to be addressed to — householders, other businesses, a particular trade — or 'nobody in particular' if it never says.",
    },
    observations: {
      type: "array",
      // Not `maxItems`: structured outputs reject array constraints, so the
      // cap goes in the description and is enforced by the slice below.
      description: "At most 9, worst first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "observed", "quote", "impact", "plainly", "recommendation", "severity"],
        properties: {
          title: { type: "string", description: "A few words, as a heading." },
          observed: { type: "string", description: "What is true about the writing. Only about the text you were given." },
          quote: {
            type: "string",
            description:
              "A short phrase copied exactly from their page that shows the point, so the owner can find it. Empty string only when the point is about something absent.",
          },
          impact: { type: "string", description: "What it costs them — an enquiry not made, a question unanswered, a visitor who leaves. One sentence." },
          plainly: { type: "string", description: "The same point across a desk, with no marketing or web vocabulary in it at all. This is the sentence an email will use." },
          recommendation: { type: "string", description: "What to write instead, in one sentence. Empty string for a GOOD observation." },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "GOOD"] },
        },
      },
    },
  },
} as const;

interface ContentRead {
  headline: string;
  summary: string;
  saysWhatTheyDo: string;
  whoItIsFor: string;
  observations: {
    title: string;
    observed: string;
    quote: string;
    impact: string;
    plainly: string;
    recommendation: string;
    severity: AuditFindingDetail["severity"];
  }[];
}

export async function reviewContent(
  evidence: AuditEvidence,
  audit: CompanyAudit | null,
  business: { name: string; trade: string | null; town: string | null },
): Promise<DisciplineReport> {
  const notes: string[] = [];
  const checked: string[] = [];
  const findings: AuditFindingDetail[] = [];
  const page = evidence.page;

  if (!page) {
    notes.push(
      evidence.fetch.domainDoesNotResolve
        ? "There is no site at that address, so there were no words to read."
        : "Their homepage could not be retrieved, so nothing they have written was read.",
    );
    return {
      discipline: "CONTENT",
      reviewer: DISCIPLINE_AGENTS.CONTENT.name,
      reviewedBy: "Not run",
      score: 0,
      scored: false,
      headline: "The page could not be retrieved, so nothing was read",
      summary: notes[0],
      findings: [],
      checked,
      notes,
      costUsd: 0,
    };
  }

  checked.push("The visible words on the homepage");
  checked.push("How many ways a visitor can make contact from the page");
  notes.push("This is the homepage only, read as text in the order it appears in the markup rather than in the order the layout shows it. Other pages were not read.");

  // --- The two counted facts, which are not opinions ------------------------
  if (page.wordCount < THIN_WORDS) {
    findings.push({
      id: "content-thin",
      discipline: "CONTENT",
      severity: "HIGH",
      title: "There is almost nothing on the page to read",
      observed: `The homepage carries ${page.wordCount} words of visible text. A page that answers a customer's questions is usually three to five hundred.`,
      evidence: `${page.wordCount} words of text after the markup was removed from ${evidence.finalUrl}.`,
      impact:
        "There is not enough on the page to answer the questions a customer arrives with, and not enough for a search engine to work out what the business does. Both of those cost enquiries.",
      plainly: "There are barely any words on their front page, so visitors cannot get their questions answered and Google cannot tell what the business does.",
      recommendation: "Write the four things a customer wants: what is offered, who it is for, what it costs or how pricing works, and how to get in touch.",
      region: null,
      marker: null,
    });
  }

  const routes = page.contactRoutes;
  const tappable = routes.tel + routes.whatsapp;
  if (tappable === 0 && routes.mailto === 0 && !routes.contactPageLinked) {
    findings.push({
      id: "content-no-contact",
      discipline: "CONTENT",
      severity: "CRITICAL",
      title: "There is no way to make contact from the homepage",
      observed: "The homepage carries no phone link, no email link, no WhatsApp link and no link to a contact page.",
      evidence: `No tel:, mailto: or WhatsApp links, and no /contact link, in the markup of ${evidence.finalUrl}.`,
      impact:
        "Somebody who has decided to get in touch cannot. Every visitor who reached the point of wanting to call has to go back to a search result and find a competitor who made it easy.",
      plainly: "There is no way to ring or message them from their own front page. Anyone who wants to get in touch has to go back to Google.",
      recommendation: "Put the phone number in the header as a tappable link, and repeat it at the end of the page.",
      region: null,
      marker: null,
    });
  } else if (tappable === 0 && (audit?.published?.phones.length || routes.mailto || routes.contactPageLinked)) {
    findings.push({
      id: "content-phone-not-tappable",
      discipline: "CONTENT",
      severity: "MEDIUM",
      title: "The phone number cannot be tapped",
      observed: audit?.published?.phones.length
        ? `A phone number is printed on the page (${audit.published.phones[0]}) but it is not a link, so on a phone it cannot be dialled by tapping it.`
        : "There is no tappable phone or WhatsApp link on the homepage.",
      evidence: `No tel: or WhatsApp links in the markup of ${evidence.finalUrl}.`,
      impact:
        "On a phone — which is where most of these visitors are — the customer has to memorise or copy the number by hand. A meaningful share of them simply do not.",
      plainly: "On a phone, their number cannot be tapped to call — it has to be copied out by hand, and a lot of people will not bother.",
      recommendation: 'Wrap the number in a `tel:` link, and add a WhatsApp link beside it.',
      region: null,
      marker: null,
    });
  } else if (tappable > 0) {
    findings.push({
      id: "content-contact-good",
      discipline: "CONTENT",
      severity: "GOOD",
      title: "A visitor can make contact in one tap",
      observed: `The homepage carries ${routes.tel} tappable phone link${routes.tel === 1 ? "" : "s"}${routes.whatsapp ? ` and ${routes.whatsapp} WhatsApp link${routes.whatsapp === 1 ? "" : "s"}` : ""}.`,
      evidence: `tel:/WhatsApp links found in the markup of ${evidence.finalUrl}.`,
      impact: "Somebody who decides to get in touch can, without leaving the page.",
      plainly: "Getting in touch takes one tap, which is the thing most small business sites get wrong.",
      recommendation: null,
      region: null,
      marker: null,
    });
  }

  // --- The judgement --------------------------------------------------------
  const text = page.text.slice(0, MAX_TEXT_CHARS);
  if (page.text.length > MAX_TEXT_CHARS) notes.push("The page is longer than what was read; the review covers the first part of it.");

  let read: ContentRead | null = null;
  let by = "Not run";
  let costUsd = 0;

  if (!text.trim()) {
    notes.push("The homepage has no readable text at all in its markup — it is likely built entirely in JavaScript or images, which is itself the finding below.");
    findings.push({
      id: "content-no-text",
      discipline: "CONTENT",
      severity: "HIGH",
      title: "The page has no readable text in it",
      observed: "There is no visible text in the page's markup at all. The words a visitor sees are being drawn by JavaScript, or they are inside images.",
      evidence: `No text content after markup was removed from ${evidence.finalUrl}.`,
      impact:
        "A search engine reading the page finds nothing to index, so the site cannot rank for anything it says. Screen readers find nothing either.",
      plainly: "There are no actual words in their page for Google to read — everything is drawn by code or inside pictures — so searches never find them.",
      recommendation: "Render the main copy as real text on the server, or add it as text and style it.",
      region: null,
      marker: null,
    });
  } else {
    try {
      const result = await callModel<ContentRead>({
        purpose: "audit.content",
        // Reading and judging prose. Routed with the rest of the writing.
        job: "text",
        system: await systemPrompt(business),
        prompt: () => buildPrompt(evidence, page, text, business),
        schema: SCHEMA as unknown as Record<string, unknown>,
        effort: "medium",
        maxTokens: 3000,
      });
      read = result.data;
      by = PROVIDERS[result.provider].name;
      costUsd = result.costUsd;
      if (result.fallbackNote) notes.push(result.fallbackNote);
    } catch (err) {
      notes.push(`The words on the page were collected but nobody read them: ${(err as Error).message}`);
    }
  }

  if (read) {
    findings.push(
      ...read.observations.slice(0, MAX_OBSERVATIONS).map((observation, index) => ({
        id: `content-${index + 1}`,
        discipline: "CONTENT" as const,
        severity: observation.severity,
        title: observation.title,
        observed: observation.observed,
        // A quote from their own page is the strongest evidence this reviewer
        // can offer, and it is the one thing the owner can search for on their
        // own site to confirm the point in five seconds.
        evidence: observation.quote?.trim() ? `Their own words: “${observation.quote.trim()}” — ${evidence.finalUrl}` : `The visible text of ${evidence.finalUrl}`,
        impact: observation.impact,
        plainly: observation.plainly,
        recommendation: observation.recommendation?.trim() ? observation.recommendation.trim() : null,
        region: null,
        marker: null,
      })),
    );
  }

  const { kept, dropped } = trimFindings(findings, { medium: 5, low: 3, good: 2 });
  if (dropped) notes.push(`${dropped} smaller point${dropped === 1 ? "" : "s"} about the writing were left out of this section to keep it readable.`);

  const sorted = sortBySeverity(kept);

  return {
    discipline: "CONTENT",
    reviewer: DISCIPLINE_AGENTS.CONTENT.name,
    reviewedBy: by,
    score: scoreFindings(sorted),
    // This section's job is judging the writing, and only a reader can do
    // that. The counted facts below stand on their own, but a section where
    // nobody read a word is not a section that scored 100 — it is a section
    // that did not run.
    scored: Boolean(read),
    headline: read?.headline.trim() || fallbackHeadline(sorted),
    summary: read
      ? [read.summary.trim(), `What a stranger would conclude they sell: ${read.saysWhatTheyDo.trim()}`, `Who the writing addresses: ${read.whoItIsFor.trim()}`]
          .filter(Boolean)
          .join("\n\n")
      : fallbackSummary(sorted, page.wordCount),
    findings: sorted,
    checked,
    notes,
    costUsd,
  };
}

function fallbackHeadline(findings: AuditFindingDetail[]): string {
  const worst = findings.find((finding) => finding.severity === "CRITICAL") ?? findings.find((finding) => finding.severity === "HIGH");
  return worst ? worst.title : "Nobody read the writing on the page";
}

function fallbackSummary(findings: AuditFindingDetail[], wordCount: number): string {
  const problems = findings.filter((finding) => finding.severity !== "GOOD");
  return [
    `The page carries ${wordCount} words of visible text.`,
    problems.length ? `${problems.length} thing${problems.length === 1 ? "" : "s"} that can be counted rather than judged are listed below.` : "",
    "Nobody read the writing itself — the section is what could be counted, not what could be judged.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * How this reviewer judges. Overridable by `content.writer`, the agent whose
 * name the report already prints at the foot of this section.
 */
const SHIPPED_DOCTRINE = `**What you are judging.** Not grammar, and not tone for its own sake. Whether these words:
- say what the business sells, in the first thing a visitor reads
- say who it is for, and where
- answer the questions a customer actually arrives with — what it costs, how long it takes, whether they cover my area, are you any good
- give a reason to choose them over the next result, backed by something real
- tell somebody what to do next, once
- read like a person wrote them, not a brochure

**Quote their own words.** Every observation that is about something present must carry a short phrase copied exactly from the page, so the owner can find it on their own site. This is what separates a review from an opinion.

**Never invent a fault.** If the copy is good, say so and mark it GOOD. A review that only criticises reads as a sales pitch and is read as one. If the page is genuinely fine, three GOOD observations and a short summary is the honest answer.

**Never claim something is missing when you were only given part of the page.** "There is no pricing on the homepage" is a fair observation. "They do not publish pricing" is not — you have not seen their pricing page.`;

/** The mechanics. The severity words are scored, so they are not a style choice. */
const CONTRACT = `Write for somebody who runs a business and has never heard the words "value proposition". British English. No exclamation marks. Do not use "compelling", "engaging", "leverage", "resonate" or "messaging".`;

async function systemPrompt(business: { name: string; trade: string | null; town: string | null }): Promise<string> {
  const brief = await resolveBrief("audit.content", SHIPPED_DOCTRINE);
  const who = brief.agentName ?? "Content Writer";

  const evidence = `You are the Dakyworld ${who}, reviewing the words on one homepage for ${business.name}${business.trade ? `, ${business.trade}` : ""}${business.town ? ` in ${business.town}` : ""}.

You are given the visible text of the page with the markup taken out. **That text is the whole of your evidence.** You have not seen the layout, the pictures, the other pages, or what happens when a button is pressed, and you may not say anything about any of them. Where you are not sure whether something is absent or merely somewhere you were not shown, say so rather than asserting it.

The text arrives in the order it appears in the source, which is usually navigation, then the page, then the footer. Do not treat that order as the order a visitor reads in.`;

  return composeWriterSystem(brief, { preamble: [evidence], contract: CONTRACT });
}

function buildPrompt(
  evidence: AuditEvidence,
  page: NonNullable<AuditEvidence["page"]>,
  text: string,
  business: { name: string; trade: string | null; town: string | null },
): string {
  const parts = [
    `The business: ${business.name}`,
    business.trade ? `What they do, according to the record: ${business.trade}` : null,
    business.town ? `Where: ${business.town}` : null,
    `The page: ${evidence.finalUrl}`,
    "",
    "Counted facts about this page, which are not opinions and which you may use:",
    `- ${page.wordCount} words of visible text`,
    `- Headings, in order: ${page.headings.length ? page.headings.map((heading) => `h${heading.level} "${heading.text}"`).join(" / ") : "none"}`,
    `- Tappable phone links: ${page.contactRoutes.tel}; email links: ${page.contactRoutes.mailto}; WhatsApp links: ${page.contactRoutes.whatsapp}; link to a contact page: ${page.contactRoutes.contactPageLinked ? "yes" : "no"}`,
    `- Forms on the page: ${page.forms.length}`,
    "",
    "The visible text of the homepage, markup removed:",
    "---",
    text,
    "---",
    "",
    "Review the writing.",
  ].filter(Boolean) as string[];
  return parts.join("\n");
}
