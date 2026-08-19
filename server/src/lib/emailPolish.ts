import type { EmailPurpose } from "@prisma/client";
import { callModel } from "./models/call.js";
import { PROVIDERS } from "./models/registry.js";
import { VOICE as BRAND_VOICE } from "../services/dakyworld.js";

/**
 * The last pass before a person reads the draft.
 *
 * The drafter's job is to pick the right facts and make the right argument.
 * That is not the same job as making four sentences sound like a person wrote
 * them, and a model doing both at once does the second one badly — the tells
 * are always the same, and they are always in the second half of the sentence.
 *
 * So the draft goes to whoever serves the `humanise` job, which is Perplexity
 * by default, with one instruction that matters more than the rest: **change
 * how it is said, never what it says.** Perplexity searches the live web on
 * every call, which makes it the right model for reading like a person and a
 * genuinely dangerous one for editing a letter — it can find a fact and put it
 * in, and that fact will be a claim about the recipient's own business made by
 * a machine that was never given it. The prompt forbids it, the schema makes
 * it declare anything it added, and the composer shows the person both
 * versions before anything is sent.
 *
 * It also answers a second question the drafter cannot answer about itself:
 * does this email do its job. One ask, small, at the end; an opening that
 * earns the read; nothing that could be cut. That judgement comes back as a
 * verdict a person can act on rather than a rewrite they have to diff.
 */

export interface PolishResult {
  subject: string;
  body: string;
  /** What was changed and why — one line each, not a diff. */
  changes: string[];
  /** Does this email do the job it was written for. */
  servesPurpose: boolean;
  /** Why not, or what is still weak. Empty when it is fine. */
  concerns: string[];
  /**
   * Anything the polish put in that was not in the draft. Should always be
   * empty; it is here because "should" is not a guarantee, and a reviewer who
   * can see the answer does not have to take it on trust.
   */
  added: string[];
  /** Who polished it, since the fallback may have. */
  polishedBy: string;
  costUsd: number;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "changes", "servesPurpose", "concerns", "added"],
  properties: {
    subject: { type: "string", description: "The subject line, polished or unchanged. Six words or fewer." },
    body: {
      type: "string",
      description: "The polished email body as plain text, blank line between paragraphs. No signature block, no HTML.",
    },
    changes: { type: "array", items: { type: "string" }, description: "What you changed and why. One line each." },
    servesPurpose: {
      type: "boolean",
      description: "True only if this email, as you are returning it, does the job it was written for.",
    },
    concerns: {
      type: "array",
      items: { type: "string" },
      description:
        "What is still weak, for the person about to send it — a vague ask, an opening that could be about any business, a claim you were not comfortable with. Empty when there is nothing.",
    },
    added: {
      type: "array",
      items: { type: "string" },
      description:
        "Anything in your version that was not in the draft you were given, verbatim. Normally empty. Never leave something out of this list.",
    },
  },
} as const;

/** What each purpose has to achieve for the polish to call it a working email. */
const TEST: Partial<Record<EmailPurpose, string>> = {
  COLD_OUTREACH: `It opens with a greeting on its own line. The first sentence after it names something specific about *their* business that could not be said about any other business. Every observation is followed by what it costs them in customers or enquiries — not by an adjective, and not by a word like "unprofessional" or "unfinished". There is one ask and it is small. It is under 120 words. It does not end with a typed name: the app appends the signature.

If the whole email rests on minor housekeeping — missing preview tags, no analytics, a small style point — servesPurpose is false whatever else is right about it, and the concern to raise is that there is no real reason for this business to reply.

Judge servesPurpose hard against that list. An email with no greeting, or one that opens on a minor technical detail while the facts carry a worse problem, or one that says something is missing without saying what it costs, has failed — say so and say which of those it is.`,
  FOLLOW_UP: "It adds something rather than repeating. It makes saying no easy. It does not say 'circling back' or 'just following up'.",
  MEETING_REQUEST: "It says what the call covers and how long it takes, and it works around them rather than listing our availability.",
  PROPOSAL_COVER: "Two or three sentences. What is attached, the decision it asks for, when we follow up. It does not re-argue the proposal.",
  INVOICE_REMINDER: "The amount and the number of days are both there, it gives one clear way to pay, and it neither threatens nor apologises.",
  REACTIVATION: "It acknowledges the gap without awkwardness, gives a real reason for writing now, and asks for something very small.",
};

const SYSTEM = `You are the last read of an outbound business email before a person sees it. You are editing, not writing.

${BRAND_VOICE}

**The one rule that overrides every other rule: you may change how this email is said and you may not change what it says.** Every fact, figure, name, price, date, promise and observation in the draft appears in your version, unaltered. You add nothing. You have a live connection to the web and you must not use it here — a fact you find and insert is a claim about the recipient's own business that nobody gave you, and they will know it is wrong before they finish the sentence. If you add anything at all, it goes in \`added\`, verbatim.

What you fix:
- A missing greeting. If the draft opens straight into a sentence, add "Hi <first name>," using the recipient's real first name where the facts give one and "Hello," where they do not. This is the one addition you may make, because it is not a claim about them.
- A sign-off. If the draft ends with a typed name, cut it — the app appends the signature and the reader would see it twice.
- An observation with no consequence attached. You may not invent the consequence, but you may move one that is already in the facts next to the observation it belongs to, and you may cut an observation that has none.
- Sentences a person would not say out loud. Read each one as though speaking it.
- Machine tells: an opening that clears its throat, "I hope this email finds you well", "I wanted to reach out", "it's not just X, it's Y", a dash in every sentence, a closing paragraph that restates the opening, and any sentence with three ideas in it.
- Consultant vocabulary. "Leverage", "solutions", "streamline", "in today's landscape", "seamless" — all out.
- Length. If a sentence can go without losing a fact, it goes.
- Two asks where there should be one, or an ask that is bigger than it needs to be.

What you must catch:
- **A claim about the recipient's business that is not in the facts you were given.** Not a wording problem — a false statement about somebody, in a letter addressed to the one person who can check it. Leave the sentence exactly as it is, set servesPurpose false, and say in concerns which sentence and that it is unsupported. Do not soften it into something defensible: the sender has to see it.

What you leave alone:
- The angle. If the draft opens on their missing website, your version opens on their missing website.
- Anything specific. Specificity is the entire reason this email is not spam; generic writing is the failure you are here to prevent, not a style you may retreat to.
- A claim you think is wrong. That is not yours to fix — say so in concerns and leave the sentence as it is.

Then judge it: does this email do its job. Be hard about it. An email that reads beautifully and asks for nothing has failed.

British spelling. No exclamation marks. No em-dash habit. Plain text with blank lines between paragraphs.`;

export interface PolishRequest {
  subject: string;
  body: string;
  purpose: EmailPurpose;
  /** Who it goes to, so the polish knows what register to keep. */
  recipient?: string | null;
  /** The facts the draft was written from. Given so it can tell a fact from an invention. */
  facts?: string[];
}

export async function polishEmail(request: PolishRequest): Promise<PolishResult> {
  const test = TEST[request.purpose];
  const result = await callModel<{
    subject: string;
    body: string;
    changes: string[];
    servesPurpose: boolean;
    concerns: string[];
    added: string[];
  }>({
    purpose: "email.polish",
    job: "humanise",
    system: SYSTEM,
    prompt: () =>
      [
        `What this email is for: ${request.purpose.replace(/_/g, " ").toLowerCase()}.`,
        test ? `It works if: ${test}` : "",
        request.recipient ? `It goes to: ${request.recipient}` : "",
        request.facts?.length
          ? `Everything the writer was given about the recipient. Nothing outside this list may appear in the email — that is how you tell a fact from an invention:\n${request.facts
              .map((fact) => `- ${fact}`)
              .join("\n")}`
          : "",
        "",
        "The draft:",
        `Subject: ${request.subject}`,
        "",
        request.body,
      ]
        .filter((part) => part !== "")
        .join("\n"),
    schema: SCHEMA as unknown as Record<string, unknown>,
    effort: "medium",
    maxTokens: 4000,
    messages: {
      noKey: "No model is connected for the plain-English pass. Add a Perplexity key under Settings → AI models, or send the draft as it is.",
      refusal: "The polish declined this draft. Send it as it is, or rewrite it by hand.",
      empty: "The polish returned nothing. The draft above is unchanged.",
      truncated: "The polish ran out of room. The draft above is unchanged.",
    },
  });

  return {
    subject: result.data.subject?.trim() || request.subject,
    body: result.data.body?.trim() || request.body,
    changes: (result.data.changes ?? []).filter((entry) => entry.trim()),
    servesPurpose: result.data.servesPurpose !== false,
    concerns: (result.data.concerns ?? []).filter((entry) => entry.trim()),
    added: (result.data.added ?? []).filter((entry) => entry.trim()),
    polishedBy: PROVIDERS[result.provider].name,
    costUsd: result.costUsd,
  };
}
