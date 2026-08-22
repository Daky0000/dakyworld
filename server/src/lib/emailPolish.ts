import type { EmailPurpose } from "@prisma/client";
import { callModel } from "./models/call.js";
import { PROVIDERS } from "./models/registry.js";
import { VOICE as BRAND_VOICE } from "../services/dakyworld.js";
import { resolveBrief } from "../services/writers/brief.js";
import { emailJobFor } from "../services/writers/registry.js";

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

/**
 * What each purpose has to achieve for the polish to call it a working email.
 *
 * **These are the shipped defaults and they are not the authority.** The
 * standard the polish judges against is resolved through
 * `services/writers/brief.ts`, which hands back the owning agent's own
 * instruction the moment somebody has edited it — so the drafter and the
 * polish are held to one doctrine rather than two.
 *
 * That is not a tidiness argument. The polish runs *after* the drafter and
 * rewrites the text, which makes it the last writer and therefore the one that
 * sets the house style whatever the first one was told. When this table held
 * its own private copy of the checklist it went on enforcing the previous
 * doctrine over the top of the new one — deleting the self-introduction the
 * playbook requires and restoring the predictions it forbids — and the symptom
 * was a founder rewriting the drafter's prompt and seeing no change at all.
 * A second copy of a doctrine is a second doctrine.
 */
const TEST: Partial<Record<EmailPurpose, string>> = {
  COLD_OUTREACH: `The current cold outreach doctrine — \`services/outreachDoctrine.ts\`. It works if all of this is true:

- It opens with a greeting on its own line.
- **It opens on them, not on us.** The first thing after the greeting is the specific thing that was observed about *their* business — not who we are and not what Dakyworld does. Leading with ourselves is the commonest reason a stranger stops reading.
- **Dakyworld is nevertheless named inside the first three lines**, immediately after the observation. This is required and is checked before the email can be sent. Do not cut it as throat-clearing: an anonymous remark about somebody's website reads as a threat rather than a favour.
- **The personalisation is load-bearing.** Remove the specific observation and the email should collapse. If it would still read fine, it is a template with a field swapped in.
- The observation is followed by **what it makes harder for them**, never by what it has already cost them. "People on a phone may find it harder to contact you" passes. "Customers are leaving your website" fails — it states an outcome nobody measured, to the one person who can check it.
- **"You" and "your" outnumber "I" and "we".** A letter that is mostly about us is a letter about us.
- One issue only. One ask, and it **offers** something — a screenshot, the exact setting, a short checklist — rather than requesting a meeting or a call.
- **No price anywhere.** A number belongs in a proposal.
- No technical vocabulary in the explanation: SPF, DMARC, DNS, robots.txt, metadata, structured data, viewport, TLS and the rest are all out.
- No private individual is named.
- Any proof is one of the three true ones — admin cut by 70%+, four-hour response on priority-one security, no data-loss incidents — and only where it fits the issue just described. No client names, no invented figures.
- 70–120 words. It does not end with a typed name: the app appends the signature.
- The subject is two to four lowercase words that look like ordinary internal mail, not a pitch and not a question the body repeats.

If the whole email rests on minor housekeeping — missing preview tags, no analytics, a small style point — servesPurpose is false whatever else is right about it, and the concern to raise is that there is no real reason for this business to reply.

Judge servesPurpose hard against that list, and name which item failed. The three that fail most often: an opening paragraph about Dakyworld rather than about them, a consequence stated as a prediction rather than as something made harder, and an ask for a call.`,
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
- Machine tells: "I hope this email finds you well", "I wanted to reach out", "it's not just X, it's Y", a dash in every sentence, a closing paragraph that restates the opening, and any sentence with three ideas in it.
- **An opening that clears its throat — but the clause naming the sender is not that.** On a cold email the letter opens on what was observed about *them*, and one short clause naming Dan and Dakyworld follows immediately. Both halves stay. What goes is a *second* sentence about what Dakyworld does, a company introduction, or anything that pushes the observation down the page. **Cutting the identification entirely is the single most damaging edit you can make here** — it is checked before sending and an email without it cannot go out — and an earlier version of these instructions caused exactly that. Moving it ahead of the observation is the opposite mistake and is also wrong.
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
  // The standard this email is held to, resolved the same way the drafter's
  // own instruction is. When nobody has edited the owning agent this is the
  // shipped checklist above; once somebody has, it is their wording — and the
  // two stages are reading one doctrine, which is the only arrangement in
  // which editing a prompt changes what comes out.
  const brief = await resolveBrief(emailJobFor(request.purpose), TEST[request.purpose] ?? "");
  const test = brief.text.trim();
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
        test ? `The standard it is held to — this is what the writer was told, so judge the draft against it and name the item that failed:\n${test}` : "",
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
    // The same reasoning as the drafter, plus one of its own: this pass has to
    // tell a fact it was given from a fact it invented, across a list it is
    // reading for the first time. That is the judgement that keeps a false
    // claim about somebody's business out of their inbox, and it is not the
    // place to save a fraction of a penny.
    effort: "high",
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
