import type { EmailPurpose, MessageChannel } from "@prisma/client";
import { callModel } from "./models/call.js";
import { smsCost, toGsm7 } from "./phone.js";
import { VOICE as BRAND_VOICE } from "../services/dakyworld.js";
import { brandBlock } from "../services/context/business.js";
import { PHONE_MESSAGE_DOCTRINE } from "../services/outreachDoctrine.js";
import { companyProfile, contactBlock } from "../services/systemProfile.js";
import { writerSystem } from "../services/writers/brief.js";
import { ownDomain } from "../services/emailContext.js";
import type { RecipientContext } from "../services/emailContext.js";
// Type only. `services/leadPrep.ts` pulls in Apify, the audit team and the
// screenshot actor, and none of that belongs behind a drafter — an import that
// erases at compile time is the whole of what is wanted here.
import type { CaseStrength } from "../services/leadPrep.js";

/**
 * The WhatsApp and SMS drafter.
 *
 * **This file is part of the cold email playbook surface** — see the note in
 * CLAUDE.md. It writes an instruction another writer reads, so every rule the
 * playbook overturned has to be overturned here too, or a v3 email and a v2
 * WhatsApp go to the same prospect from the same company on the same day. The
 * four that matter: identify yourself first, say what it makes *harder* rather
 * than what it has cost, no price, and the ask offers something rather than
 * requesting time.
 *
 * What is *not* shared with email is the shape, and the difference is larger
 * than it looks:
 *
 *  - **There is no signature.** An email is topped and tailed by the app —
 *    letterhead, sign-off, contact block. A WhatsApp message is a bubble in a
 *    chat, and a message that ends without saying who sent it is from an
 *    unknown number. So the name goes *in* the words, which is the one place
 *    the email drafter is explicitly forbidden from putting it.
 *  - **It is a chat, not a letter.** Four paragraphs with blank lines between
 *    them arrives as a wall in a chat window and reads as a broadcast. Two
 *    short bursts is the whole message.
 *  - **An SMS is billed by the character and the cliff is invisible.** 160
 *    GSM-7 characters is one segment; 161 is two; one curly apostrophe pasted
 *    in from a word processor re-encodes the lot as UCS-2 and drops the limit
 *    to 70. So the SMS draft is measured after it is written, and the
 *    smart-quote characters are converted rather than left to triple the bill.
 *  - **Intrusion is higher and patience is shorter.** An unread email sits in
 *    a list. An unread WhatsApp is a notification on a phone somebody is
 *    holding. That earns brevity, and it earns an opt-out line that this app
 *    appends rather than trusting a model to remember.
 */

export interface MessageDraftRequest {
  channel: MessageChannel;
  purpose: EmailPurpose;
  context: RecipientContext;
  /**
   * How strong the evidence behind this message is.
   *
   * Worked out by `caseStrength()` from the review when there is one and from
   * the two quick checks when there is not, and **it was computed and thrown
   * away**: `POST /messages/draft` had it, returned it to the screen so the
   * composer could print the amber warning, and never told the drafter. So a
   * business with nothing wrong with it got a confident forty-word pitch,
   * because a model asked to write a message writes one — the same failure the
   * email side already names in `buildFacts()`, minus the one line that fixes
   * it. Null means nobody worked it out, which is not the same as WEAK and is
   * left unsaid rather than guessed at.
   */
  caseStrength?: CaseStrength | null;
  /** What this particular message is for, in the sender's words. */
  brief?: string | null;
  /** Rewrite an existing draft rather than starting from nothing. */
  existingBody?: string | null;
  /** Extra facts the sender is supplying by hand. */
  extraFacts?: string[];
}

export interface MessageDraftResult {
  body: string;
  rationale: string;
  confidence: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Set on an SMS draft: what it will actually be billed as. */
  cost?: ReturnType<typeof smsCost>;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body", "rationale", "confidence"],
  properties: {
    body: {
      type: "string",
      description:
        "The message as plain text. It names the sender in the first line, because it arrives from a number the reader does not have saved. No subject line, no sign-off, no signature block, and no closing name — the name is already in the opening.",
    },
    rationale: {
      type: "string",
      description: "One or two sentences for the person reviewing this: which facts you used, and why this angle.",
    },
    confidence: {
      type: "number",
      description:
        "0 to 1 — how well the supplied facts supported a specific message. Low when you had almost nothing to work with, which tells the reviewer to add detail rather than send it.",
    },
  },
} as const;

/** The shared half of the voice comes from services/dakyworld.ts; this is the phone-channel half. */
const VOICE = `${BRAND_VOICE}

For a message on somebody's phone specifically:

- **Say who is writing in the first line, by name and company.** "Hi Kwame — Daky here, from Dakyworld." There is no letterhead, no signature and no sender address: if the words do not say who this is, the reader is looking at an unknown number, and an unknown number asking a question is deleted. This is the single most important rule on this channel, and it is the one an email drafter would get wrong, because an email appends all of that automatically.
- **Never open on the observation.** On a channel this personal, a stranger who leads with something they noticed about your business reads as a scam before it reads as helpful.
- **Two short bursts, not four paragraphs.** One that says who you are and what you noticed; one that asks. A message that fills the screen before the reader has decided who you are is a broadcast.
- **One thing noticed, and what it makes harder for them.** Not what it has cost them — that states an outcome nobody has measured to the one person who can check it. "People on a phone have to type your number out by hand" is the shape.
- **One ask, at the end, and it offers something.** The screenshot, the exact setting, the short list. Never a meeting, never a call, never "do you have 15 minutes" — time is the largest thing you can ask of somebody who has not agreed there is a problem, and on a chat channel it is also the fastest way to be blocked.
- **No price.** Not a range, not "from", not "starting at".
- **No links unless the link is the thing being offered.** A first message from an unknown number carrying a URL is what a scam looks like here, and it is what a network's spam filter looks for.
- **No emoji.** They read as marketing on a business message, and on SMS a single one re-encodes the whole text and triples what it costs to send.
- **Plain words.** No SPF, DMARC, DNS, SEO, metadata, Open Graph, LCP, schema, viewport, canonical, TLS. The reader owns a business; they do not own a terminal.
- **No greeting-and-blank-line formality.** This is a chat. "Hi Kwame —" and straight on.`;

const LENGTH: Record<MessageChannel, string> = {
  WHATSAPP:
    "**35 to 70 words. Not one word more.** That is roughly four lines on a phone, which is what fits above the fold of a notification and what a stranger will read before deciding. Anything longer is scrolled past.",
  SMS: "**Under 300 characters, and under 160 if it can be said in 160** — 160 is one message, and everything past it is a second one charged separately. Count as you write. No line breaks beyond one; a text is a single block.",
};

const CHANNEL_NOTE: Record<MessageChannel, string> = {
  WHATSAPP:
    "This is going to WhatsApp. It will arrive as a chat bubble from a number they have not saved, on a phone they are holding.",
  SMS: "This is going out as a text message. It will arrive alongside their bank alerts and their mobile-money receipts, from a short sender name. There is no formatting: no bold, no bullets, no links that will be clickable in every handset.",
};

/**
 * What each purpose is trying to do on this channel.
 *
 * Deliberately shorter than the email equivalents and deliberately not shared
 * with them. The email briefs describe a four-paragraph letter; pasting one in
 * here would ask for a letter and get one, in a chat window.
 */
const PURPOSE_BRIEF: Partial<Record<EmailPurpose, string>> = {
  COLD_OUTREACH: `A first message to somebody who has never heard of Dakyworld, on a channel they use with people they know.

1. Who you are, by name and company, in the first line.
2. One thing you noticed about their business, and what it makes harder for whoever is trying to reach them. One thing only.
3. One question, answerable with a yes, that offers them something rather than asking for their time.

Never list findings. Never describe the service catalogue. No price. No meeting.

If the facts carry a line saying THERE IS NO STRONG CASE HERE, do not send a pitch: say the true good thing about their setup in one sentence, offer the one small thing actually found, set confidence low, and say in the rationale that this business may not be worth writing to at all.`,
  FOLLOW_UP: `A follow-up to a message that was not answered. They are busy, not uninterested.

**It carries something the last one did not** — the screenshot that was offered, the setting, the example. A message whose entire content is that you are still waiting is worse than silence, and on this channel it is what gets a number blocked. Never "just checking in", "circling back" or "following up on my last message".

Keep it to two sentences. Raising a second issue makes it a new cold approach wearing a thread.`,
  MEETING_REQUEST:
    "They have already engaged and a conversation is the sensible next step. Say what the call would cover and how long it takes, and offer to work around them. This is the one purpose where asking for time is right, because they have already agreed there is something to talk about.",
  DEMO_READY:
    "A demo page has been built for them and this message carries the link. The link is the whole message: one sentence saying what it is, the link, and one line making clear it is a concept built for them rather than anything live.",
  INVOICE_DELIVERY:
    "An invoice has gone out. Neutral and administrative: the number, the amount, and where to pay it. Two sentences. No apology for invoicing.",
  INVOICE_REMINDER:
    "A payment is late. Polite, unembarrassed, specific about the amount and how many days. Assume it was overlooked. One clear way to settle it. No threat and no apology for asking. This is the message SMS is genuinely best at — it gets read.",
  PROJECT_UPDATE: "A short progress note on live work. What moved, what is next, and whether anything is needed from them.",
  THANK_YOU: "A short, specific thank you. One sentence on what for. No upsell attached to it — an ask here undoes the message.",
  ONBOARDING: "The first message after they said yes. What happens next, and the one thing needed from them to start.",
  REACTIVATION:
    "Somebody who went quiet a while ago. Give a real reason for writing now — something that changed, something noticed — never 'it's been a while'. Make it easy to say no.",
  CUSTOM: "Follow the sender's brief below. Keep the voice and the length rules whatever it asks for.",
};

function briefFor(purpose: EmailPurpose): string {
  return (
    PURPOSE_BRIEF[purpose] ??
    "Write what this message is for, plainly and briefly, keeping the voice and length rules above."
  );
}

// --- What a forty-word message is allowed to be told ------------------------

/**
 * **The facts are written for a letter, and this is where that stops being
 * somebody else's problem.**
 *
 * `leadPrep.buildFacts()` composes the evidence for a cold *email*, and it says
 * so in the words: "THE FULL REVIEW WAS RUN AND THIS LETTER ARGUES FROM IT",
 * "put it in the letter on its own line", "Never put that number in the
 * letter", "a few other things came up — I have put them in a short report and
 * attached it". That block is exactly right for the thing it was written for
 * and it was being handed, unchanged and in full, to a writer producing forty
 * words in a chat window with no attachment, no letterhead and no room.
 *
 * Two separate faults came out of that, and only the second one is obvious:
 *
 *  - **It is instructions for a different job.** A model told at length how to
 *    structure a letter, and then told to write a WhatsApp, does what this
 *    codebase has already paid for twice — it retreats to the generic message
 *    it already knew. That is the reported symptom: drafts that read as though
 *    nobody had looked at the business, from a prompt containing everything
 *    anybody found out about it.
 *  - **Twenty-five lines to write thirty-five words is not context, it is
 *    noise.** The strongest finding, the guard on what may not be claimed and
 *    the demo link are in there — somewhere, in the middle of the pipeline's
 *    own bookkeeping, the lead score and every finding the review turned up.
 *    A writer with one sentence to spend needs to be told which one thing to
 *    spend it on, not handed the file.
 *
 * So the lines are **selected, never rewritten**. Rewriting is the tempting
 * version and it is wrong: swapping "letter" for "message" across the block
 * would turn "We already emailed them 3 days ago" — a true statement about
 * what this company did — into a false one, and a fact that has been edited on
 * its way to a model is a fact nobody can trace back to the record.
 */

/**
 * Lines that exist to shape a letter and mean nothing on a phone.
 *
 * Matched on the marker `buildFacts` and `reviewFacts` actually write. They are
 * dropped rather than reworded for the reason above, and dropping them loses no
 * evidence: everything they frame — the strongest point, the findings, the
 * redesign call — is emitted separately and kept.
 */
const LETTER_ONLY = [
  "THE FULL REVIEW WAS RUN",
  "HOW THE REVIEW PUT IT TO THEM",
  "MORE THAN ONE RED FLAG",
];

/**
 * Lines about our own pipeline rather than about them.
 *
 * A lead score, a deal size and a pipeline stage are facts about how Dakyworld
 * files this business, and the drafter is told the facts are the only things it
 * may use — which makes every one of them a sentence a model is entitled to
 * reach for. "I see you're in our qualifying stage" is not a message anybody
 * should be able to send by accident.
 */
const INTERNAL_ONLY = [
  "Which list:",
  "Pipeline status:",
  "Lead score",
  "Estimated deal size:",
  "How we found them:",
];

/**
 * What a message of this length is actually written from, in the order a writer
 * needs it: who they are, the one thing to say, what may not be said, what to
 * offer — then whatever is left, up to a ceiling.
 */
const LEADS_WITH = [
  "THE STRONGEST THING TO OPEN ON",
  "THERE IS NO STRONG CASE HERE",
  "WHAT YOU MAY NOT CLAIM",
  "THE REVIEW'S OWN VIEW IS THAT THERE IS NOTHING TO OFFER HERE",
  "WHAT TO OFFER",
  "THEY HAVE NO WEBSITE, SO THE DEMO PAGE IS THE ASK",
  "A demo page has been built for them",
  "NOBODY HAS ACTUALLY SEEN THEIR PAGE",
  "Nobody has looked at this business yet",
  "WHAT THE PAGE ITSELF IS WORTH",
  "WORTH PAYING TO FIX",
  "Contact name:",
  "Business:",
  "Business type:",
  "City:",
  "Website:",
  "Google rating:",
  "What research found about them",
];

/**
 * How many of the remaining lines to carry.
 *
 * Eight, against a message of thirty-five to seventy words. Not a token
 * saving — the whole prompt is a fraction of a penny either way — but the
 * difference between a writer that has been told what to say and one that has
 * been handed a file and left to choose. Everything cut is named in a line of
 * its own, so a reviewer asking "did it see the certificate finding" gets an
 * answer rather than an absence.
 */
const SUPPORTING_LIMIT = 8;

function startsWithAny(fact: string, markers: string[]): boolean {
  return markers.some((marker) => fact.startsWith(marker));
}

export function phoneFacts(facts: string[]): string[] {
  const kept: string[] = [];
  const supporting: string[] = [];

  for (const marker of LEADS_WITH) {
    for (const fact of facts) {
      if (fact.startsWith(marker) && !kept.includes(fact)) kept.push(fact);
    }
  }

  for (const fact of facts) {
    if (kept.includes(fact)) continue;
    if (startsWithAny(fact, LETTER_ONLY) || startsWithAny(fact, INTERNAL_ONLY)) continue;
    supporting.push(fact);
  }

  const shown = supporting.slice(0, SUPPORTING_LIMIT);
  const heldBack = supporting.length - shown.length;

  return [
    ...kept,
    ...shown,
    ...(heldBack > 0
      ? [
          `${heldBack} further thing${heldBack === 1 ? " was" : "s were"} found and ${
            heldBack === 1 ? "is" : "are"
          } deliberately not listed here. A message this short names one thing, so the rest would only be something to choose wrongly between. Do not refer to them, do not count them, and do not say there is more.`,
        ]
      : []),
  ];
}

/**
 * Which of the two messages this is.
 *
 * The email drafter has had this since August and the phone drafter never did,
 * which is most of why a WhatsApp read as though it had been written about
 * nobody in particular. It is the one distinction no amount of evidence can
 * make, because it is about the *absence* of it: a business with no website is
 * a different message from a business whose website somebody has looked at, and
 * on forty words the choice between those two is nearly the whole draft.
 *
 * Deliberately shorter than `emailDrafter.angle()` and deliberately not shared
 * with it. That one describes a four-paragraph letter, and a writer given a
 * letter's angle writes a letter — in a chat window.
 */
function angle(context: RecipientContext): string | null {
  if (context.kind !== "lead") return null;

  if (!context.variables.website?.trim()) {
    return `They have no website. That is the message.

One line on what that means for this business specifically — somebody hears about them, searches, and there is nothing to look at before deciding whether to ring. Use their trade and their town by name; those two words are what make it about them.

**If the facts carry a demo link, the link is the ask** and it is the only ask: say you put a page together, give the address, and ask what they think. If they carry no link, no page exists — offer to put one together, and never write as though one is coming.`;
  }

  return `They have a website and somebody has looked at it.

Open on the one thing named as the strongest, and on nothing else. Not a list, not two things, not "among other things".

**Say something the owner can see, not something a tool measured.** A record, a header, a certificate, a tag — all true, and worth nothing to somebody reading a message on a phone, because they cannot picture any of them. What they can picture is a person opening their page and not finding what they came for. Where a fact carries a "say it to them like this" wording, use that wording: it is already in words a business owner would use.`;
}

/**
 * How much weight the evidence will bear.
 *
 * WEAK and NONE are the ones that matter, and the wording is deliberately the
 * same instruction the email side gives, because it is the same judgement: a
 * business that is doing fine, told by a stranger on their own phone that it is
 * not, remembers that.
 */
function strengthNote(strength: CaseStrength | null | undefined): string | null {
  if (!strength) return null;
  if (strength === "STRONG") {
    return "The evidence here is strong. Write the whole message about the single thing named as strongest, and leave everything else out.";
  }
  if (strength === "MODERATE") {
    return "The evidence here is moderate — one real thing, and no more weight on it than it will bear. Say it plainly and do not dress it up into an emergency.";
  }
  return "**There is no real case here.** Nothing found is worth writing to a stranger about. Do not write a pitch. Say the one true good thing about their set-up in a sentence, offer the one small thing that was actually found, set confidence low, and say in the rationale that this business may not be worth messaging at all. A polished message about nothing is worse than no message.";
}


/**
 * The doctrine Dakyworld ships for a message to a phone.
 *
 * A default, not the authority: `outreach.writer`'s own wording replaces it as
 * soon as somebody edits that agent — see `services/writers/brief.ts`. The
 * channel mechanics below are deliberately *not* in here, because a rewritten
 * voice must not be able to take the segment limit or the opt-out rule with it.
 */
/**
 * The doctrine for a first message to a phone.
 *
 * Lives in `services/outreachDoctrine.ts` with the two email doctrines, because
 * the three are one system that has to agree with itself — keeping them in
 * separate files is how the polish stage ended up enforcing a rule the drafter
 * had already dropped.
 */
export const SHIPPED_DOCTRINE = PHONE_MESSAGE_DOCTRINE;

/**
 * The mechanics, which no prompt edit can reach.
 *
 * The opt-out rule is the one that matters most: the app appends it, so a
 * model that writes its own produces two, and a model told not to bother
 * because somebody rewrote the voice produces a marketing message to a phone
 * with no way out of it. That is a compliance property of this system, not a
 * matter of style, and it belongs on this side of the line.
 */
function contractFor(channel: MessageChannel): string {
  return `${CHANNEL_NOTE[channel]}

${LENGTH[channel]}

Return the body as plain text. Do not add a sign-off, a name at the end, or an opt-out line — the app appends the opt-out itself, and the name belongs in your opening.

**If anything you write is informed by a live search, that search may only confirm.** This job is served by a model that reads the web as it answers. What comes back may tell you a fact you were given is still true, and it may never introduce one: not a fault, not a figure, not a person's name, not a claim about this business that is absent from the facts below. The facts are the complete account of what was checked, and the one person reading this message is the one person who knows what is actually true about their own business.`;
}

async function draftSystem(channel: MessageChannel): Promise<string> {
  const profile = await companyProfile();
  return writerSystem("message.phone", SHIPPED_DOCTRINE, {
    facts: [await brandBlock(), contactBlock(profile)],
    contract: contractFor(channel),
  });
}

/**
 * The facts this channel is actually written from.
 *
 * **Only a lead's are selected from, and the distinction is not a detail.** A
 * lead carries a letter's evidence pack — a scan, a review, a dozen findings —
 * of which one thing is the message. A client carries invoices, projects, care
 * plans and milestones, and on a client message *any* of them may be the entire
 * point: capping those would be a payment reminder that never reaches the
 * overdue invoice, which is a worse failure than the one this selection exists
 * to fix.
 *
 * Exported because `POST /messages/draft` hands the facts to the composer for a
 * person to check the draft against, and returning a list the writer never saw
 * is a quiet lie on the one screen where somebody decides whether the message
 * is true.
 */
export function factsForMessage(context: RecipientContext): string[] {
  return context.kind === "lead" ? phoneFacts(context.facts) : context.facts;
}

function buildPrompt(request: MessageDraftRequest): string {
  const { context } = request;

  const parts = [
    `Purpose: ${request.purpose.replace(/_/g, " ").toLowerCase()}`,
    briefFor(request.purpose),
    "",
    "Everything you may use about the recipient, strongest first. These are the only facts you may use — you may leave any of them out, but you may not add to them:",
    factsForMessage(context)
      .map((fact) => `- ${fact}`)
      .join("\n"),
  ];

  // Decided in code for the same reason as in the email drafter: `firstName`
  // already knows that "Accra Dental Centre" in the contact field is a company
  // rather than a person, and "Hi Accra —" ends a message at the first word.
  const first = context.variables.first_name;
  parts.push(
    "",
    first && first !== "there"
      ? `Open by addressing them as "${first}", and name yourself and Dakyworld in that same first line.`
      : "No first name is known for this person, so do not use one. Open by naming yourself and Dakyworld, then go straight to what you noticed.",
  );

  // The eighteen-scenario playbook was removed in Aug 2026; what replaced it is
  // not "let the model decide from a list", which is what this file actually
  // did for a year. See `services/outreachDoctrine.ts` for the doctrine, and
  // `angle()` above for the one choice that is still made in code.
  //
  // **A first approach only.** The angle tells the writer to open on the single
  // strongest observation, which is exactly what a follow-up must not do (it
  // keeps the same issue and brings something new) and exactly what a
  // demo-ready message must not do (the link is the whole message). Emitting it
  // alongside either brief would put two accounts of one message in front of
  // the model, and a model given two does not merge them — it falls back to the
  // generic one. That failure is already written up twice in this repository.
  const chosen = request.purpose === "COLD_OUTREACH" ? angle(context) : null;
  if (chosen) parts.push("", "Which message this is:", chosen);

  // Cold and follow-up only, for the same reason: how far the evidence goes is
  // a question about writing to a stranger. It has no bearing on a demo link,
  // an invoice or a thank-you, and a "there is no real case here" note attached
  // to a payment chase is an instruction not to send one.
  const strength =
    request.purpose === "COLD_OUTREACH" || request.purpose === "FOLLOW_UP" ? strengthNote(request.caseStrength) : null;
  if (strength) parts.push("", "How far the evidence goes:", strength);

  if (request.extraFacts?.length) {
    parts.push("", "The sender has added these facts for this message specifically:", request.extraFacts.map((fact) => `- ${fact}`).join("\n"));
  }
  if (request.brief?.trim()) {
    parts.push("", `What the sender wants this message to do, in their words:\n${request.brief.trim()}`);
  }
  if (request.existingBody?.trim()) {
    parts.push("", "There is already a draft. Rewrite it — keep anything specific and true, fix what is generic, long, or off-voice:", request.existingBody.trim());
  }

  parts.push("", `Write the ${request.channel === "SMS" ? "text message" : "WhatsApp message"}.`);
  return parts.join("\n");
}

/**
 * The whole instruction, composed.
 *
 * Exported for the same reason as `buildColdEmailPrompt`: "the drafts still
 * read the same" is a question about what the model was actually told, and the
 * only honest way to answer it is to print what it was told. `tmp/writerAudit.ts`
 * is where that gets asserted.
 */
export async function buildMessagePrompt(request: MessageDraftRequest): Promise<{ system: string; user: string }> {
  return { system: await draftSystem(request.channel), user: buildPrompt(request) };
}

export async function draftMessage(request: MessageDraftRequest): Promise<MessageDraftResult> {
  const system = await draftSystem(request.channel);

  const { data, model, inputTokens, outputTokens } = await callModel<{ body: string; rationale: string; confidence: number }>({
    purpose: "message.draft",
    // **`outreach`, not `text`** — the Owner's call, and the first thing in
    // this file that is a routing decision rather than a wording one. A first
    // message to a stranger is judged on whether it sounds like somebody who
    // went and looked, so it is served by the vendor that reads the live web
    // while it answers, with the free writing ladder behind it. Never a vendor
    // name here: which company serves this is a row in a settings table.
    job: "outreach",
    system,
    prompt: () => buildPrompt(request),
    schema: SCHEMA as unknown as Record<string, unknown>,
    // Read only their own site, when we know it. The fence is what makes a
    // searching model safe on a job whose whole discipline is "claim nothing
    // that was not checked" — see `searchFence`.
    searchDomains: ownDomain(request.context),
    // High, for the same reason the cold email is: this is forty words that a
    // stranger judges the company by, and the difference in cost between the
    // two settings on forty words is a fraction of a penny.
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

  // Smart quotes and en-dashes arrive in nearly every model's prose and are the
  // usual reason a 150-character text is billed as three. Converted rather than
  // flagged: the replacement reads identically and nobody would ever choose to
  // pay triple for the curl on an apostrophe.
  const body = request.channel === "SMS" ? toGsm7(data.body.trim()) : data.body.trim();

  return {
    body,
    rationale: data.rationale,
    confidence: data.confidence,
    model,
    inputTokens,
    outputTokens,
    cost: request.channel === "SMS" ? smsCost(body) : undefined,
  };
}
