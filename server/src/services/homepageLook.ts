import { callModel } from "../lib/models/call.js";
import { PROVIDERS } from "../lib/models/registry.js";
import { captureHomepage, type Screenshot } from "./siteShot.js";
import type { CompanyAudit } from "./companyAudit.js";

/**
 * What their homepage looks like, judged from a picture of it.
 *
 * This is the half of a site review that markup cannot reach. `companyAudit`
 * can tell you a page has a viewport tag; only looking tells you the hero
 * image is a stock photograph of a handshake, that the logo is a low-resolution
 * JPEG with a white box around it, or that nothing on the first screen says
 * what the business actually sells. Those are the observations a prospect
 * recognises immediately, because they have privately suspected all three.
 *
 * The rules the prompt enforces are the same three that hold everywhere else
 * in this system:
 *
 *  - **Only what is in the picture.** No claims about pages that were not
 *    shown, about their booking system, or about how the site performs. The
 *    model is told the screenshot is the whole of its evidence.
 *  - **Say when there is nothing to say.** A homepage that is genuinely fine
 *    is a real answer, and reporting it honestly is what makes the criticism
 *    credible when there is some.
 *  - **Every observation has to be one the owner can check by opening their
 *    own site.** An observation they cannot verify in ten seconds is an
 *    opinion, and it reads as one.
 */

export interface HomepageObservation {
  /** What is visibly true, in words the owner would use. */
  observed: string;
  /** Why it costs them something. One sentence, concrete, no adjectives. */
  soWhat: string;
  /**
   * The same point as somebody would say it across a desk, with no technical
   * word in it at all. This is the sentence that goes in the email — the owner
   * is not a developer and does not care what a hero section is.
   */
  plainly: string;
  /** Where on the page — "the hero", "the top navigation", "the first screen". */
  where: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "GOOD";
}

/**
 * The judgement a business owner is actually paying for.
 *
 * Not "your h1 is missing" — "your site looks like it belongs to a much
 * smaller company than you are, and the distributors comparing you to two
 * competitors see that first." A decision-maker spends money on a problem
 * stated in those terms and on no others.
 */
export interface WorthFixing {
  /** The problem, in one sentence, with no technical vocabulary. */
  problem: string;
  /** What it costs them — customers, enquiries, credibility, the comparison. */
  costsThem: string;
  /** Why it is worth spending money on rather than living with. */
  whyWorthPaying: string;
}

/**
 * What the page states about the business, read off the page itself.
 *
 * Separate from the judgement above because it is a different kind of claim: a
 * trade printed on a homepage is evidence, not an opinion, and it is better
 * evidence than anything a search infers. This is what lets a look fill in the
 * blanks a scrape left — the em-dashes against Category and Location.
 */
export interface HomepageStates {
  /** The trade in the page's own words — "Dental clinic", "Fabric wholesaler". */
  trade: string | null;
  /** The town or city named on the page. */
  town: string | null;
  /** What they say they offer. At most six, in their words. */
  services: string[];
  /** A phone number printed on the page, exactly as written. */
  phone: string | null;
}

export interface HomepageLook {
  /** The five-second test: what a visitor can tell about this business. */
  firstImpression: string;
  /** Whether the page says what they sell, at all, above the fold. */
  offerClear: boolean;
  /** Whether a visitor can see how to make contact without scrolling. */
  contactClear: boolean;
  /** Roughly when this design is from, and what gives it away. */
  looksDated: string | null;
  /**
   * Whether the page looks like it belongs to a business of this kind and this
   * size. The most damaging thing a site can do to an established company is
   * make it look smaller than it is, and it is invisible from the markup.
   */
  fitsTheBusiness: boolean;
  fitNote: string;
  /** How the page behaves for somebody on a phone on a slow connection. */
  speed: string | null;
  observations: HomepageObservation[];
  /** The case for spending money, in the owner's own terms. */
  worthFixing: WorthFixing;
  /** The one thing worth putting in an email, chosen by the model that looked. */
  theOneThing: string;
  /** What the page states about the business, as opposed to how it looks. */
  states: HomepageStates;
  /** Who did the looking, since the fallback may have. */
  lookedBy: string;
}

export interface LookResult {
  look: HomepageLook | null;
  shot: Screenshot | null;
  /** Why there is no look, or what was cut from the picture. Never a failure. */
  notes: string[];
  costUsd: number;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "firstImpression",
    "offerClear",
    "contactClear",
    "looksDated",
    "fitsTheBusiness",
    "fitNote",
    "speed",
    "observations",
    "worthFixing",
    "theOneThing",
    "states",
  ],
  properties: {
    firstImpression: {
      type: "string",
      description:
        "Two or three sentences: what a stranger who has never heard of this business can tell about it from this screen alone. Describe what is there, not what is missing.",
    },
    offerClear: {
      type: "boolean",
      description: "True only if a visitor could say what this business sells within five seconds of this screen.",
    },
    contactClear: {
      type: "boolean",
      description: "True only if a way to make contact — a number, a form, a WhatsApp button — is visible in this picture.",
    },
    looksDated: {
      type: "string",
      description:
        "Roughly what era this design is from and the visible detail that dates it — a gradient bar, a slider, centred text on a photo, a Flash-era layout. Empty string if it does not look dated.",
    },
    fitsTheBusiness: {
      type: "boolean",
      description:
        "True only if this page looks like it belongs to a business of this kind and this size. False when it looks smaller, older, more amateur or simply like a different trade.",
    },
    fitNote: {
      type: "string",
      description:
        "One sentence on the gap between what this business is and what the page makes it look like. Concrete: 'an established manufacturer with a page that looks like a one-man builder from 2014'.",
    },
    speed: {
      type: "string",
      description:
        "How it behaves for somebody on a phone on a Ghanaian mobile connection, given the measured load time you were told. Say it in seconds and in consequences. Empty string if the timing was not supplied or there is nothing to say.",
    },
    observations: {
      type: "array",
      description:
        "Between two and six things that are visibly true of this page. Every one must be something the owner could confirm by opening their own site.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["observed", "soWhat", "plainly", "where", "severity"],
        properties: {
          observed: { type: "string", description: "What is visibly the case. Plain, specific, no jargon." },
          soWhat: { type: "string", description: "One sentence on what it costs them — a visitor who leaves, an enquiry not made, a comparison lost." },
          plainly: {
            type: "string",
            description:
              "The same point said across a desk to the owner, who is not technical. No web vocabulary at all: no hero, viewport, CTA, above the fold, responsive, UX. One sentence, second person.",
          },
          where: { type: "string", description: "Where on the page: 'the hero', 'the top navigation', 'the first screen'." },
          severity: {
            type: "string",
            enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "GOOD"],
            description:
              "Judge by what it costs the business, not by how wrong it is technically. A page that never says what they sell is CRITICAL. A slightly dated typeface is LOW.",
          },
        },
      },
    },
    worthFixing: {
      type: "object",
      additionalProperties: false,
      required: ["problem", "costsThem", "whyWorthPaying"],
      description: "The one thing here that is worth a business spending money on, stated the way a decision-maker weighs it.",
      properties: {
        problem: { type: "string", description: "The problem in one sentence, with no technical vocabulary in it at all." },
        costsThem: {
          type: "string",
          description: "What it costs them, concretely: customers who leave, enquiries never made, the comparison lost to a competitor, credibility with the buyers who matter.",
        },
        whyWorthPaying: {
          type: "string",
          description:
            "Why it is worth paying to fix rather than living with. Honest: if it is a small fix rather than a rebuild, say so — that makes it more likely to be bought, not less.",
        },
      },
    },
    theOneThing: {
      type: "string",
      description:
        "If only one sentence of this could go into a cold email, which. Written as the sentence itself, in the second person, naming the specific thing on their page.",
    },
    states: {
      type: "object",
      additionalProperties: false,
      required: ["trade", "town", "services", "phone"],
      description:
        "What the page itself states about the business. Facts read off the page, not inferences. Empty string or empty list wherever the page does not say.",
      properties: {
        trade: {
          type: "string",
          description:
            "What kind of business this is, in the page's own words — 'Dental clinic', 'Fabric wholesaler', 'Driving school'. Empty if the page does not say plainly.",
        },
        town: { type: "string", description: "The town or city named on the page. Empty if none is shown." },
        services: {
          type: "array",
          items: { type: "string" },
          description: "Up to six things the page says they offer, in their words. Empty if the page lists none.",
        },
        phone: { type: "string", description: "A phone number printed on the page, exactly as written. Empty if none is visible." },
      },
    },
  },
} as const;

const SYSTEM = `You are looking at a screenshot of one business's homepage, and reporting what is visibly true of it.

You are doing this so that a letter to that business can name something specific rather than something generic. "A modern website builds trust" is worthless; "the first thing on your homepage is a stock photo of a handshake, and nothing on that screen says you are a dental clinic" is worth replying to.

You are doing a second job at the same time: reading what the page *states* about the business — the trade, the town, what they offer, a phone number. Those go in the states object, and they are facts rather than judgements. The record this feeds is usually half empty, and a trade printed on a business's own homepage is better evidence than anything a search infers. If the page does not say, leave it empty; do not deduce a trade from a photograph or a town from a phone code.

What you may say:
- Anything visible in the picture. Layout, typography, image quality, colour, spacing, how the logo is rendered, what the navigation offers, what the first screen leads with, whether there is a call to action and what it says.

What you may not say, ever:
- Anything about a page you were not shown. You have the homepage, cropped to what a visitor sees first, and nothing else.
- Anything about how fast it loads, whether it works on a phone, what it is built on, or whether it is secure. Those were measured separately and you have no evidence for any of them.
- Anything about their business beyond what the page itself states.

How to judge — and this is the part that matters:

**You are not reviewing a design. You are telling a business owner whether their website is costing them money.** They are not a developer. They will never care that a heading is the wrong size. They will care, immediately, that the page makes their twenty-year-old company look like a start-up, or that a builder looking for a supplier cannot tell in five seconds that they sell what he needs.

So every judgement is made in those terms:
- **Does the page fit the business?** This is the one that lands hardest with an established company and it is invisible in the markup. A serious manufacturer with a page that looks like a template from 2013; a clinic whose site looks like a blog; a wholesaler whose page could belong to any trade at all. Say what the gap is between what they are and what the page makes them look like.
- **Would somebody comparing three suppliers pick them?** That is the real test. Whoever is looking at their page has two other tabs open.
- **What does it cost?** A customer who goes back to the search results. An enquiry that is never made because the number is three scrolls down. A contractor who assumes they are too small for the job. Name the person and what they do instead.

Then say plainly, in \`worthFixing\`, what is worth spending money on. Somebody has to read that and think "yes, that is a real problem and I would pay to solve it". If the honest answer is that it needs a small fix rather than a rebuild, say so — an owner is far more likely to buy a fix they believe in than a rebuild they suspect.

Two things that keep this honest:
- **If the homepage is genuinely good, say so, mark the observations GOOD, and set fitsTheBusiness true.** A review that always finds fault is a sales pitch and it reads as one. There is no shame in "this is a decent site".
- **Be concrete about what you can see.** "The photograph across the top is stretched out of shape and there is nothing on that screen saying what they make" is useful. "The design feels unprofessional" is an opinion and a business owner rejects it on sight.

**Every observation carries a plainly line: the same point with no web vocabulary in it whatsoever.** No hero, no CTA, no above the fold, no viewport, no responsive, no UX, no conversion. If you would not say the word to a cement wholesaler across a desk, it does not go in that line.

British spelling. No exclamation marks. Nothing you write should sound like a report about a website; it should sound like somebody who opened it and said what they saw.`;

/**
 * Takes the picture and reads it. Both halves degrade to a note rather than an
 * error: a lead with no screenshot still gets an email, argued from the audit.
 */
export async function lookAtHomepage(args: {
  website: string;
  companyName: string | null;
  /** What kind of business it is, so "does this page fit them" can be answered. */
  trade?: string | null;
  town?: string | null;
  /** Their public standing, which is what a page has to live up to. */
  rating?: number | null;
  reviewsCount?: number | null;
  /** What the structural checks already found, so the model does not repeat them. */
  audit?: CompanyAudit | null;
}): Promise<LookResult> {
  const notes: string[] = [];
  const captured = await captureHomepage(args.website);
  if (captured.note) notes.push(captured.note);
  if (!captured.shot || !captured.base64) return { look: null, shot: null, notes, costUsd: 0 };

  const structural = (args.audit?.findings ?? [])
    .filter((finding) => finding.severity !== "GOOD")
    .map((finding) => `- ${finding.observed}`)
    .slice(0, 8);

  try {
    const result = await callModel<Omit<HomepageLook, "lookedBy">>({
      purpose: "lead.homepageLook",
      job: "vision",
      system: SYSTEM,
      prompt: () =>
        [
          `The homepage of ${args.companyName ?? args.website}${args.trade ? `, a ${args.trade}` : ""}${args.town ? ` in ${args.town}` : ""}, at ${captured.shot!.finalUrl ?? captured.shot!.requested}.`,
          args.rating != null && args.reviewsCount != null
            ? `Their public standing, which the page has to live up to: ${args.rating} stars from ${args.reviewsCount} reviews.`
            : "",
          // Measured, not guessed, and it is one of the few things here that
          // can be stated as a number to somebody deciding whether to spend.
          args.audit?.site?.responseMs != null
            ? `Measured just now: the page took ${(args.audit.site.responseMs / 1000).toFixed(1)} seconds to start responding.`
            : "",
          `The picture is ${captured.shot!.width} by ${captured.shot!.height} pixels at a ${captured.shot!.viewportWidth}px-wide desktop viewport${
            captured.shot!.cropped ? ", cropped to the top of the page" : ""
          }.`,
          structural.length
            ? `Separate automated checks already found the following, so there is no need to repeat any of it — say what only the picture can show:\n${structural.join("\n")}`
            : "",
          "Look at it and report what is visibly true.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      schema: SCHEMA as unknown as Record<string, unknown>,
      images: [{ mediaType: captured.shot.mediaType, base64: captured.base64 }],
      effort: "medium",
      maxTokens: 4000,
      messages: {
        noKey: "Nothing is connected that can look at a picture, so their homepage was not reviewed. Add a ChatGPT or Claude key under Settings → AI models.",
        refusal: "The model declined to review this homepage.",
        empty: "Nothing came back from the look at their homepage.",
      },
    });

    return {
      look: {
        ...result.data,
        looksDated: result.data.looksDated?.trim() ? result.data.looksDated.trim() : null,
        speed: result.data.speed?.trim() || null,
        states: {
          trade: result.data.states?.trade?.trim() || null,
          town: result.data.states?.town?.trim() || null,
          services: (result.data.states?.services ?? []).map((entry) => entry.trim()).filter(Boolean).slice(0, 6),
          phone: result.data.states?.phone?.trim() || null,
        },
        lookedBy: PROVIDERS[result.provider].name,
      },
      shot: captured.shot,
      notes,
      costUsd: result.costUsd,
    };
  } catch (err) {
    // A model that will not answer is not a reason to abandon the email.
    notes.push(`Their homepage was photographed but not reviewed: ${(err as Error).message}`);
    return { look: null, shot: captured.shot, notes, costUsd: 0 };
  }
}

/**
 * The look as the drafter reads it.
 *
 * The business-level judgements come first and the technical description
 * second, because that is the order they matter in to the person the letter is
 * addressed to. `plainly` is given alongside each observation, and it is the
 * wording the email should reach for.
 */
export function lookForPrompt(look: HomepageLook): string[] {
  const lines: string[] = [];

  // The case for spending money, which is what the email is really asking for.
  lines.push(
    `WORTH PAYING TO FIX, in the owner's terms: ${look.worthFixing.problem} What it costs them: ${look.worthFixing.costsThem} Why it is worth money: ${look.worthFixing.whyWorthPaying}`,
  );
  if (!look.fitsTheBusiness) {
    lines.push(`Their site does not look like it belongs to a business of this kind or size: ${look.fitNote}`);
  }
  lines.push(`Their homepage, looked at just now: ${look.firstImpression}`);
  if (look.speed) lines.push(`How it behaves for somebody on a phone: ${look.speed}`);
  if (!look.offerClear) lines.push("Nothing on the first screen of their homepage says what the business actually sells.");
  if (!look.contactClear) lines.push("No way to make contact is visible on the first screen of their homepage.");
  if (look.looksDated) lines.push(`Their homepage design dates itself: ${look.looksDated}`);
  for (const observation of look.observations) {
    lines.push(
      `Seen on their homepage (${observation.where}, ${observation.severity.toLowerCase()}): ${observation.observed} — ${observation.soWhat} Say it to them like this: "${observation.plainly}"`,
    );
  }
  if (look.states.services.length) {
    lines.push(`Their homepage says they offer: ${look.states.services.join("; ")}. Those are their words, so they are safe to use back to them.`);
  }
  lines.push(`The sharpest single thing to say about their homepage: ${look.theOneThing}`);
  return lines;
}
