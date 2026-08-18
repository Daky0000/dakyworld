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
  /** Where on the page — "the hero", "the top navigation", "the first screen". */
  where: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "GOOD";
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
  observations: HomepageObservation[];
  /** The one thing worth putting in an email, chosen by the model that looked. */
  theOneThing: string;
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
  required: ["firstImpression", "offerClear", "contactClear", "looksDated", "observations", "theOneThing"],
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
    observations: {
      type: "array",
      description:
        "Between two and six things that are visibly true of this page. Every one must be something the owner could confirm by opening their own site.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["observed", "soWhat", "where", "severity"],
        properties: {
          observed: { type: "string", description: "What is visibly the case. Plain, specific, no jargon." },
          soWhat: { type: "string", description: "One sentence on what it costs them — a visitor who leaves, an enquiry not made, a comparison lost." },
          where: { type: "string", description: "Where on the page: 'the hero', 'the top navigation', 'the first screen'." },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "GOOD"] },
        },
      },
    },
    theOneThing: {
      type: "string",
      description:
        "If only one sentence of this could go into a cold email, which. Written as the sentence itself, in the second person, naming the specific thing on their page.",
    },
  },
} as const;

const SYSTEM = `You are looking at a screenshot of one business's homepage, and reporting what is visibly true of it.

You are doing this so that a letter to that business can name something specific rather than something generic. "A modern website builds trust" is worthless; "the first thing on your homepage is a stock photo of a handshake, and nothing on that screen says you are a dental clinic" is worth replying to.

What you may say:
- Anything visible in the picture. Layout, typography, image quality, colour, spacing, how the logo is rendered, what the navigation offers, what the first screen leads with, whether there is a call to action and what it says.

What you may not say, ever:
- Anything about a page you were not shown. You have the homepage, cropped to what a visitor sees first, and nothing else.
- Anything about how fast it loads, whether it works on a phone, what it is built on, or whether it is secure. Those were measured separately and you have no evidence for any of them.
- Anything about their business beyond what the page itself states.

How to judge:
- Judge it against what a customer comparing two suppliers would think, not against a design award. A plain page that says clearly what the business does and how to reach it is a good page.
- If the homepage is genuinely good, say so and mark the observations GOOD. A review that always finds fault is a sales pitch, and it reads as one.
- Be concrete about what you can see. "The hero photograph is visibly low-resolution and stretched wider than its original size" is useful. "The design feels unprofessional" is not.

British spelling. No exclamation marks. Nothing you write should sound like a report about a website; it should sound like somebody who opened it and said what they saw.`;

/**
 * Takes the picture and reads it. Both halves degrade to a note rather than an
 * error: a lead with no screenshot still gets an email, argued from the audit.
 */
export async function lookAtHomepage(args: {
  website: string;
  companyName: string | null;
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
          `The homepage of ${args.companyName ?? args.website}, at ${captured.shot!.finalUrl ?? captured.shot!.requested}.`,
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

/** The look as the drafter reads it — plain lines, evidence-first. */
export function lookForPrompt(look: HomepageLook): string[] {
  const lines = [`Their homepage, looked at just now: ${look.firstImpression}`];
  if (!look.offerClear) lines.push("Nothing on the first screen of their homepage says what the business actually sells.");
  if (!look.contactClear) lines.push("No way to make contact is visible on the first screen of their homepage.");
  if (look.looksDated) lines.push(`Their homepage design dates itself: ${look.looksDated}`);
  for (const observation of look.observations) {
    lines.push(
      `Seen on their homepage (${observation.where}, ${observation.severity.toLowerCase()}): ${observation.observed} — ${observation.soWhat}`,
    );
  }
  lines.push(`The sharpest single thing to say about their homepage: ${look.theOneThing}`);
  return lines;
}
