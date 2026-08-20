import type { EmailPurpose, MessageChannel } from "@prisma/client";
import { callModel } from "./models/call.js";
import { smsCost, toGsm7 } from "./phone.js";
import { BRAND, VOICE as BRAND_VOICE } from "../services/dakyworld.js";
import { chooseScenario, scenarioForPrompt } from "../services/coldEmailScenarios.js";
import { companyProfile, contactBlock } from "../services/systemProfile.js";
import type { RecipientContext } from "../services/emailContext.js";

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
  /** Force a playbook scenario rather than letting the findings choose. */
  scenarioKey?: string | null;
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

async function draftSystem(channel: MessageChannel): Promise<string> {
  const profile = await companyProfile();
  return `You write short outbound messages for one specific company, sent to a phone. Every draft is read by a person before it is sent — write the message they would send, not a template they have to rewrite.

${CHANNEL_NOTE[channel]}

${BRAND}

${contactBlock(profile)}

${VOICE}

${LENGTH[channel]}

**Never state a fault you were not given.** Every negative thing this message says about their business must trace to one of the facts you are handed. If a fault is not in that list it was not found, and "not found" is not "not there" — you have no idea, and a confident wrong claim about somebody's own business, sent to their personal phone, is read as a lie by the one person who knows the truth.

The list is also the complete account of what was checked. Anything absent from it was not looked at.

Never invent a fact about the recipient. If the facts are thin, write a shorter message; do not fill the space with claims. Return the body as plain text. Do not add a sign-off, a name at the end, or an opt-out line — the app appends the opt-out itself, and the name belongs in your opening.`;
}

function buildPrompt(request: MessageDraftRequest): string {
  const { context } = request;

  const parts = [
    `Purpose: ${request.purpose.replace(/_/g, " ").toLowerCase()}`,
    briefFor(request.purpose),
    "",
    "Everything known about the recipient. These are the only facts you may use — you may leave any of them out, but you may not add to them:",
    context.facts.map((fact) => `- ${fact}`).join("\n"),
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

  // One or the other, never both — the scenario and the angle are two answers
  // to the same question, and a model given both falls back to the generic
  // message it already knew. See the same note in lib/emailDrafter.ts.
  const scenario =
    request.purpose === "COLD_OUTREACH" && context.findingIds?.length
      ? chooseScenario(context.findingIds, request.scenarioKey ?? null)
      : null;
  if (scenario) {
    parts.push(
      "",
      scenarioForPrompt(scenario),
      "",
      "That scenario was written for an email. Take the argument and the guard from it, not the length or the shape — this is a message on a phone and the rules above win on both.",
    );
  }

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
    // Prose, routed with everything else the system writes — never a vendor.
    job: "text",
    system,
    prompt: () => buildPrompt(request),
    schema: SCHEMA as unknown as Record<string, unknown>,
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
