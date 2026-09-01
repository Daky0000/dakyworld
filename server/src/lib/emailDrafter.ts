import type { EmailPurpose } from "@prisma/client";
import { callModel } from "./models/call.js";
import { MODEL_DEFAULT } from "./claudePricing.js";
import { VOICE as BRAND_VOICE } from "../services/dakyworld.js";
import { brandBlock } from "../services/context/business.js";
import { COLD_EMAIL_DOCTRINE, EVIDENCE_RULES, FOLLOW_UP_DOCTRINE } from "../services/outreachDoctrine.js";
import { companyProfile, contactBlock } from "../services/systemProfile.js";
import { writerSystem } from "../services/writers/brief.js";
import { emailJobFor } from "../services/writers/registry.js";
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

- **Start with a greeting.** "Hi Kwame," on its own line, using their real first name. If no real person's name is known — only a company — use "Hello,". Never invent a name, and never open on a bare sentence with no greeting at all: it reads as a broadcast, because it is how one looks.
- **The opening is about them, and the identification follows immediately.** On a cold email, open on the thing that was actually seen — something you could not have said about any other business — and name yourself and Dakyworld in the very next breath, inside the first three lines. Not what Dakyworld does; not a company introduction. Leading with ourselves is the commonest reason a stranger stops reading, and an email that never says who is writing is an anonymous remark about somebody's website, which reads as a threat rather than a favour.
- **Every observation is followed by what it makes harder for them.** "Your site has no X" is half a sentence. The other half is what the reader may notice or what it makes more difficult — a phone visitor having to type the number out by hand, a searcher with less to go on before deciding to click. Not in our vocabulary — "unprofessional", "not best practice" and "makes it look unfinished" are opinions and read as sales. **And not as a prediction:** "customers are leaving your website" states an outcome nobody has measured, and the one person who can check it is the one reading. Say what is harder, not what it has already cost.
- Short. A cold email is 70–120 words: enough to say who is writing, what was noticed, why it may matter and what happens next, and not a word past that. A client update is under 200. If it needs to be longer, it needs a call instead.
- One ask, at the end, and make it small. On a **first** email to a stranger the ask offers something rather than requesting something — the screenshot, the exact setting, the short checklist — and never asks for a meeting: time is the biggest thing you can ask of somebody who has not agreed there is a problem yet. A call is what the *second* conversation is for. Never two asks.
- "I'm writing to introduce" is not a first line.
- **No sign-off name.** End on the ask. The app appends the signature — a "Dan" typed at the bottom of the body arrives directly above "Dan Kwame Ayipah, Founder", and the reader sees the machinery.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "rationale", "confidence"],
  properties: {
    subject: {
      type: "string",
      description:
        "The subject line. Two to four words, lower-case throughout, no punctuation tricks, no company name and no first name. It should look like a note from a colleague about something ordinary — \"your contact page\", \"booking form\" — and never be a question the body then repeats.",
    },
    body: {
      type: "string",
      description:
        "The email body as plain text, blank line between paragraphs. It opens with a greeting line — \"Hi <first name>,\" using their real name, or \"Hello,\" when only a company name is known; never an invented name. It ends on the ask, with no sign-off and no name: the app appends the signature. No HTML.",
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
  /**
   * Force a particular playbook scenario rather than letting the findings
   * choose. This is how the nine that no fetch can establish — a new branch, a
   * registrar account, a sector incident — get written at all.
   */
  scenarioKey?: string | null;
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
  // Cold and follow-up are never emitted — each has its own doctrine in the
  // system prompt (`services/outreachDoctrine.ts`), and a second account of the
  // same letter here is what makes a model fall back to the generic one. Kept
  // as one line each so the record is complete and so nothing tempts a future
  // reader into re-enabling a description that would now contradict the
  // doctrine.
  COLD_OUTREACH: `A first approach to somebody who has never heard of Dakyworld. The doctrine in the system prompt governs it completely — do not infer a second shape from this line.`,
  FOLLOW_UP: `A follow-up to an email that was not answered. The doctrine in the system prompt governs it completely, including which touch in the sequence this is — do not infer a second shape from this line.`,
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
  DEMO_READY: `The demo page is built and this email carries the link. They asked for it, so the selling is done — this email's only job is to get them to open it.

Three or four sentences. Say it is ready, give the link on its own line, and say one specific thing you would point at when they look — a section, a decision, something taken from their own site or listing. Then ask what they think.

Say plainly that it is a working page they can open on their phone, and that nothing is final. Do not re-pitch, do not list what a website does, do not mention price unless the brief does. If the facts include what the demo actually contains, use one detail from it rather than describing it in general.`,
  CUSTOM: "Follow the sender's brief exactly. If the brief is thin, keep the email short rather than padding it.",
};

/**
 * Which argument this email makes, when no scenario has been chosen.
 *
 * This used to carry the whole doctrine and it is now the fallback for a lead
 * with no audit behind it. **It shrank on purpose**, and the reason is the most
 * useful thing in this file:
 *
 * For a while it ran *alongside* the playbook rules and the scenario, and the
 * three of them disagreed. The purpose brief said "say what it makes harder,
 * never what it has already cost them"; this block said "say what it costs
 * them" three times. The brief said the ask is never a meeting; this block said
 * "ask for fifteen minutes". The brief said no price ever; this block offered
 * something free. A model handed contradictory instructions does not pick one —
 * it retreats to the most familiar pattern it knows, which is the generic cold
 * email both sets of rules existed to prevent. The founder's report was that
 * the drafts "say the same thing, no improvement", and this was why: every rule
 * was in the prompt and half of them were being cancelled out on the next line.
 *
 * So: **when a scenario is chosen, this is not emitted at all** — the scenario
 * is a better version of the same thing, chosen from evidence rather than from
 * one branch on `website`. What remains here is the one distinction a scenario
 * cannot make, because it is about the *absence* of findings rather than their
 * presence: a business with no website is a different letter from a business
 * with a website somebody has looked at.
 */
function angle(context: RecipientContext): string | null {
  if (context.kind !== "lead") return null;

  if (!context.variables.website?.trim()) {
    return `They have no website. That is the email, and the demo page is the ask.

Do not write about websites in general and do not list what a website contains. Write about what not having one means for *this* business: somebody searching their trade in their town finds the competitors who have one, and the reviews they have earned have nowhere to send anybody.

Use their trade and their town by name. Those two words are what make it about them rather than about anybody.

If the facts show demand already exists — a rating, a review count, a busy social account — that is the strongest thing you have, because the interest is real and there is nowhere for it to land. Say that.

**The ask is the page.** A page has been built for them and the facts carry its link. Say plainly that you put a page together to show what it could look like, give the link on its own line, and ask what they think of it. Nothing else: no call, no meeting, no second ask. It is theirs to look at, it took an afternoon, and it commits them to nothing — say that if it fits in the words you have.

If the facts carry **no** demo link, then no page exists. Offer to put one together instead, and never write as though a link is coming with this email.`;
  }

  return `They have a website and somebody has looked at it. The facts include what was checked on it and what it looks like.

Open on the single most specific thing that was actually observed there. One point, two at the very most, and never a list.

**Write about something the owner can see, not something a tool measured.** A missing DNS record, a header, a certificate, a tag — all true, and all worth nothing to the person reading, because they cannot picture any of them. What they can picture is somebody opening their page and not finding what they came for. If the facts carry an observation with a "say it to them like this" wording, use that wording: it has already been put into words a business owner would use.

If a fact shows demand — a review count, a rating — use it. It turns "your site is dated" into "people are already looking for you, and this is what they find".

**The point that lands hardest with an established business is the gap between what they are and what their page makes them look like.** An eighteen-year-old company with a page from 2013 is being compared against smaller competitors who look bigger. If that is in the facts, it is usually the letter.

Never propose a new website for a site that mostly works. Fixing what was actually observed is the honest offer and the smaller ask.`;
}


function buildPrompt(request: DraftRequest): string {
  const { context } = request;
  // **A letter with its own doctrine does not get a second description of
  // itself here.** `COLD_EMAIL_DOCTRINE` and `FOLLOW_UP_DOCTRINE` each state
  // the shape, the length, the ask and the register in full; emitting the
  // matching `PURPOSE_BRIEF` as well would put two overlapping accounts of one
  // letter in front of the model, and a model given two does not merge them —
  // it falls back to the generic email it already knew. That is the exact
  // failure this codebase has already paid for once, with `angle()` and the
  // scenario running against each other.
  //
  // Follow-up joined cold here in Aug 2026, when it stopped sharing the
  // general doctrine and got one of its own.
  const OWN_DOCTRINE: EmailPurpose[] = ["COLD_OUTREACH", "FOLLOW_UP"];
  const purposeBrief = OWN_DOCTRINE.includes(request.purpose) ? "" : PURPOSE_BRIEF[request.purpose];

  const parts = [
    `Purpose: ${request.purpose.replace(/_/g, " ").toLowerCase()}`,
    purposeBrief,
    "",
    "Everything known about the recipient. These are the only facts you may use — you may leave any of them out, but you may not add to them:",
    context.facts.map((fact) => `- ${fact}`).join("\n"),
  ];

  // Decided here rather than left to the model. `firstName` already knows that
  // "Accra Dental Centre" in the contact field is a company and not a person,
  // and "Hi Accra," is the sort of mistake that ends a cold email at the first
  // line. The drafter should not have to re-derive it from the facts.
  const greeting = context.variables.first_name && context.variables.first_name !== "there" ? `Hi ${context.variables.first_name},` : "Hello,";
  parts.push("", `Open with this greeting exactly, on its own line: ${greeting}`);

  // The angle, from what was actually observed.
  //
  // This used to be a fork: an eighteen-scenario playbook block when the audit
  // matched one, and the angle below only as a fallback. The playbook was
  // removed in Aug 2026 — see `services/outreachDoctrine.ts` for what replaced
  // it and why. The angle is what remains, and it is the better half: it is
  // derived from this business's own facts rather than from a numbered
  // template, so two companies with the same fault do not receive the same
  // letter. Which shape the letter takes is now the writer's decision, made
  // from the evidence, as the doctrine instructs.
  const chosen = angle(context);
  if (chosen) parts.push("", "The angle for this one:", chosen);

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

/**
 * The whole instruction, composed.
 *
 * Exported because "the drafts still read the same" is a question about what
 * the model was actually told, and the only honest way to answer it is to look
 * at what the model was actually told rather than at the file you last edited.
 * `tmp/writerAudit.ts` prints this and asserts every rule is really in it —
 * which is how the polish stage was caught quietly enforcing the previous
 * doctrine over the top of this one.
 */
export async function buildColdEmailPrompt(request: DraftRequest): Promise<{ system: string; user: string }> {
  return { system: await draftSystem(request.purpose), user: buildPrompt(request) };
}

/**
 * The doctrine Dakyworld ships for outbound email.
 *
 * **This is a default, not the authority.** The moment somebody edits the
 * owning agent on the Agents screen — `outreach.writer` for a cold email,
 * `outreach.followup` for a nudge, `billing.collector` for a chase,
 * `client.notifier` for the rest — their wording replaces this and writes the
 * letter instead. That is the whole point of `services/writers/brief.ts`: this
 * constant used to be the only thing that ever reached the model, so a founder
 * could rewrite the Cold Lead Writer's prompt, watch the screen show the new
 * wording, and get the identical email back, because the screen and the writer
 * were two unconnected things.
 *
 * Keep the *judgement* here and the *format* in `CONTRACT` below. Anything in
 * this string can be replaced by an edit; nothing in the contract can.
 */
/**
 * Everything that is not a first approach or a follow-up. Structure comes from
 * the purpose brief.
 */
const GENERAL_EMAIL_DOCTRINE = `You draft outbound email for one specific company. Every draft you produce is read by a person before it is sent — write the email they would send, not a template they have to rewrite.

${VOICE}

${EVIDENCE_RULES}`;

/**
 * Cold and follow-up now live in `services/outreachDoctrine.ts`.
 *
 * They were moved out when the eighteen-scenario playbook was removed: the two
 * of them plus the WhatsApp/SMS doctrine are one system that has to agree with
 * itself, and keeping them in three different files is how the polish stage
 * ended up enforcing a rule the drafter had already dropped.
 */
const DOCTRINE_BY_JOB: Record<string, string> = {
  "email.cold": COLD_EMAIL_DOCTRINE,
  "email.followup": FOLLOW_UP_DOCTRINE,
};

export function shippedDoctrineFor(job: string): string {
  return DOCTRINE_BY_JOB[job] ?? GENERAL_EMAIL_DOCTRINE;
}

/**
 * The mechanics of the answer, which no prompt edit can reach.
 *
 * The signature rule is here rather than in the doctrine on purpose: the app
 * appends the sign-off, so a model that adds one produces a letter with the
 * founder's name in it twice. That is a rendering fact about this system, not
 * a matter of taste, and it must survive somebody rewriting the voice.
 */
const CONTRACT = `Return the body as plain text with blank lines between paragraphs. No HTML.

End on the ask. Do not type a sign-off or a name at the end — the app appends the signature, and a name typed above it arrives directly on top of the real one.`;

async function draftSystem(purpose: EmailPurpose): Promise<string> {
  const job = emailJobFor(purpose);
  return writerSystem(job, shippedDoctrineFor(job), {
    facts: [await brandBlock(), contactBlock(await companyProfile())],
    contract: CONTRACT,
  });
}

export async function draftEmail(request: DraftRequest): Promise<DraftResult> {
  const system = await draftSystem(request.purpose);
  const { data, model, inputTokens, outputTokens } = await callModel<{
    subject: string;
    body: string;
    rationale: string;
    confidence: number;
  }>({
    purpose: "email.draft",
    // Prose. Routed with everything else the system writes — see lib/models.
    job: "text",
    system,
    prompt: () => buildPrompt(request),
    schema: SCHEMA as unknown as Record<string, unknown>,
    // High, and it was medium — which is hard to defend once written down. A
    // proposal was already high and so was a demo page, while the cold email,
    // the shortest and most-read thing this company produces and the one a
    // stranger judges it by, was being written at the cheaper setting. It is a
    // hundred and twenty words: the difference in cost is a fraction of a penny
    // and the difference in output is the whole product.
    effort: "high",
    messages: {
      noKey: "No model is connected for writing. Add a key under Settings → AI models, or write this one by hand.",
      auth: "The model provider rejected the API key. Check it under Settings → AI models.",
      rate: "The model provider is rate-limiting this key. Try again in a minute.",
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
