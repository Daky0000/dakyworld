import { callModel } from "./models/call.js";
import { MODEL_DEFAULT } from "./claudePricing.js";
import { BRAND, VOICE, SERVICE_LINES, catalogueForPrompt } from "../services/dakyworld.js";
import { companyProfile, contactBlock } from "../services/systemProfile.js";
import { auditForPrompt } from "../services/companyAudit.js";
import { writerSystem } from "../services/writers/brief.js";
import type { ProposalContext } from "../services/proposalContext.js";

/**
 * The proposal writer.
 *
 * A generic proposal is not a weaker version of a good one — it is a different
 * document with a different effect. "A modern website builds credibility" tells
 * the reader you sent the same file to forty businesses, and it is answered by
 * deleting it. The only thing that changes that is evidence they can check:
 * their site, their domain, their listing, observed a minute ago and quoted
 * back with the address it came from.
 *
 * So the model's job here is deliberately narrow. It does not decide what is
 * wrong with the company — services/companyAudit.ts already did that, by
 * looking. It turns findings into an argument: what this costs them, in their
 * business, and what fixing it involves. Every recommendation must point at a
 * finding, and the schema enforces it — a recommendation with no evidence
 * behind it has nowhere to put itself.
 *
 * Two further constraints:
 *
 *  - **It may not invent a price.** Only the catalogue's published anchors are
 *    quotable. Anything else is "quoted after the call", flagged for the Owner.
 *  - **It writes a draft.** Nothing generated here is sent, and the Owner
 *    edits the number and the scope before it becomes a PDF.
 */

export const PROPOSAL_MODEL = MODEL_DEFAULT;

const SERVICE_IDS = SERVICE_LINES.map((service) => service.id);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "serviceType",
    "headline",
    "situation",
    "findings",
    "scope",
    "investment",
    "timeline",
    "whyUs",
    "assumptions",
    "nextStep",
    "confidence",
    "thinFacts",
  ],
  properties: {
    title: {
      type: "string",
      description:
        "The proposal's title, naming the company and the work. e.g. 'Website and business email for Adjei Dental Centre'. No colons-as-branding, no 'Proposal for'.",
    },
    serviceType: {
      type: "string",
      description: "The single headline service this proposal is for, in plain words — 'Website build', 'Website and email', 'Automation'.",
    },
    headline: {
      type: "string",
      description:
        "One sentence the reader sees first. It must state the most specific observed problem and its consequence for them. Never a greeting, never a summary of Dakyworld.",
    },
    situation: {
      type: "string",
      description:
        "Two short paragraphs about THEM — what they appear to do, what is working, and what is currently costing them. Written so that a stranger could not have written it. Acknowledge at least one thing they are doing well if the findings support it. No mention of Dakyworld here at all.",
    },
    findings: {
      type: "array",
      description:
        "The argument. One entry per observed problem worth fixing, strongest first, three to six of them. Never invent one; each must trace to a supplied finding.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["observed", "evidence", "costsThem", "fix", "service"],
        properties: {
          observed: { type: "string", description: "What is true right now, stated plainly and without hedging." },
          evidence: {
            type: "string",
            description: "Copied from the supplied finding's evidence — the URL, header or DNS record. The reader must be able to check it.",
          },
          costsThem: {
            type: "string",
            description:
              "What this costs THIS business, given what they do. Concrete and grounded — a dental clinic losing after-hours bookings, not 'reduced customer confidence'. Do not invent a cedi figure.",
          },
          fix: { type: "string", description: "What Dakyworld would actually do about it. One or two sentences, concrete work, no adjectives." },
          service: { type: "string", enum: [...SERVICE_IDS], description: "Which service line this belongs to." },
        },
      },
    },
    scope: {
      type: "array",
      description: "What is actually being delivered, as phases. Two to four. Each must be traceable to the findings above.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "deliverables", "outcome"],
        properties: {
          phase: { type: "string", description: "Short name — 'Build', 'Migration', 'Handover and training'." },
          deliverables: { type: "array", items: { type: "string" }, description: "Specific things they receive. Nouns, not activities." },
          outcome: { type: "string", description: "What is true for them at the end of this phase that was not true before." },
        },
      },
    },
    investment: {
      type: "object",
      additionalProperties: false,
      required: ["lineItems", "total", "totalIsFirm", "recurring", "basis"],
      properties: {
        lineItems: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "amount", "firm", "billing"],
            properties: {
              description: { type: "string" },
              amount: { type: "number", description: "GHS. Use 0 when this line cannot be priced without the discovery call." },
              firm: { type: "boolean", description: "True only when the amount comes from a published catalogue price." },
              billing: { type: "string", enum: ["ONE_OFF", "MONTHLY"] },
            },
          },
        },
        total: { type: "number", description: "GHS, one-off items only. 0 when nothing could be priced from the catalogue." },
        totalIsFirm: { type: "boolean", description: "False if any part of the total was estimated rather than taken from the catalogue." },
        recurring: { type: "number", description: "GHS per month for any care plan proposed. 0 if none." },
        basis: {
          type: "string",
          description: "One sentence saying exactly where these numbers came from, and what is still to be confirmed. The Owner reads this before sending.",
        },
      },
    },
    timeline: {
      type: "string",
      description: "How long the work takes, in weeks, phrased as a range. Do not promise dates. One or two sentences.",
    },
    whyUs: {
      type: "string",
      description:
        "Three sentences at most on why Dakyworld rather than a freelancer or an agency, using only the true claims supplied. This is the shortest section in the document and must read that way.",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description:
        "What this proposal assumes and what would change it — including anything that was NOT checked. Being explicit here is what makes the rest credible.",
    },
    nextStep: {
      type: "string",
      description: "One small, specific ask. A thirty-minute call, a yes to phase one. Never two asks.",
    },
    confidence: {
      type: "number",
      description:
        "0 to 1 — how well the evidence supported a genuinely specific proposal. Low when the audit found little, which tells the Owner to have the call before sending this.",
    },
    thinFacts: {
      type: "array",
      items: { type: "string" },
      description:
        "What you wanted to know and did not — the questions the Owner should ask on the call. Empty only if the evidence was genuinely rich.",
    },
  },
} as const;

/**
 * The doctrine Dakyworld ships for a proposal.
 *
 * A default, not the authority: `proposal.writer`'s own wording replaces this
 * once somebody edits that agent on the Agents screen — see
 * `services/writers/brief.ts`. Before that existed this constant was the only
 * thing that ever reached the model, and the Proposal Writer's card was a
 * label over a string nobody could edit.
 *
 * The service catalogue, the brand block and the contact details are passed
 * separately as facts, because they are live state rather than writing: a
 * rewritten voice must not be able to take the published prices with it.
 */
const SHIPPED_DOCTRINE = `You write service proposals for one specific company at a time, for Dakyworld.

${VOICE}

How this proposal must work:

1. **Every claim about the reader is evidence-backed.** You are given the output of a live check of their website and their domain. Each finding you write must trace to one of those observations and must carry its evidence, so the reader can verify it themselves. A prospect who checks one claim and finds it true believes the rest; one who finds an invented claim stops reading.

2. **You know nothing that was not observed.** You do not know their revenue, their staff count, their current supplier, their budget, what software they run, or what they have tried before. Do not imply otherwise — not even softly, not even as a guess framed as a question. If the check found little, write a shorter proposal and say what needs the call.

3. **Consequence, not adjective — and not an invented number.** "Not mobile-friendly" is an observation; "anyone who looks you up on a phone gets a page they have to pinch to read" is the argument. Ground every consequence in what this particular business does: a school, a clinic and a manufacturer lose different things.

   **Never state a proportion you were not given.** "Eight in ten of your customers", "most visitors", "90% of searches" — you have no such figure for this business, nobody measured it, and it is the first thing a sceptical reader checks. Say what happens to *a* person doing *a* thing, and let the reader supply the scale. A single concrete person is more persuasive than a statistic you cannot source, and it cannot be disproved.

4. **Never invent a price.** Only the catalogue's published prices may be quoted as firm. Everything else is priced after the discovery call, marked firm: false and amount: 0, and explained in the basis line. Quoting a made-up number that the Owner then has to walk back is worse than quoting nothing.

5. **No filler sections.** No "In today's digital landscape". No mission statement. No bulleted list of everything Dakyworld does. The reader's time is the budget: if a sentence does not either state a fact about them or say what will be done, cut it.

6. **Do not oversell.** Recommend what the evidence supports. If they need a website and nothing else, propose a website. A proposal that recommends all seven service lines is a brochure, and reads as one.`;

/**
 * The mechanics, which no prompt edit can reach.
 *
 * The pricing rule is here as well as in the doctrine on purpose. How firmly
 * to quote is a judgement somebody may want to change; *which fields carry an
 * un-firm price* is the shape of the answer, and a rewritten voice that lost
 * it would produce a proposal whose totals the document renderer then prints
 * as though they were quoted.
 */
const CONTRACT = `British spelling. Currency as GHS 35,000. No exclamation marks, no emoji.

Only the catalogue's published prices may be quoted as firm. Anything priced after the discovery call is returned with \`firm: false\` and \`amount: 0\`, with the reason in the basis line — never as a guessed number in the amount field.`;

export interface ProposalDraft {
  title: string;
  serviceType: string;
  headline: string;
  situation: string;
  findings: { observed: string; evidence: string; costsThem: string; fix: string; service: string }[];
  scope: { phase: string; deliverables: string[]; outcome: string }[];
  investment: {
    lineItems: { description: string; amount: number; firm: boolean; billing: "ONE_OFF" | "MONTHLY" }[];
    total: number;
    totalIsFirm: boolean;
    recurring: number;
    basis: string;
  };
  timeline: string;
  whyUs: string;
  assumptions: string[];
  nextStep: string;
  confidence: number;
  thinFacts: string[];
}

export interface WriteResult {
  draft: ProposalDraft;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function buildPrompt(context: ProposalContext, brief: string | null | undefined): string {
  const parts = [
    `Write a proposal for ${context.companyName}.`,
    "",
    "What we hold on them — the relationship, from our own records:",
    context.facts.map((fact) => `- ${fact}`).join("\n"),
    "",
    auditForPrompt(context.audit),
  ];

  if (context.cold) {
    parts.push(
      "",
      "This is a cold approach: nobody has spoken to them. The proposal must earn a conversation, not close a sale — so the ask at the end is a call, and the scope is what the evidence supports rather than everything they might eventually need.",
    );
  }
  if (brief?.trim()) {
    parts.push("", `What the Owner wants this proposal to do, in his words — this overrides your own judgement on angle and scope:\n${brief.trim()}`);
  }

  parts.push("", "Write the proposal.");
  return parts.join("\n");
}

export async function writeProposal(context: ProposalContext, brief?: string | null): Promise<WriteResult> {
  const { data, model, inputTokens, outputTokens } = await callModel<ProposalDraft>({
    purpose: "proposal.write",
    // Prose, so it goes wherever writing is routed — Gemini by default,
    // falling back to Claude while no Gemini key is set. See lib/models.
    job: "text",
    system: await writerSystem("proposal", SHIPPED_DOCTRINE, {
      facts: [BRAND, catalogueForPrompt(), contactBlock(await companyProfile())],
      contract: CONTRACT,
    }),
    prompt: () => buildPrompt(context, brief),
    schema: SCHEMA as unknown as Record<string, unknown>,
    // A proposal is written once and decides a deal; this is not the place to
    // save a few seconds of thinking.
    effort: "high",
    maxTokens: 12000,
    messages: {
      noKey: "No model is connected for writing. Add a key under Settings → AI models, or write this one by hand.",
      auth: "The model provider rejected the API key. Check it under Settings → AI models.",
      rate: "The model provider is rate-limiting this key. Try again in a minute.",
      refusal: "The writer declined this one. Rephrase the brief, or write the proposal by hand.",
      empty: "The writer returned nothing. Try again.",
      truncated: "The writer ran out of room before finishing the proposal. Try again, or narrow the brief.",
      parse: "The draft could not be read. Try again.",
    },
  });

  return { draft: data, model, inputTokens, outputTokens };
}
