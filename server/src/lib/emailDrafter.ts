import type { EmailPurpose } from "@prisma/client";
import { callClaude } from "./claude.js";
import { MODEL_DEFAULT } from "./claudePricing.js";
import { BRAND, VOICE as BRAND_VOICE } from "../services/dakyworld.js";
import { companyProfile, contactBlock } from "../services/systemProfile.js";
import type { RecipientContext } from "../services/emailContext.js";

/**
 * The email drafter.
 *
 * Writing to a prospect is a judgement job in the same way reading their
 * spreadsheet was. The facts are in the database — no website, 4.6 stars from
 * 212 reviews, a proposal sent three weeks ago that nobody answered — and the
 * job is to turn the right two of them into four sentences that sound like a
 * person who looked.
 *
 * Two rules do most of the work here:
 *
 *  - **Only the facts supplied.** The context block is everything the drafter
 *    knows, and it is told so explicitly. A "tailored" email that invents a
 *    branch office or a founder's name is worse than a generic one, because it
 *    is caught and remembered.
 *  - **It writes a draft, not an outbox.** Nothing this returns is sent. It
 *    lands in the composer for a person to read, which is the only reason
 *    generating outbound mail with a model is defensible at all.
 */

export const DRAFTER_MODEL = MODEL_DEFAULT;

/** The email-specific half of the voice; the shared half is in services/dakyworld.ts. */
const VOICE = `${BRAND_VOICE}

For email specifically:

- Short. A cold email is under 120 words. A client update is under 200. If it needs to be longer, it needs a call instead.
- One ask, at the end, and make it small: a reply, a fifteen-minute call, a yes-or-no. Never two asks.
- "I'm writing to introduce" is not a first line.
- No corporate signature block — the app appends one.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "rationale", "confidence"],
  properties: {
    subject: {
      type: "string",
      description:
        "The subject line. Six words or fewer, lower-case except names, no colons-as-branding, and never a question the body then repeats.",
    },
    body: {
      type: "string",
      description:
        "The email body as plain text, with a blank line between paragraphs. No greeting line invented beyond the recipient's real name, no HTML, no signature block.",
    },
    rationale: {
      type: "string",
      description: "One or two sentences for the person reviewing this: which facts you used, and why this angle.",
    },
    confidence: {
      type: "number",
      description:
        "0 to 1 — how well the supplied facts supported a specific email. Low when you had almost nothing to work with, which tells the reviewer to add detail rather than send it.",
    },
  },
} as const;

export interface DraftRequest {
  purpose: EmailPurpose;
  context: RecipientContext;
  /** What this particular email is for, in the sender's words. */
  brief?: string | null;
  /** Rewrite an existing draft rather than starting from nothing. */
  existingSubject?: string | null;
  existingBody?: string | null;
  /** Extra facts the sender is supplying by hand — a delivery date, a link. */
  extraFacts?: string[];
}

export interface DraftResult {
  subject: string;
  body: string;
  rationale: string;
  confidence: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** What each purpose is actually trying to achieve. The model gets one of these, not all fourteen. */
const PURPOSE_BRIEF: Record<EmailPurpose, string> = {
  COLD_OUTREACH:
    "A first approach to someone who has never heard of Dakyworld. Open with the specific thing you noticed about their business — that is the entire reason this email is not spam. Do not pitch the whole service list; name the one problem you can see and what it costs them. Ask for a short call, not a meeting about a partnership.",
  FOLLOW_UP:
    "A follow-up to an email that was not answered. Assume they are busy, not uninterested. Do not guilt them, do not say 'just circling back' or 'bumping this'. Add one new piece of value or a sharper version of the ask, and make it easy to say no.",
  MEETING_REQUEST:
    "Asking for a specific conversation. Say what the call would cover, say how long it takes (thirty minutes), and offer to work around them rather than listing your own availability.",
  PROPOSAL_COVER:
    "The note that carries a proposal. Two or three sentences: what is attached, the one decision it asks them to make, and when you will follow up if you hear nothing. The proposal argues its own case — this email must not re-argue it.",
  DELIVERABLE_HANDOVER:
    "Handing over finished work. Say plainly what is being delivered, what they should do with it, anything that needs them, and who to ask. Confident, not congratulatory. Do not thank them for their patience unless the work was late.",
  PROJECT_UPDATE:
    "A progress update on live work. What moved, what is next, anything blocked and what you need from them. No filler — if nothing needs them, say the update needs no reply.",
  INVOICE_DELIVERY:
    "Sending an invoice. Neutral and administrative. Amount, what it covers, how to pay, when it is due. No apology for invoicing.",
  INVOICE_REMINDER:
    "A payment that is late. Polite, unembarrassed, and specific about the amount and the number of days. Assume it was overlooked. Give one clear way to resolve it. Do not threaten, and do not apologise for asking.",
  CARE_PLAN_REVIEW:
    "Booking the periodic care plan review. Remind them what the review covers, mention something real from the period if it is in the facts, and propose a time frame rather than a date.",
  ONBOARDING:
    "Starting work with a new client. What happens next, in order, with dates where they exist, and the one or two things needed from them to begin. Reassuring through specificity, not through adjectives.",
  REACTIVATION:
    "Writing to someone who went quiet, or a client whose work ended a while ago. Acknowledge the gap plainly without making it awkward, give a real reason for writing now, and keep the ask very small.",
  THANK_YOU: "A short genuine thank-you. Three sentences at most. No upsell of any kind — that is what makes it worth sending.",
  ANNOUNCEMENT:
    "Telling existing contacts about something new. Lead with what it means for them, not with the news itself. One sentence on what to do if they want it.",
  CUSTOM: "Follow the sender's brief exactly. If the brief is thin, keep the email short rather than padding it.",
};

function buildPrompt(request: DraftRequest): string {
  const { context } = request;
  const parts = [
    `Purpose: ${request.purpose.replace(/_/g, " ").toLowerCase()}`,
    PURPOSE_BRIEF[request.purpose],
    "",
    "Everything known about the recipient. These are the only facts you may use — you may leave any of them out, but you may not add to them:",
    context.facts.map((fact) => `- ${fact}`).join("\n"),
  ];

  if (request.extraFacts?.length) {
    parts.push("", "The sender has added these facts for this email specifically:", request.extraFacts.map((fact) => `- ${fact}`).join("\n"));
  }
  if (request.brief?.trim()) {
    parts.push("", `What the sender wants this email to do, in their words:\n${request.brief.trim()}`);
  }
  if (request.existingBody?.trim()) {
    parts.push(
      "",
      "There is already a draft. Rewrite it — keep anything specific and true in it, and fix what is generic, long, or off-voice:",
      `Subject: ${request.existingSubject ?? "(none)"}`,
      request.existingBody.trim(),
    );
  }
  if (!context.email) {
    parts.push("", "Note: no email address is on file for this recipient. Write the draft anyway; the sender will supply one.");
  }

  parts.push("", "Write the email.");
  return parts.join("\n");
}

export async function draftEmail(request: DraftRequest): Promise<DraftResult> {
  const { data, model, inputTokens, outputTokens } = await callClaude<{
    subject: string;
    body: string;
    rationale: string;
    confidence: number;
  }>({
    purpose: "email.draft",
    system: `You draft outbound email for one specific company. Every draft you produce is read by a person before it is sent — write the email they would send, not a template they have to rewrite.\n\n${BRAND}\n\n${contactBlock(await companyProfile())}\n\n${VOICE}\n\nNever invent a fact about the recipient. If the facts you were given are thin, write a shorter email; do not fill the space with claims. Return the body as plain text with blank lines between paragraphs — the app renders it and appends the signature.`,
    prompt: () => buildPrompt(request),
    schema: SCHEMA as unknown as Record<string, unknown>,
    effort: "medium",
    messages: {
      noKey: "No Anthropic API key is set. Add one under Settings → AI analyst to draft emails, or write this one by hand.",
      auth: "Anthropic rejected the API key. Check it under Settings → AI analyst.",
      rate: "Anthropic is rate-limiting this key. Try again in a minute.",
      refusal: "The drafter declined to write this one. Rephrase the brief, or write it by hand.",
      empty: "The drafter returned nothing. Try again.",
      truncated: "The drafter ran out of room before finishing. Try again, or shorten the brief.",
      parse: "The draft could not be read. Try again.",
    },
  });

  return {
    subject: data.subject.trim(),
    body: data.body.trim(),
    rationale: data.rationale,
    confidence: data.confidence,
    model,
    inputTokens,
    outputTokens,
  };
}
