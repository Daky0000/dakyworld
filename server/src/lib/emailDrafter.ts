import type { EmailPurpose } from "@prisma/client";
import { callModel } from "./models/call.js";
import { MODEL_DEFAULT } from "./claudePricing.js";
import { BRAND, VOICE as BRAND_VOICE } from "../services/dakyworld.js";
import { chooseScenario, scenarioForPrompt } from "../services/coldEmailScenarios.js";
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

- **Start with a greeting.** "Hi Kwame," on its own line, using their real first name. If no real person's name is known — only a company — use "Hello,". Never invent a name, and never open on a bare sentence with no greeting at all: it reads as a broadcast, because it is how one looks.
- **The opening says who is writing and what was seen, in that order.** On a cold email that is one clause of identification — "Daky here from Dakyworld" — and then, immediately, something about *them* you could not have said about anybody else. Not what Dakyworld does; not a company introduction. A stranger who cannot tell in one line who is writing has already stopped reading, and an email that identifies itself and then says nothing specific is the same broadcast with a name on it.
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
        "The subject line. Six words or fewer, lower-case except names, no colons-as-branding, and never a question the body then repeats.",
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
  COLD_OUTREACH: `A first approach to somebody who has never heard of Dakyworld. About 70–120 words. Four short paragraphs, in this order, and no others:

1. The greeting. "Hi <first name>," on its own line.
2. **Who you are and why you are writing, in the first two lines.** "Daky here from Dakyworld. I was looking at <their address> before writing and noticed..." — the sender is named *before* the observation, not after it and not never. A stranger who cannot tell in one line who is writing and why has already decided. No company introduction beyond that clause: one sentence of identification, then straight to what was seen.
3. The observation and what it makes harder. **State the confirmed fact plainly, then what the reader may notice or what it makes harder — never what it has already cost them.** "People using a phone may find it harder to read the page or contact you" is the shape. "Customers are leaving your website" is a prediction nobody has evidence for, and it is the sentence that gets a reply saying so. One issue only.
4. The ask. **One question, answerable in one line, and it offers something rather than requesting something**: the screenshot, the exact setting, the short checklist. Not a meeting — a first email does not ask for time. "Would you like me to send the screenshot?" is the shape.

Never list the findings. Never pitch the service catalogue. **No price, ever, in a first email** — a number belongs in a proposal, after they understand the issue and want help, and quoting one now asks them to judge a cost before they have agreed there is a problem.

**Write it for a busy owner, not a developer.** Do not use SPF, DMARC, DKIM, DNS, robots.txt, Open Graph, LCP, TTFB, metadata, structured data, schema, viewport, canonical, TLS or page source. Explain the issue in plain words; in most first emails the term can be left out completely, and where one genuinely helps it comes *after* the plain explanation, never instead of it.

**Never name a private individual** — not the person on the domain account, not a former supplier, not an employee, not whoever owns the mailbox on the contact page. State the business question without identifying anybody.

**Separate what was confirmed from what might follow.** A check that failed, timed out or did not complete is not a finding: "not checked" is not "broken". Do not claim anything caused lost sales, fraud or complaints unless the evidence in front of you proves it did.

If the facts carry a line saying THERE IS NO STRONG CASE HERE, do not write the four paragraphs above. Write three sentences at most, say the true good thing about their setup, offer the one small improvement that was actually found, and set confidence low — then say in the rationale that this business is doing fine and may not be worth writing to. That is a more useful answer than a polished email about nothing, and the person reading it can still send it if they disagree.`,
  FOLLOW_UP: `A follow-up to an email that was not answered. Assume they are busy, not uninterested. Do not guilt them, and never write "just checking in", "circling back" or "bumping this" — each of those is an admission that there was nothing new to say.

**Every follow-up carries something the last one did not.** The sequence runs day 0, 3, 8, 14 and 21, and each touch has its own job:

- **Day 3** delivers the evidence the first email offered — the screenshot, the setting, the list. No second sales question with it: "Nothing needed from you, I said I would send it" is the whole message.
- **Day 8** is a comparable example, and only when the business, the problem and the result really are comparable. If there is no honest comparison, skip this one rather than inventing a reason to write.
- **Day 14** explains how ongoing support prevents this class of problem — but only if they have engaged. If they have not, skipping is better than a forced sales message.
- **Day 21** closes it. Say plainly that you will not keep writing, hand over the finding so they can give it to whoever already looks after their site, and make clear no reply is needed. Do not sell in the last message: it is the one people remember.

Keep the same one issue throughout. A follow-up that raises a second problem is a new cold email wearing a thread.`,
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
 * Which argument this email makes, decided by the one fact that changes it.
 *
 * A business with no website and a business with a bad one are not two degrees
 * of the same conversation. The first has never had the thing and needs to be
 * told what it would do for *them* — this trade, this town, these customers.
 * The second has it, has probably stopped looking at it, and needs to be told
 * what is on it right now. Getting this wrong produces the email everybody
 * deletes: a pitch for a website, sent to somebody who has one.
 */
function angle(context: RecipientContext): string | null {
  if (context.kind !== "lead") return null;

  if (!context.variables.website?.trim()) {
    return `They have no website. That is the email.

Do not write about websites in general and do not list what a website contains. Write about what not having one costs *this* business: the customer who searched their trade in their town and found somebody else, the reviews they have earned with nowhere to send anyone, the enquiry that went to whoever appeared instead. Use their trade and their town by name — those two words are what make it about them rather than about anybody.

If the facts show demand already exists — a rating, a review count, a busy social account — that is the strongest thing you have. The demand is real and there is nowhere for it to land. Say that.

Make the cost concrete and theirs. "A customer who searches for a dentist in Osu finds the three clinics that have a site, and you are not one of them" is an argument. "A website builds credibility" is a brochure line and they have read it a hundred times.

One concrete sentence about their situation beats three about ours.

**The ask offers them something small.** Playbook v3's default here is to offer the outline — "would you like me to outline what that website would need to do?" — which is one line to answer and commits nobody to anything. **Offering to build a free demo page is also allowed** and is the stronger version where the record shows real demand with nowhere to land, because it is the argument itself rather than a claim about it; if you use it, say it in one plain line with no "no-obligation", no "absolutely free" and no exclamation mark. Either way it is an offer, never a request: do not ask for a call or a meeting in a first email.`;
  }

  return `They have a website and somebody has looked at it. The facts include what was checked on it and what it looks like.

Open on the single most specific thing that was actually observed there, and say what it costs them. Not "your website could be improved" — the thing itself: what loads, what does not, what a visitor sees first, what is missing from the page.

Do not list the findings. Take one, at most two, and make them concrete enough that they can check it themselves in ten seconds while still reading. Anything they can verify without leaving the email is worth more than anything they cannot.

**Write about something the owner can see, not something a tool measured.** They are not technical and they never will be. A missing DNS record, a header, a certificate, a tag — these are true and they are worth nothing to the person reading, because they cannot picture them and cannot picture the money. What they can picture is a customer opening their page and leaving. If the facts contain a line marked WORTH PAYING TO FIX, or an observation with a "say it to them like this" wording, use that wording — it exists because it has already been put into words a business owner would use.

Say what it costs them, not what it looks like, and say it in people: the builder who opens the page and cannot tell within five seconds whether they sell what he needs; the distributor comparing three suppliers with two other tabs open; the patient who goes back to the search results. If a fact in the list shows demand — a review count, a rating — use it: it turns "your site is dated" into "people are already looking for you and this is what they find".

**The hardest-landing point with an established business is the gap between what they are and what their site makes them look like.** A twenty-year-old company with a page that looks like a template from 2013 is losing work to smaller competitors who look bigger. If that is in the facts, it is usually the letter.

Never suggest a new website when the facts describe a site that mostly works. Fixing what was observed is the honest offer, and it is a smaller ask.

**If the facts say the design itself is the problem — dated, unclear, nothing above the fold that says what they sell — offering to redesign the homepage as a page they can open and compare against their own is the strongest ask available.** Free, nothing owed either way, one plain line at the end. Show, do not argue: they have been told their site is dated before and it changed nothing. Where a scenario names a smaller ask, take the smaller one — the rule this serves is that a first email offers something rather than requesting something, and the smallest honest offer is the easiest yes.

If the facts describe a technical fault rather than a design one — an expired or untrusted certificate, no HTTPS, a dead site, no way to make contact — do not offer a redesign. Offer the fix and ask for fifteen minutes. Offering to rebuild a site whose real problem is a certificate reads as somebody who wants a bigger job.

**A certificate warning outranks everything else in the facts, and it is written as what the visitor sees.** Not "your TLS certificate has expired" — that is a sentence for a developer. It is: a browser may show a warning before somebody can open the site, so visitors may stop at that screen. Say when it expired if the facts carry a date.

**Do not say it can be fixed the same day, and do not say it is free.** Neither has been established from outside: the cause may be the hosting, a renewal setting or something else, and none of that is visible from here. Say the cause still needs checking and offer to check it. Promising a same-day fix to somebody whose problem turns out to be a lapsed hosting account is the kind of confident sentence that loses the second email.`;
}

function buildPrompt(request: DraftRequest): string {
  const { context } = request;
  const parts = [
    `Purpose: ${request.purpose.replace(/_/g, " ").toLowerCase()}`,
    PURPOSE_BRIEF[request.purpose],
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

  const chosen = angle(context);
  if (chosen) parts.push("", "The angle for this one:", chosen);

  // The scenario, when the audit found one. It is chosen in code from the
  // finding ids rather than left to the model, because "which of the eighteen
  // letters is this" is a decision with evidence behind it, and a drafter asked
  // to pick for itself picks whichever reads most neatly.
  if (request.purpose === "COLD_OUTREACH" && context.findingIds?.length) {
    const scenario = chooseScenario(context.findingIds, request.scenarioKey ?? null);
    if (scenario) parts.push("", scenarioForPrompt(scenario));
  }

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
  const { data, model, inputTokens, outputTokens } = await callModel<{
    subject: string;
    body: string;
    rationale: string;
    confidence: number;
  }>({
    purpose: "email.draft",
    // Prose. Routed with everything else the system writes — see lib/models.
    job: "text",
    system: `You draft outbound email for one specific company. Every draft you produce is read by a person before it is sent — write the email they would send, not a template they have to rewrite.\n\n${BRAND}\n\n${contactBlock(await companyProfile())}\n\n${VOICE}\n\n**Never state a fault you were not given.** Every negative thing this email says about their business must trace to one of the facts above, and those facts carry their own evidence in brackets — a URL, a header, a DNS record. If a fault is not in the list, it was not found, and "not found" is not the same as "not there": you have no idea, and a confident wrong claim about somebody's own business is read as a lie by the one person who knows the truth. A letter saying "your website did not load" to a company whose website loads is not a bad email, it is a false statement about them, and it ends the relationship at the first line.

The list is also the complete account of what was checked. Anything absent from it was not looked at.

Never invent a fact about the recipient. If the facts you were given are thin, write a shorter email; do not fill the space with claims. Return the body as plain text with blank lines between paragraphs — the app renders it and appends the signature.`,
    prompt: () => buildPrompt(request),
    schema: SCHEMA as unknown as Record<string, unknown>,
    effort: "medium",
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
