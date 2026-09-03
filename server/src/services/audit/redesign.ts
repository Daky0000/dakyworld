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
 *
 * ## It has a scorecard now, and the scorecard is arithmetic
 *
 * It shipped unscored on 2 Sep 2026, on the argument that scoring the
 * conclusion would put "rebuild it" into the site's average as a fifth kind of
 * fault. That argument still holds and is still enforced — **this number never
 * reaches `overallScore`**, which remains the four disciplines and only them.
 * What changed is that "needs rebuilding" is an assertion an owner is entitled
 * to see the working for, and a paragraph is not working. Ten headings, each
 * scored out of a hundred and each carrying a fixed weight, are.
 *
 * Two properties make it worth having rather than decorative:
 *
 *  - **The model never sees or states the total.** It scores the ten headings;
 *    `weighApart()` multiplies and adds. A model asked for eleven numbers where
 *    the eleventh is a weighted mean of the other ten will produce eleven
 *    numbers, and the mean will be wrong often enough to be noticed by the one
 *    reader who checks — who is the owner, holding the invoice.
 *  - **The verdict has to be reachable from the score.** Judgement is why a
 *    model is asked rather than a spreadsheet, so it may move one band away
 *    from what the arithmetic alone would give. Two bands is not judgement, it
 *    is a document arguing with itself in public, and `agreeWithTheNumbers()`
 *    pulls it back and records that it did.
 */

/** The decision itself, which is the whole point of this section. */
export type RedesignCall =
  /** Fundamentally wrong — visual quality, hierarchy, credibility. Build it again. */
  | "REBUILD"
  /** Enough weakness that rebuilding significant parts of it is justified. */
  | "REDESIGN"
  /** The foundation is sound; named visual changes would carry it. */
  | "REFINE"
  /** It is doing its job. Saying so is what makes the other three believable. */
  | "LEAVE_IT";

/**
 * Worst first. The distance between two calls is what `agreeWithTheNumbers()`
 * measures, so the order is load-bearing rather than cosmetic.
 */
export const CALL_ORDER: RedesignCall[] = ["LEAVE_IT", "REFINE", "REDESIGN", "REBUILD"];

/**
 * Reports written before this section had four calls in it.
 *
 * `TARGETED_FIXES` was the middle of three and is `REFINE` now. Stored reports
 * are rendered on demand — the PDF is built from the row every time somebody
 * asks for it — so a renamed enum is not a migration, it is every old audit in
 * the database rendering a blank heading. Everything that reads a `call` off a
 * stored report goes through here.
 */
export function normaliseCall(value: string | null | undefined): RedesignCall {
  if (value === "TARGETED_FIXES") return "REFINE";
  return (CALL_ORDER as string[]).includes(value ?? "") ? (value as RedesignCall) : "REDESIGN";
}

/**
 * What the page is scored on, and what each heading is worth.
 *
 * Ten headings summing to a hundred, so the weight is also the number of points
 * a heading can contribute and the arithmetic can be printed without a reader
 * having to trust a divisor. **The weights live here and are never taken from
 * the model** — a weighted average whose weights the model chose is a total it
 * can move without changing a single judgement, which is the one way a
 * scorecard can be worse than no scorecard at all.
 *
 * The split is the conventional one for a page that has to sell something:
 * layout and overall visual quality carry the most because they are what a
 * stranger reacts to before reading a word, and imagery and the ask carry
 * least because a page can do both badly and still be recovered.
 */
export const CATEGORY_WEIGHTS = {
  VISUAL_DESIGN: 15,
  TYPOGRAPHY: 10,
  LAYOUT: 15,
  HIERARCHY: 10,
  NAVIGATION: 10,
  HERO: 10,
  BRANDING: 10,
  CONTENT: 10,
  IMAGERY: 5,
  CONVERSION: 5,
} as const;

export type RedesignCategory = keyof typeof CATEGORY_WEIGHTS;

export const CATEGORIES = Object.keys(CATEGORY_WEIGHTS) as RedesignCategory[];

/** The headings these print under. No web vocabulary in any of them. */
export const CATEGORY_NAMES: Record<RedesignCategory, string> = {
  VISUAL_DESIGN: "How it looks",
  TYPOGRAPHY: "Type and readability",
  LAYOUT: "Layout and spacing",
  HIERARCHY: "What the eye is led to",
  NAVIGATION: "Getting around it",
  HERO: "The first screen",
  BRANDING: "Whether it looks like one company",
  CONTENT: "How the writing is laid out",
  IMAGERY: "The pictures",
  CONVERSION: "Asking for the enquiry",
};

/**
 * What each heading actually covers, in the words the model is judged against.
 *
 * Written here rather than in the prompt string because the prompt is built
 * from this object: an edit to the weights or the headings changes what the
 * model is asked, in the same commit, with no second place to remember. A
 * scorecard whose definitions have drifted from its arithmetic is ten numbers
 * measuring something nobody wrote down.
 */
const CATEGORY_MEASURES: Record<RedesignCategory, string> = {
  VISUAL_DESIGN:
    "Overall look: polish, consistency, composition, balance, how considered it is, whether it looks like the work of somebody who was paid for it.",
  TYPOGRAPHY: "The lettering: which typefaces, heading sizes against body sizes, line length, line spacing, weight, contrast, whether it can comfortably be read.",
  LAYOUT: "Arrangement: the spacing between and inside sections, margins, alignment, column widths, empty space, and whether the page keeps a steady rhythm down the screen. Say plainly when a section is cramped or when a gap is so large the page looks unfinished.",
  HIERARCHY: "Whether the page decides for the visitor what to look at first, second and third, and whether the most important thing on it is also the most prominent.",
  NAVIGATION: "The bar across the top and everything about finding things: how the menu is organised, whether the important pages are in it, whether a phone number or an enquiry button is where a hand reaches for it, and how much work the visitor is made to do.",
  HERO: "The first screen: the headline, the line under it, the picture behind it, the button, the contrast between them, and whether a stranger knows within a second what is being offered.",
  BRANDING: "Whether the logo, the colours, the lettering and the pictures look like one company that chose them, and whether that company looks like a real, established one worth dealing with.",
  CONTENT: "How the writing is presented rather than what it says: how much of it there is, whether it is broken up, whether it can be skimmed, and the balance between words and everything else.",
  IMAGERY: "The photographs, illustrations and icons: their quality, whether they are relevant, whether they look like one set, how they are cropped and placed, and whether they help or hurt.",
  CONVERSION: "Whether the page asks for the business: a visible button or number, somewhere to make contact, and whatever is there to make a stranger believe them — reviews, client names, credentials, faces.",
};

/** How serious one observation is. */
export type RedesignSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** And whether it is worth anybody's money to correct. */
export type RedesignNecessity = "MUST_FIX" | "SHOULD_FIX" | "NICE_TO_HAVE";

export const SEVERITY_NAMES: Record<RedesignSeverity, string> = {
  CRITICAL: "Critical",
  HIGH: "Serious",
  MEDIUM: "Worth fixing",
  LOW: "Minor",
};

export const NECESSITY_NAMES: Record<RedesignNecessity, string> = {
  MUST_FIX: "Must be fixed",
  SHOULD_FIX: "Should be fixed",
  NICE_TO_HAVE: "Would be nice to improve",
};

/** How old the design looks, which is a different question from how good it is. */
export type RedesignEra = "MODERN" | "SLIGHTLY_DATED" | "CLEARLY_OUTDATED" | "EXTREMELY_OUTDATED";

export const ERA_NAMES: Record<RedesignEra, string> = {
  MODERN: "It looks current",
  SLIGHTLY_DATED: "It looks a little behind",
  CLEARLY_OUTDATED: "It clearly looks its age",
  EXTREMELY_OUTDATED: "It looks many years old",
};

/** Whether paying somebody to do the work would show. */
export type RedesignWorthAnswer = "YES" | "PROBABLY" | "MAYBE" | "NO";

export const WORTH_NAMES: Record<RedesignWorthAnswer, string> = {
  YES: "Yes",
  PROBABLY: "Probably",
  MAYBE: "Maybe",
  NO: "No",
};

export interface RedesignCategoryScore {
  category: RedesignCategory;
  /** 0-100 for this heading alone, and about the page as it stands rather than as it could be. */
  score: number;
  /** Out of a hundred across all ten. From `CATEGORY_WEIGHTS`, never from the model. */
  weight: number;
  /** `score × weight ÷ 100`, to one decimal place. Arithmetic, done here. */
  points: number;
  /** One or two sentences: what earned that number, from the picture. */
  reasoning: string;
}

export interface RedesignIssue {
  category: RedesignCategory;
  /** What exactly is wrong, in one line. */
  title: string;
  /** What is visibly the case in the picture, in the owner's words. Only ever from the picture. */
  observed: string;
  /** Which of the two pictures. */
  view: ScreenshotView;
  /** What it costs them. One sentence, concrete. */
  costsThem: string;
  severity: RedesignSeverity;
  necessity: RedesignNecessity;
}

/**
 * One part of the page, read top to bottom.
 *
 * The name is the model's own rather than an enum, and that is deliberate: a
 * fixed list of eight headings is an invitation to review a team section on a
 * page that has no team on it, which is the one failure this whole section
 * cannot survive — a document sent to somebody who knows their own website.
 */
export interface RedesignSectionReview {
  /** The part of the page as a person would refer to it: "the bar across the top", "the footer". */
  name: string;
  view: ScreenshotView;
  works: string;
  doesNotWork: string;
  severity: RedesignSeverity;
  /** Whether this part in particular would have to be built again. */
  needsRebuilding: boolean;
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

/**
 * The five-second test: what a stranger takes off the page before they decide
 * whether to stay.
 *
 * Scored on its own and never folded into the weighted total. It is a
 * different measurement — the ten headings ask how well the page is made, this
 * asks whether it works at the only speed it is ever actually used at — and
 * averaging the two would hide the case that matters most, which is a
 * handsome page that says nothing.
 */
export interface RedesignFirstLook {
  /** 0-100 on its own. */
  score: number;
  whoTheyAre: boolean;
  whatTheyDo: boolean;
  whyItMatters: boolean;
  whyBelieveThem: boolean;
  whatToDoNext: boolean;
  explanation: string;
}

export interface RedesignStanding {
  /** Whether it looks like an established business of this kind. */
  looksEstablished: boolean;
  /** Measured against what this trade's customers expect to see. */
  assessment: string;
  /** What makes it look cheap, dated or amateur. Empty when nothing does. */
  whatUnderminesIt: string[];
}

export interface RedesignAge {
  era: RedesignEra;
  /** Which visual characteristics create that impression. Never "it needs animations". */
  why: string;
}

export interface RedesignProblem {
  problem: string;
  whyItMatters: string;
  /** What in the picture says so. */
  evidence: string;
  severity: RedesignSeverity;
}

export interface RedesignStrength {
  strength: string;
  /** Why it is worth keeping if the page is built again. */
  why: string;
}

export interface RedesignWorthIt {
  answer: RedesignWorthAnswer;
  why: string;
}

export interface RedesignBottomLine {
  /** What the design is, as it stands. One paragraph. */
  quality: string;
  /** The single strongest reason to spend the money, or the strongest reason not to. */
  biggestReason: string;
  /** The best thing about it. */
  biggestStrength: string;
  /** Said straight to the owner. No diplomacy. */
  recommendation: string;
}

export interface RedesignStep {
  /** The change, in one line. */
  change: string;
  /** Why that one, and why in this position. */
  why: string;
}

export interface RedesignVerdict {
  call: RedesignCall;
  /**
   * 0-100 for the page as it stands. Computed here from `scores`, never
   * supplied by the model.
   *
   * Optional because reports written before the scorecard existed have no such
   * field, and there is nothing to infer from that absence but its date.
   */
  score?: number;
  /** The ten headings, in the order they are weighted. Absent on older reports. */
  scores?: RedesignCategoryScore[];
  /**
   * The call the arithmetic alone would have given.
   *
   * Kept beside the real one so a reader can see where judgement moved it,
   * which it is allowed to do by one band. Absent on older reports.
   */
  scoreCall?: RedesignCall;
  /**
   * Set when the verdict was pulled back to agree with the score, saying what
   * was moved and to what.
   *
   * **Shown on the internal screen and nowhere else.** It is a fact about how
   * this report was produced, not a finding about somebody's website, and a
   * client-facing PDF that footnotes its own decider is a PDF that reads as
   * though nobody stood behind the verdict.
   */
  adjusted?: string | null;
  /** One sentence: the call, said the way it would be said out loud. */
  headline: string;
  /** Two or three sentences behind the call. */
  assessment: string;
  issues: RedesignIssue[];
  /** The page read top to bottom. Absent on older reports. */
  sections?: RedesignSectionReview[];
  impact: RedesignImpact;
  /** The five-second test. Absent on older reports. */
  firstLook?: RedesignFirstLook;
  /** Whether it looks like a real firm of this kind. Absent on older reports. */
  standing?: RedesignStanding;
  /** How old it looks. Absent on older reports. */
  age?: RedesignAge;
  /** The worst of it, worst first. Absent on older reports. */
  problems?: RedesignProblem[];
  /** What is already good and should survive a rebuild. Absent on older reports. */
  strengths?: RedesignStrength[];
  /** Whether paying for the work would show. Absent on older reports. */
  worthIt?: RedesignWorthIt;
  /** What a redesign should change, in order. Empty when the call is LEAVE_IT. */
  direction: RedesignStep[];
  /** The closing summary, said to the owner. Absent on older reports. */
  bottomLine?: RedesignBottomLine;
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

const MAX_ISSUES = 10;
const MAX_SECTIONS = 10;
const MAX_PROBLEMS = 10;
const MAX_STRENGTHS = 6;
const MAX_STEPS = 5;

// --- The arithmetic ----------------------------------------------------------

/** 0-100, whatever the model said. A score outside the range is a typo, not an opinion. */
function clampScore(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

/**
 * The ten headings, weighted, into one number.
 *
 * Every heading is present whether or not the model returned it: a category
 * silently dropped is a total quietly computed over nine, and nine headings
 * out of ten is the same defect the discipline scores already learned the hard
 * way — a number describing part of something is a different claim, not a
 * smaller one. A missing heading scores zero and says so in its own row, which
 * a reader can see and argue with.
 */
export function weighApart(given: { category: string; score: unknown; reasoning?: unknown }[]): {
  scores: RedesignCategoryScore[];
  score: number;
} {
  const byCategory = new Map(given.map((entry) => [entry.category, entry]));
  const scores = CATEGORIES.map((category) => {
    const entry = byCategory.get(category);
    const weight = CATEGORY_WEIGHTS[category];
    const score = entry ? clampScore(entry.score) : 0;
    return {
      category,
      score,
      weight,
      points: Math.round(((score * weight) / 100) * 10) / 10,
      reasoning: entry && typeof entry.reasoning === "string" && entry.reasoning.trim() ? entry.reasoning.trim() : "This was not scored, so it counts as nothing.",
    };
  });

  return { scores, score: Math.round(scores.reduce((total, row) => total + (row.score * row.weight) / 100, 0)) };
}

/**
 * The band a score alone puts a page in.
 *
 * These are the same thresholds the model is given in the contract, and they
 * are here rather than only in the prompt because they are enforced: the
 * contract states them so the model can aim at them, this decides what
 * happened.
 */
export function callForScore(score: number): RedesignCall {
  if (score >= 80) return "LEAVE_IT";
  if (score >= 70) return "REFINE";
  if (score >= 60) return "REDESIGN";
  return "REBUILD";
}

/**
 * The word that goes beside the number.
 *
 * One place, because it is printed on three surfaces and a page that reads
 * "62/100 — Strong" in the PDF and "62/100 — Average" on the screen is a
 * document nobody can quote from. The bands are the ones stated in the
 * contract, so what the model was aiming at and what the reader is told are
 * the same six sentences.
 */
export function scoreBand(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 80) return "Strong";
  if (score >= 70) return "Good";
  if (score >= 60) return "Average";
  if (score >= 40) return "Weak";
  return "Poor";
}

/**
 * Below this, a redesign is needed and the verdict has to say so.
 *
 * The founder's rule, and the one place judgement is not allowed to move the
 * answer. Everything from 70 up is a matter of opinion about a page that is
 * basically working; below it the scorecard is describing a page with several
 * real problems in it, and "sharpen it" is then a sentence that costs a
 * business money — they buy the smaller job, the smaller job does not fix what
 * was wrong, and what failed is Dakyworld.
 */
export const REDESIGN_FLOOR = 70;

/**
 * Keeps the verdict within reach of the working.
 *
 * A model is asked for a verdict rather than told to read one off a table
 * because there are pages the arithmetic gets wrong — a tidy, well-spaced,
 * perfectly typeset page that never says what the company sells scores in the
 * seventies and needs rebuilding — so **one band of disagreement is allowed
 * and is the point of asking**. Two is not a judgement, it is a document whose
 * verdict and whose scorecard argue with each other in front of the person
 * paying for it, and the half a reader can check is the arithmetic.
 *
 * **The latitude does not reach downwards across `REDESIGN_FLOOR`.** One band
 * would otherwise let a page scoring 65 be answered "needs sharpening, not
 * rebuilding", which is the one direction the error is expensive in: an owner
 * who buys the smaller job on that advice has bought something that will not
 * work. Harshness inside one band is left alone — a page at 65 called a
 * rebuild has seen something the ten headings do not measure, which is exactly
 * what a model is being asked for. Two bands is still two bands in either
 * direction: a scorecard in the high eighties under the word "rebuild" is a
 * document arguing with itself just as loudly as the reverse.
 */
export function agreeWithTheNumbers(said: RedesignCall, score: number): { call: RedesignCall; adjusted: string | null } {
  const fromScore = callForScore(score);
  const distance = Math.abs(CALL_ORDER.indexOf(said) - CALL_ORDER.indexOf(fromScore));

  if (distance > 1) {
    return {
      call: fromScore,
      adjusted: `The decider answered "${callLabel(said)}" over a scorecard of ${score}/100, which is two steps from what those scores add up to. The verdict was moved to "${callLabel(fromScore)}" to match its own working.`,
    };
  }

  if (score < REDESIGN_FLOOR && (said === "LEAVE_IT" || said === "REFINE")) {
    return {
      call: "REDESIGN",
      adjusted: `The decider answered "${callLabel(said)}" over a scorecard of ${score}/100. Anything under ${REDESIGN_FLOOR} is a page with real problems in it, so the verdict was raised to "${callLabel("REDESIGN")}".`,
    };
  }

  return { call: said, adjusted: null };
}

// --- What it is asked --------------------------------------------------------

/**
 * How the call is made. Overridable by the agent that owns it — the UI/UX
 * Designer, whose one listed skill this is: knowing when to refine and when to
 * replace.
 */
export const SHIPPED_DOCTRINE = `**You are deciding, not reviewing, and you are certainly not redesigning.** Somebody else has already looked at this page and said what is visibly wrong with it, and their findings are given to you. Your job is the question that follows: is this page worth rebuilding, is it worth fixing in places, or is it fine as it stands. Answer it the way somebody answers who will have to stand behind the answer when the invoice arrives. Do not design a replacement, do not describe a new layout, and do not write instructions for building one — a decision that arrives with the new page already sketched is a decision nobody made.

**Score the page in front of you, not the page it could become.** Every number you give is about the site as it stands today. A page does not earn a good score for working: it earns one for being well made. Do not inflate. Most sites are not excellent, and a scorecard that says they are is one nobody will believe the second time.

**All four answers are real answers.** A page that is doing its job is a decision, and being willing to say so is the only thing that makes "this needs rebuilding" believable when you say it about the next one. Do not find fault in order to justify work. If the honest answer is that two changes would carry this page, say two changes — an owner is far more likely to buy a fix they believe in than a rebuild they suspect, and the fix they buy is the beginning of the relationship that sells the rebuild later.

**Judge the business, not the design.** "The type is inconsistent" is a critique. "A builder comparing three suppliers cannot tell from this screen whether you sell what he needs, so he goes back to the search results" is a reason to spend money. Every point has to end up somewhere the owner recognises: a customer lost, an enquiry never made, a comparison gone the wrong way, a company made to look smaller than it is.

**Does the page fit the business?** This is the judgement that lands hardest with an established firm and it is invisible in the markup: a serious manufacturer with a page that looks like a template from 2013, a clinic whose site looks like a blog, a wholesaler whose page could belong to any trade at all. Hold it to what a customer of *this* trade expects to see — a law firm, a private clinic and a scaffolder are not judged by one standard — and say what the gap is between what they are and what the page makes them look like.

**Be specific about what you can actually see.** "The photograph across the top is stretched out of shape, and nothing on that screen says what they make" is worth reading. "The design feels unprofessional" is an opinion, and a business owner rejects it on sight — rightly, because it is not checkable.

**Modern is not a pile of effects.** Judge how current a page looks by its lettering, its spacing, its composition, its restraint and how it treats its pictures — never by whether it has animation, gradients, glass panels or whatever is fashionable. Recommending an effect is how an audit gives itself away. And do not credit a page for having many sections: a long page of weak sections is a weak page.

**Judge how the words are presented, not whether they are true.** Whether their claims are accurate is somebody else's job. Yours is whether there is too much text, whether it can be skimmed, and whether it looks like anybody laid it out on purpose.

**Do not contradict the reviewer.** Their findings are in front of you and they were made from the same pictures. You may weigh them differently, and deciding that six small faults do not add up to a rebuild is exactly what you are for. You may not assert that something they observed is not there.`;

/**
 * The mechanics. Separate from the doctrine because an edit to the doctrine
 * must be able to change the judgement and must never be able to change the
 * shape of the answer — and because the plain-words rule on `summary` is the
 * one thing here a rewrite would silently drop, leaving "above the fold" in a
 * paragraph that goes into a proposal unedited.
 */
const CONTRACT = `You give a score out of 100 for each of the ten headings below and nothing else about the arithmetic. **The overall score is worked out from those ten and their fixed weights, after you answer. Do not calculate it, do not state it, and never refer to a total you have not been given.**

What a score means, and it means the same for one heading as it does for the whole page:

- 90-100 — excellent. Polished, considered, effective. Nothing here needs redoing.
- 80-89 — strong. Good, with places that could be sharpened. Work here is optional.
- 70-79 — good. Usable and reasonably professional, with real weaknesses.
- 60-69 — average. Several problems that cost them professionalism, ease of use or enquiries.
- 40-59 — weak. Substantial problems with how it looks, how it is used, or how it presents what is on it.
- 0-39 — poor. Badly out of date, badly built, or wrong for what it is for.

Your verdict must be one a reader could arrive at from your own scores. Those totals land as: 80 and above, no redesign needed; 70-79, a light visual refinement; 60-69, a redesign is justified; below 60, a major rebuild. **You may sit one step away from that** — a page can be well made and still fail at the only job it has, and saying so is why you are being asked rather than a spreadsheet. You may not sit two steps away from it.

**One line is not a matter of opinion: if the ten headings put this page under 70, it needs redesigning.** You may still say it needs rebuilding outright. You may not say it is fine or that sharpening would carry it, however the page strikes you — under 70 is a page with several real problems in it, and an owner who is told to buy the smaller job on that advice has bought something that will not work.

Never review a part of the page you cannot see. If there is no team, no client logos, no reviews and no footer in the picture, the page has none, and you say so — you never assess one you were not shown.

The summary paragraph is lifted into a client document without being edited, so it may contain no web vocabulary whatsoever: no hero, above the fold, CTA, viewport, responsive, UX, conversion, bounce rate. If you would not say the word to a cement wholesaler across a desk, it does not appear in it.

Every issue you list must be one the owner could confirm in ten seconds by opening their own site.

British English. No exclamation marks. No "modern", "sleek", "user-friendly", "seamless" or "elevate" — say what is actually there.`;

/**
 * The ten headings, with their weights, written out of the same object the
 * arithmetic uses.
 *
 * Generated rather than typed out so that changing a weight changes what the
 * model is asked in the same edit. The weights are shown to it because a
 * heading worth fifteen points deserves more thought than one worth five, and
 * a model that does not know which is which spends the same care on both.
 */
function scorecardBlock(): string {
  const rows = CATEGORIES.map((category) => `- **${CATEGORY_NAMES[category]}** (\`${category}\`, worth ${CATEGORY_WEIGHTS[category]} of the 100). ${CATEGORY_MEASURES[category]}`);
  return [`The ten headings, and what each is worth of the hundred:`, "", ...rows].join("\n");
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "call",
    "scores",
    "headline",
    "assessment",
    "issues",
    "sections",
    "impact",
    "firstLook",
    "standing",
    "age",
    "problems",
    "strengths",
    "worthIt",
    "direction",
    "bottomLine",
    "summary",
  ],
  properties: {
    call: {
      type: "string",
      enum: ["REBUILD", "REDESIGN", "REFINE", "LEAVE_IT"],
      description:
        "LEAVE_IT — the page is doing its job and there is no honest case for spending money on it. REFINE — the foundation is sound and named visual changes would noticeably improve it. REDESIGN — there is enough wrong that rebuilding significant parts of it is justified. REBUILD — the page is fundamentally wrong for the business and should be built again.",
    },
    scores: {
      type: "array",
      description:
        "All ten headings, every one of them, once each. Score the page as it stands, not as it could be. Do not add a total: it is worked out from these.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "score", "reasoning"],
        properties: {
          category: { type: "string", enum: [...CATEGORIES], description: "Which heading. Each exactly once." },
          score: { type: "integer", description: "0 to 100 for this heading alone." },
          reasoning: { type: "string", description: "One or two sentences saying what earned that number, from what is in the picture." },
        },
      },
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
      description: "At most 10, worst first. One entry per thing that is genuinely wrong. Do not invent one for a heading that is fine.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "title", "observed", "view", "costsThem", "severity", "necessity"],
        properties: {
          category: { type: "string", enum: [...CATEGORIES], description: "Which of the ten headings this pulled down." },
          title: { type: "string", description: "What exactly is wrong, in one line." },
          observed: { type: "string", description: "What is visibly the case in the picture, in words the owner would use. Never a claim about a page you were not shown." },
          view: { type: "string", enum: ["desktop", "mobile"], description: "Which of the pictures this is about." },
          costsThem: { type: "string", description: "What it costs them: a visitor who leaves, an enquiry never made, a comparison lost. One sentence, no adjectives." },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], description: "How much damage it does." },
          necessity: { type: "string", enum: ["MUST_FIX", "SHOULD_FIX", "NICE_TO_HAVE"], description: "Whether correcting it is necessary, advisable, or an improvement they could live without." },
        },
      },
    },
    sections: {
      type: "array",
      description:
        "The page read top to bottom, at most 10 parts, in the order they appear. Only parts that are actually in the picture — the bar across the top, the first screen, what follows it, the footer, and so on. Give each its own name as a person would say it. If the picture shows only the top of the page, review only what it shows.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "view", "works", "doesNotWork", "severity", "needsRebuilding"],
        properties: {
          name: { type: "string", description: "What this part of the page is, in plain words: \"the bar across the top\", \"the row of services\", \"the footer\"." },
          view: { type: "string", enum: ["desktop", "mobile"], description: "Which picture you are describing it from." },
          works: { type: "string", description: "What is right about it. If nothing is, say so in one short sentence rather than inventing something." },
          doesNotWork: { type: "string", description: "What is wrong with it, specifically. Empty string if nothing is." },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], description: "How bad this part is. LOW when it is basically fine." },
          needsRebuilding: { type: "boolean", description: "Whether this part in particular would have to be built again rather than adjusted." },
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
    firstLook: {
      type: "object",
      additionalProperties: false,
      required: ["score", "whoTheyAre", "whatTheyDo", "whyItMatters", "whyBelieveThem", "whatToDoNext", "explanation"],
      description: "Five seconds on this page and nothing else. Answer each as true only if a stranger would actually have it, not if it is somewhere on the page.",
      properties: {
        score: { type: "integer", description: "0 to 100 for how much a stranger takes off this page in five seconds. Scored on its own; it is not part of the ten." },
        whoTheyAre: { type: "boolean", description: "Can they tell whose website this is?" },
        whatTheyDo: { type: "boolean", description: "Can they tell what the business does?" },
        whyItMatters: { type: "boolean", description: "Can they tell why they should care — what is in it for them?" },
        whyBelieveThem: { type: "boolean", description: "Is there anything making the business look credible?" },
        whatToDoNext: { type: "boolean", description: "Is it obvious what they are meant to do next?" },
        explanation: { type: "string", description: "Two or three sentences on what a stranger walks away with, and what they do not." },
      },
    },
    standing: {
      type: "object",
      additionalProperties: false,
      required: ["looksEstablished", "assessment", "whatUnderminesIt"],
      description: "Whether it looks like a real firm of this kind, judged against what a customer of this trade expects.",
      properties: {
        looksEstablished: { type: "boolean", description: "Would a stranger take this for an established business worth dealing with?" },
        assessment: { type: "string", description: "Two or three sentences: does it look credible, maintained, and worth the money this trade charges — and if not, what gives it away." },
        whatUnderminesIt: { type: "array", description: "What makes it look cheap, dated or amateur. An empty list when nothing does.", items: { type: "string" } },
      },
    },
    age: {
      type: "object",
      additionalProperties: false,
      required: ["era", "why"],
      description: "How old the design looks. A different question from how good it is.",
      properties: {
        era: { type: "string", enum: ["MODERN", "SLIGHTLY_DATED", "CLEARLY_OUTDATED", "EXTREMELY_OUTDATED"], description: "How current it looks." },
        why: {
          type: "string",
          description:
            "Which visual characteristics create that impression — the lettering, the spacing, the composition, how the pictures are treated. Never name an effect it is missing.",
        },
      },
    },
    problems: {
      type: "array",
      description: "The biggest problems with this page, at most 10, most important first. These are the same faults as above, ranked and said at the level an owner would repeat them.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["problem", "whyItMatters", "evidence", "severity"],
        properties: {
          problem: { type: "string", description: "The problem in one line." },
          whyItMatters: { type: "string", description: "What it costs the business." },
          evidence: { type: "string", description: "What in the picture says so." },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], description: "How serious." },
        },
      },
    },
    strengths: {
      type: "array",
      description:
        "At least 3, at most 6: what is genuinely good about this page and should survive if it is built again. Only things visibly true in the picture — never a compliment you cannot point at.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["strength", "why"],
        properties: {
          strength: { type: "string", description: "What is good, in one line." },
          why: { type: "string", description: "Why it is worth keeping." },
        },
      },
    },
    worthIt: {
      type: "object",
      additionalProperties: false,
      required: ["answer", "why"],
      description: "If they paid a professional to do this work, would the improvement be big enough to be worth it?",
      properties: {
        answer: { type: "string", enum: ["YES", "PROBABLY", "MAYBE", "NO"], description: "The honest answer, including NO when the page does not need the money spent on it." },
        why: { type: "string", description: "Two or three sentences. What they would get for it, or why they would be paying for very little." },
      },
    },
    direction: {
      type: "array",
      description: "The five things to do, at most, in the order they should be done. An empty list when the call is LEAVE_IT.",
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
    bottomLine: {
      type: "object",
      additionalProperties: false,
      required: ["quality", "biggestReason", "biggestStrength", "recommendation"],
      description: "The close. Written to the owner, honestly, with no diplomacy in it.",
      properties: {
        quality: { type: "string", description: "One paragraph on what the design is, as it stands." },
        biggestReason: { type: "string", description: "One paragraph: the single strongest reason to spend the money — or, if the page is fine, the strongest reason not to." },
        biggestStrength: { type: "string", description: "One paragraph on the best thing about the page." },
        recommendation: {
          type: "string",
          description:
            "Two or three sentences straight to the owner. If the page is genuinely good, say a redesign would not be justified. If it is poor, say plainly that it is. Do not soften it to be pleasant.",
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

function systemPrompt(
  brief: Awaited<ReturnType<typeof resolveBrief>>,
  business: { name: string; trade: string | null; town: string | null },
  views: ScreenshotView[],
): string {
  const preamble = `You are making the redesign call on one homepage — ${business.name}${business.trade ? `, ${business.trade}` : ""}${
    business.town ? ` in ${business.town}` : ""
  } — for Dakyworld, who would be the ones doing the work. Assess it as a senior designer, a conversion specialist and a brand strategist would between them, and answer one question: does this page need rebuilding.

You are looking at ${
    views.length === 2
      ? "two screenshots of the same page: the first as it appears on a desktop browser at 1280px wide, the second as it appears on a phone at 390px wide"
      : `one screenshot of the page, taken at ${views[0] === "mobile" ? "phone width (390px)" : "desktop width (1280px)"}`
  }. ${views.includes("mobile") ? "Most of the people who will open this site are on the phone one." : ""} Each picture is described below, including whether it is the whole page or only the top of a longer one.

**The pictures are the whole of your evidence.** You may say nothing about a page you were not shown, about what happens when a button is pressed, about their prices or their booking system, and nothing at all about how fast the site loads, how findable it is, or whether it is secure: those were measured separately by somebody else, and you have no evidence for any of them.

**The business is the one being served here, not Dakyworld.** A recommendation to rebuild a page that did not need rebuilding is the kind of thing that ends a firm's reputation in a town this size.`;

  return composeWriterSystem(brief, { preamble: [preamble], contract: [CONTRACT, scorecardBlock()].join("\n\n") });
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
    "Score it, then make the call.",
  ].filter(Boolean);

  try {
    const result = await callModel<{
      call: RedesignCall;
      scores: { category: RedesignCategory; score: number; reasoning: string }[];
      headline: string;
      assessment: string;
      issues: RedesignIssue[];
      sections: RedesignSectionReview[];
      impact: RedesignImpact;
      firstLook: RedesignFirstLook;
      standing: RedesignStanding;
      age: RedesignAge;
      problems: RedesignProblem[];
      strengths: RedesignStrength[];
      worthIt: RedesignWorthIt;
      direction: RedesignStep[];
      bottomLine: RedesignBottomLine;
      summary: string;
    }>({
      purpose: "audit.redesign",
      job: "redesign",
      system: systemPrompt(brief, business, views),
      prompt: () => facts.join("\n"),
      images,
      schema: SCHEMA as unknown as Record<string, unknown>,
      effort: "high",
      // Ten scored headings, ten faults, the page read top to bottom and four
      // closing paragraphs. The old ceiling was 4000 for a fifth of this, and a
      // truncated answer here costs a second call to a vendor that has already
      // been shown two photographs.
      maxTokens: 9000,
      messages: {
        noKey:
          "No model is connected that can look at a picture, so no call was made on whether the page needs a redesign. Add a Perplexity, NVIDIA, ChatGPT, Claude or Gemini key under Settings → AI models.",
      },
    });

    const { scores, score } = weighApart(result.data.scores ?? []);
    const { call, adjusted } = agreeWithTheNumbers(normaliseCall(result.data.call), score);

    // A model shown one picture will occasionally attribute a point to the
    // other one. Snapping it back to a view that exists beats dropping the
    // point, and beats printing "on a phone" in a report with no phone
    // picture in it.
    const seenView = (view: ScreenshotView) => (views.includes(view) ? view : views[0]);

    const verdict: RedesignVerdict = {
      call,
      score,
      scores,
      scoreCall: callForScore(score),
      adjusted,
      headline: result.data.headline.trim(),
      assessment: result.data.assessment.trim(),
      issues: (result.data.issues ?? []).slice(0, MAX_ISSUES).map((issue) => ({
        category: issue.category,
        title: issue.title.trim(),
        observed: issue.observed.trim(),
        view: seenView(issue.view),
        costsThem: issue.costsThem.trim(),
        severity: issue.severity,
        necessity: issue.necessity,
      })),
      sections: (result.data.sections ?? []).slice(0, MAX_SECTIONS).map((section) => ({
        name: section.name.trim(),
        view: seenView(section.view),
        works: section.works.trim(),
        doesNotWork: section.doesNotWork.trim(),
        severity: section.severity,
        needsRebuilding: section.needsRebuilding === true,
      })),
      impact: {
        trust: result.data.impact.trust.trim(),
        usability: result.data.impact.usability.trim(),
        conversion: result.data.impact.conversion.trim(),
        howItFeels: result.data.impact.howItFeels.trim(),
      },
      firstLook: {
        score: clampScore(result.data.firstLook?.score),
        whoTheyAre: result.data.firstLook?.whoTheyAre === true,
        whatTheyDo: result.data.firstLook?.whatTheyDo === true,
        whyItMatters: result.data.firstLook?.whyItMatters === true,
        whyBelieveThem: result.data.firstLook?.whyBelieveThem === true,
        whatToDoNext: result.data.firstLook?.whatToDoNext === true,
        explanation: (result.data.firstLook?.explanation ?? "").trim(),
      },
      standing: {
        looksEstablished: result.data.standing?.looksEstablished === true,
        assessment: (result.data.standing?.assessment ?? "").trim(),
        whatUnderminesIt: (result.data.standing?.whatUnderminesIt ?? []).map((entry) => entry.trim()).filter(Boolean),
      },
      age: { era: result.data.age?.era ?? "SLIGHTLY_DATED", why: (result.data.age?.why ?? "").trim() },
      problems: (result.data.problems ?? []).slice(0, MAX_PROBLEMS).map((problem) => ({
        problem: problem.problem.trim(),
        whyItMatters: problem.whyItMatters.trim(),
        evidence: problem.evidence.trim(),
        severity: problem.severity,
      })),
      strengths: (result.data.strengths ?? []).slice(0, MAX_STRENGTHS).map((entry) => ({ strength: entry.strength.trim(), why: entry.why.trim() })),
      worthIt: { answer: result.data.worthIt?.answer ?? "MAYBE", why: (result.data.worthIt?.why ?? "").trim() },
      // Emptied on LEAVE_IT rather than trusted. A model that has just decided
      // a page is fine and then lists five changes to it has answered both
      // ways, and the list is the half a reader acts on.
      direction:
        call === "LEAVE_IT" ? [] : (result.data.direction ?? []).slice(0, MAX_STEPS).map((step) => ({ change: step.change.trim(), why: step.why.trim() })),
      bottomLine: {
        quality: (result.data.bottomLine?.quality ?? "").trim(),
        biggestReason: (result.data.bottomLine?.biggestReason ?? "").trim(),
        biggestStrength: (result.data.bottomLine?.biggestStrength ?? "").trim(),
        recommendation: (result.data.bottomLine?.recommendation ?? "").trim(),
      },
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
  if (call === "REBUILD") return "This page should be built again";
  if (call === "REDESIGN") return "This page needs redesigning";
  if (call === "REFINE") return "This page needs sharpening, not rebuilding";
  return "This page does not need a redesign";
}

/**
 * The heading for one of the ten, tolerant of what older reports stored.
 *
 * Before the scorecard, issues carried an `area` from a nine-value list of
 * their own — an overlapping vocabulary for the same nine ideas, which is one
 * vocabulary too many. The old values are mapped rather than dropped: a stored
 * audit is rendered from its row every time somebody opens the PDF, and an
 * unmapped key renders a blank heading over a real observation.
 */
export function categoryName(value: string): string {
  if (value in CATEGORY_NAMES) return CATEGORY_NAMES[value as RedesignCategory];
  const legacy: Record<string, RedesignCategory> = {
    CALL_TO_ACTION: "CONVERSION",
    MOBILE: "LAYOUT",
    CREDIBILITY: "BRANDING",
    DATED: "VISUAL_DESIGN",
  };
  const mapped = legacy[value];
  return mapped ? CATEGORY_NAMES[mapped] : "Something else";
}
