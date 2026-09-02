import { callModel, type PromptImage } from "../../lib/models/call.js";
import { PROVIDERS } from "../../lib/models/registry.js";
import type { AuditEvidence } from "./evidence.js";
import { composeWriterSystem, resolveBrief } from "../writers/brief.js";
import type { AuditFindingDetail, ScreenshotView } from "./types.js";

/**
 * The redesign call: does this page need rebuilding, or does it not.
 *
 * **This is a decision, and it is deliberately not made by the reviewer.** The
 * UI/UX section next door describes what is visibly true of the page and boxes
 * each point onto the screenshot; this one reads the same two pictures and
 * answers the only question the business owner actually has, which is what to
 * do about it. They were one question for as long as one model answered both,
 * and that is the arrangement this splits up — a reviewer that has just listed
 * six faults recommends a rebuild, because a list of faults is what a rebuild
 * is argued from. "You need a new website" is the most expensive sentence in a
 * proposal to have got wrong, and it is expensive in both directions: sell one
 * to a business that needed an afternoon's work and the invoice is
 * indefensible; recommend two fixes to a business whose page is ten years past
 * saving and the fixes fail, and what failed is Dakyworld.
 *
 * So it is its own model job — `redesign`, routed to Perplexity, see
 * `lib/models/registry.ts` — and it is given three things:
 *
 *  - **The pictures.** The whole of the evidence, exactly as the reviewer had
 *    them. Nothing here may be said about a page that was not photographed.
 *  - **What the reviewer already found.** Not so it can repeat them: so it
 *    cannot contradict them. Two sections of one document disagreeing about
 *    one homepage is the fault that ends a reader's trust in both.
 *  - **What the business is.** A page is only ever too small for the company
 *    standing behind it, and that judgement cannot be made from a picture
 *    alone.
 *
 * It fails to a note, like every other stage here: an audit with no redesign
 * call in it is a shorter document, never a broken one.
 */

/** The decision itself, which is the whole point of this section. */
export type RedesignCall =
  /** Past fixing: correcting what is wrong costs about what building it again would. */
  | "REBUILD"
  /** The bones are sound, and named changes would carry it. */
  | "TARGETED_FIXES"
  /** It is doing its job. Saying so is what makes the other two believable. */
  | "LEAVE_IT";

/**
 * The things a page is judged on, named rather than left to free text.
 *
 * An enum because the same nine areas have to be considered on every site, or
 * "nothing wrong with the pictures" and "nobody looked at the pictures" become
 * the same silence — which is the distinction this whole document is built on.
 */
export type RedesignArea =
  | "LAYOUT"
  | "TYPOGRAPHY"
  | "HIERARCHY"
  | "BRANDING"
  | "IMAGERY"
  | "CALL_TO_ACTION"
  | "MOBILE"
  | "CREDIBILITY"
  | "DATED";

/** The headings these print under. No web vocabulary in any of them. */
export const AREA_NAMES: Record<RedesignArea, string> = {
  LAYOUT: "Layout and spacing",
  TYPOGRAPHY: "Type and readability",
  HIERARCHY: "What the eye is led to",
  BRANDING: "Whether it looks like one company",
  IMAGERY: "The pictures",
  CALL_TO_ACTION: "What it asks the visitor to do",
  MOBILE: "On a phone",
  CREDIBILITY: "Whether it looks like a real business",
  DATED: "Dated, cluttered or unfinished",
};

export interface RedesignIssue {
  area: RedesignArea;
  /** What is visibly true, in the owner's words. Only ever from the picture. */
  observed: string;
  /** Which of the two pictures. */
  view: ScreenshotView;
  /** What it costs them. One sentence, concrete. */
  costsThem: string;
}

export interface RedesignImpact {
  /** What the page does to whether a stranger believes this is a real firm. */
  trust: string;
  /** What it does to somebody trying to find one thing on it. */
  usability: string;
  /** What it does to the enquiry that should have been made. */
  conversion: string;
  /** How a first-time visitor feels in the first few seconds, as a person rather than a metric. */
  howItFeels: string;
}

export interface RedesignStep {
  /** The change, in one line. */
  change: string;
  /** Why that one, and why in this position. */
  why: string;
}

export interface RedesignVerdict {
  call: RedesignCall;
  /** One sentence: the call, said the way it would be said out loud. */
  headline: string;
  /** Two or three sentences behind the call. */
  assessment: string;
  issues: RedesignIssue[];
  impact: RedesignImpact;
  /** What a redesign should change, in order. Empty when the call is LEAVE_IT. */
  direction: RedesignStep[];
  /**
   * The paragraph that can be lifted into a proposal or a client report with
   * nothing edited out of it. It is the reason this section is written as prose
   * rather than as another list of findings.
   */
  summary: string;
  /**
   * The agent whose wording made the call, by name — the same name printed at
   * the foot of every other section. The four sections all say who reviewed
   * them and this one said only which vendor answered, which reads as though
   * the decision came from a model rather than from a job somebody owns.
   */
  reviewer: string;
  /** Which vendor answered, since a stand-in may have. */
  decidedBy: string;
  decidedAt: string;
  /**
   * What the vendor read while deciding, when it searched — Perplexity does on
   * every call. Carried because a claim checked against nothing is not checked,
   * and printed in the Markdown only: these are pages about how sites in a
   * trade look now, not evidence about this business, and putting them under a
   * client-facing verdict would read as though they were.
   */
  sources: { title: string; url: string }[];
}

export interface RedesignResult {
  verdict: RedesignVerdict | null;
  /** Why there is none. Never a failure. */
  notes: string[];
  costUsd: number;
}

const MAX_ISSUES = 8;
const MAX_STEPS = 5;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["call", "headline", "assessment", "issues", "impact", "direction", "summary"],
  properties: {
    call: {
      type: "string",
      enum: ["REBUILD", "TARGETED_FIXES", "LEAVE_IT"],
      description:
        "REBUILD when correcting what is wrong would cost about what building the page again would. TARGETED_FIXES when the structure is sound and named changes would carry it. LEAVE_IT when the page is doing its job and there is no honest case for spending money on it.",
    },
    headline: { type: "string", description: "One sentence, under twenty words, saying the call the way you would say it across a desk. No jargon." },
    assessment: {
      type: "string",
      description:
        "Two or three sentences behind that call: what this page is, what it is failing to do, and why that adds up to the answer you gave. Describe what is there, not only what is missing.",
    },
    issues: {
      type: "array",
      // Not `maxItems`: structured outputs reject array constraints, so the cap
      // is stated here and applied by the slice below.
      description:
        "At most 8, worst first. One entry per area that is genuinely a problem. Do not invent an entry for an area that is fine, and do not use the same area twice.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["area", "observed", "view", "costsThem"],
        properties: {
          area: {
            type: "string",
            enum: ["LAYOUT", "TYPOGRAPHY", "HIERARCHY", "BRANDING", "IMAGERY", "CALL_TO_ACTION", "MOBILE", "CREDIBILITY", "DATED"],
            description:
              "LAYOUT — spacing, alignment, how the page is arranged. TYPOGRAPHY — type size, line length, contrast, whether it can be read. HIERARCHY — whether the eye is led to the right thing first. BRANDING — whether the logo, colours and type look like one company. IMAGERY — the quality of the pictures, or that there are none. CALL_TO_ACTION — whether the page asks the visitor to do anything, and whether that is findable. MOBILE — what the phone picture shows. CREDIBILITY — whether a stranger would believe this is an established business. DATED — a design that gives away its age, clutter, or a section that was never finished.",
          },
          observed: { type: "string", description: "What is visibly the case in the picture, in words the owner would use. Never a claim about a page you were not shown." },
          view: { type: "string", enum: ["desktop", "mobile"], description: "Which of the pictures this is about." },
          costsThem: { type: "string", description: "What it costs them: a visitor who leaves, an enquiry never made, a comparison lost. One sentence, no adjectives." },
        },
      },
    },
    impact: {
      type: "object",
      additionalProperties: false,
      required: ["trust", "usability", "conversion", "howItFeels"],
      description: "What all of it adds up to for the business. Four short paragraphs, each about a different thing.",
      properties: {
        trust: { type: "string", description: "What this page does to whether a stranger believes this is a real, established firm worth dealing with." },
        usability: { type: "string", description: "What it does to somebody trying to find one thing — a price, a number, whether they cover their area." },
        conversion: { type: "string", description: "What it does to the enquiry that should have been made. Name who does not make it and what they do instead." },
        howItFeels: {
          type: "string",
          description:
            "How a first-time visitor feels in the first few seconds on this page, written as a person rather than as a metric. Two or three sentences. This is the part the owner recognises, so it has to be honest: if the page feels perfectly fine, say that.",
        },
      },
    },
    direction: {
      type: "array",
      description: "At most 5, in the order they should be done. An empty list when the call is LEAVE_IT.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["change", "why"],
        properties: {
          change: { type: "string", description: "The change in one line, in plain words: what would be different when somebody opened the page." },
          why: { type: "string", description: "Why that change, and why in this position. One sentence." },
        },
      },
    },
    summary: {
      type: "string",
      description:
        "One paragraph, five to eight sentences, that can be lifted straight into a proposal or a client report with nothing edited out of it. It states the call, what is behind it, and what a redesign would change. Written to the business, in the second person, with no web vocabulary in it at all — no hero, above the fold, CTA, conversion rate, UX or responsive. Somebody has to read it and think: that is my website they are describing.",
    },
  },
} as const;

/**
 * How the call is made. Overridable by the agent that owns it — the UI/UX
 * Designer, whose one listed skill this is: knowing when to refine and when to
 * replace.
 */
export const SHIPPED_DOCTRINE = `**You are deciding, not reviewing.** Somebody else has already looked at this page and said what is visibly wrong with it, and their findings are given to you. Your job is the question that follows: is this page worth rebuilding, is it worth fixing in places, or is it fine as it stands. Answer it the way somebody answers who will have to stand behind the answer when the invoice arrives.

**All three answers are real answers.** A page that is doing its job is a decision, and being willing to say so is the only thing that makes "this needs rebuilding" believable when you say it about the next one. Do not find fault in order to justify work. If the honest answer is that two changes would carry this page, say two changes — an owner is far more likely to buy a fix they believe in than a rebuild they suspect, and the fix they buy is the beginning of the relationship that sells the rebuild later.

**Judge the business, not the design.** "The type is inconsistent" is a critique. "A builder comparing three suppliers cannot tell from this screen whether you sell what he needs, so he goes back to the search results" is a reason to spend money. Every point has to end up somewhere the owner recognises: a customer lost, an enquiry never made, a comparison gone the wrong way, a company made to look smaller than it is.

**Does the page fit the business?** This is the judgement that lands hardest with an established firm and it is invisible in the markup: a serious manufacturer with a page that looks like a template from 2013, a clinic whose site looks like a blog, a wholesaler whose page could belong to any trade at all. Say what the gap is between what they are and what the page makes them look like.

**Be specific about what you can actually see.** "The photograph across the top is stretched out of shape, and nothing on that screen says what they make" is worth reading. "The design feels unprofessional" is an opinion, and a business owner rejects it on sight — rightly, because it is not checkable.

**Do not contradict the reviewer.** Their findings are in front of you and they were made from the same pictures. You may weigh them differently, and deciding that six small faults do not add up to a rebuild is exactly what you are for. You may not assert that something they observed is not there.`;

/**
 * The mechanics. Separate from the doctrine because an edit to the doctrine
 * must be able to change the judgement and must never be able to change the
 * shape of the answer — and because the plain-words rule on `summary` is the
 * one thing here a rewrite would silently drop, leaving "above the fold" in a
 * paragraph that goes into a proposal unedited.
 */
const CONTRACT = `The summary paragraph is lifted into a client document without being edited, so it may contain no web vocabulary whatsoever: no hero, above the fold, CTA, viewport, responsive, UX, conversion, bounce rate. If you would not say the word to a cement wholesaler across a desk, it does not appear in it.

Every issue you list must be one the owner could confirm in ten seconds by opening their own site.

British English. No exclamation marks. No "modern", "sleek", "user-friendly", "seamless" or "elevate" — say what is actually there.`;

function systemPrompt(
  brief: Awaited<ReturnType<typeof resolveBrief>>,
  business: { name: string; trade: string | null; town: string | null },
  views: ScreenshotView[],
): string {
  const preamble = `You are making the redesign call on one homepage — ${business.name}${business.trade ? `, ${business.trade}` : ""}${
    business.town ? ` in ${business.town}` : ""
  } — for Dakyworld, who would be the ones doing the work.

You are looking at ${
    views.length === 2
      ? "two screenshots of the same page: the first as it appears on a desktop browser at 1280px wide, the second as it appears on a phone at 390px wide"
      : `one screenshot of the page, taken at ${views[0] === "mobile" ? "phone width (390px)" : "desktop width (1280px)"}`
  }. ${views.includes("mobile") ? "Most of the people who will open this site are on the phone one." : ""}

**The pictures are the whole of your evidence.** They show the top of the page — roughly the first screen and a little of what follows. You may say nothing about a page you were not shown, about what happens when a button is pressed, about their prices or their booking system, and nothing at all about how fast the site loads or whether it is secure: those were measured separately by somebody else, and you have no evidence for any of them.

**The business is the one being served here, not Dakyworld.** A recommendation to rebuild a page that did not need rebuilding is the kind of thing that ends a firm's reputation in a town this size.`;

  return composeWriterSystem(brief, { preamble: [preamble], contract: CONTRACT });
}

/**
 * Reads the pictures and makes the call.
 *
 * `findings` is what the reviewers already established, handed over so this
 * cannot contradict them — see the note at the top of the file.
 */
export async function decideRedesign(
  evidence: AuditEvidence,
  business: { name: string; trade: string | null; town: string | null },
  findings: AuditFindingDetail[] = [],
): Promise<RedesignResult> {
  const notes: string[] = [];
  const shots = evidence.shots;

  if (!shots.length) {
    // The same rule the UI/UX section learned expensively: say what actually
    // happened, never what usually happens. Every reason there is no picture
    // already arrives as a sentence from the capture itself.
    const said = evidence.stepNotes.screenshots.filter((note) => note.trim());
    notes.push(
      said.length
        ? `No call was made on whether the page needs a redesign, because nobody has seen it. ${said.join(" ")}`
        : evidence.reachable
          ? "No call was made on whether the page needs a redesign: there is no picture of it, and that is not a decision to make from the markup."
          : "Their site could not be retrieved, so there was nothing to photograph and nothing to decide about.",
    );
    return { verdict: null, notes, costUsd: 0 };
  }

  // Resolved here rather than inside the prompt builder, because the name on
  // the brief is printed in the document as well as used to compose it.
  const brief = await resolveBrief("audit.redesign", SHIPPED_DOCTRINE);
  const views = shots.map((entry) => entry.view);
  const images: PromptImage[] = shots.map((entry) => ({
    base64: entry.result.base64!,
    mediaType: entry.result.shot!.mediaType,
  }));

  // Worst first, and only what was seen rather than measured. A decision about
  // how a page looks is not helped by a missing DMARC record, and handing it
  // one invites an argument from evidence it cannot see.
  const alreadyFound = findings
    .filter((finding) => finding.severity !== "GOOD")
    .slice(0, 10)
    .map((finding) => `- ${finding.title}: ${finding.observed}`);

  const facts = [
    `The business: ${business.name}`,
    business.trade ? `What they do, according to the record: ${business.trade}` : null,
    business.town ? `Where: ${business.town}` : null,
    evidence.finalUrl ? `The address photographed: ${evidence.finalUrl}` : null,
    ...shots.map(
      (entry, index) =>
        `Picture ${index + 1} — ${entry.view === "mobile" ? "phone, 390px wide" : "desktop, 1280px wide"}${
          entry.result.shot!.cropped ? ", showing the top of a longer page" : ", the whole page"
        }.`,
    ),
    alreadyFound.length
      ? `What the reviewer who read these same pictures already established. You are not being asked to repeat it, and you may not contradict it:\n${alreadyFound.join("\n")}`
      : null,
    "",
    "Make the call.",
  ].filter(Boolean);

  try {
    const result = await callModel<Omit<RedesignVerdict, "decidedBy" | "decidedAt" | "sources">>({
      purpose: "audit.redesign",
      job: "redesign",
      system: systemPrompt(brief, business, views),
      prompt: () => facts.join("\n"),
      images,
      schema: SCHEMA as unknown as Record<string, unknown>,
      effort: "medium",
      maxTokens: 4000,
      messages: {
        noKey:
          "No model is connected that can look at a picture, so no call was made on whether the page needs a redesign. Add a Perplexity, NVIDIA, ChatGPT, Claude or Gemini key under Settings → AI models.",
      },
    });

    const call = result.data.call;
    const verdict: RedesignVerdict = {
      call,
      headline: result.data.headline.trim(),
      assessment: result.data.assessment.trim(),
      issues: (result.data.issues ?? []).slice(0, MAX_ISSUES).map((issue) => ({
        area: issue.area,
        observed: issue.observed.trim(),
        // A model shown one picture will occasionally attribute a point to the
        // other one. Snapping it back to a view that exists beats dropping the
        // point, and beats printing "on a phone" in a report with no phone
        // picture in it.
        view: views.includes(issue.view) ? issue.view : views[0],
        costsThem: issue.costsThem.trim(),
      })),
      impact: {
        trust: result.data.impact.trust.trim(),
        usability: result.data.impact.usability.trim(),
        conversion: result.data.impact.conversion.trim(),
        howItFeels: result.data.impact.howItFeels.trim(),
      },
      // Emptied on LEAVE_IT rather than trusted. A model that has just decided
      // a page is fine and then lists five changes to it has answered both
      // ways, and the list is the half a reader acts on.
      direction:
        call === "LEAVE_IT" ? [] : (result.data.direction ?? []).slice(0, MAX_STEPS).map((step) => ({ change: step.change.trim(), why: step.why.trim() })),
      summary: result.data.summary.trim(),
      reviewer: brief.agentName ?? "UI/UX Designer",
      decidedBy: PROVIDERS[result.provider].name,
      decidedAt: new Date().toISOString(),
      sources: result.sources.map((source) => ({ title: source.title || source.url, url: source.url })).slice(0, 8),
    };

    if (result.fallbackNote) notes.push(result.fallbackNote);
    return { verdict, notes, costUsd: result.costUsd };
  } catch (err) {
    notes.push(`No call was made on whether the page needs a redesign: ${(err as Error).message}`);
    return { verdict: null, notes, costUsd: 0 };
  }
}

/** The call as a heading a person reads. */
export function callLabel(call: RedesignCall): string {
  if (call === "REBUILD") return "This page needs rebuilding";
  if (call === "TARGETED_FIXES") return "This page needs fixing in places, not rebuilding";
  return "This page does not need a redesign";
}
