import { callClaude } from "../../lib/claude.js";
import type { AuditEvidence } from "./evidence.js";
import { DISCIPLINE_NAMES, allFindings, type AuditSynthesis, type DisciplineReport, type WebsiteAuditReport } from "./types.js";

/**
 * Putting the four reviews together.
 *
 * Four specialists produce four true lists that do not add up to a decision.
 * The UI/UX reviewer will say the page does not explain the business; the SEO
 * reviewer will say the title tag is generic; the content reviewer will say
 * there is no reason to choose them; the security reviewer will say anybody
 * can send email in their name. All four are right, and a business owner
 * reading all four in sequence learns that everything is wrong, which is the
 * same as learning nothing.
 *
 * So one reader goes over the whole thing and answers the two questions the
 * owner actually has — what is this costing me, and what do I do first — plus
 * the one Dakyworld has, which is what to say in the letter.
 *
 * **This one is Claude, named rather than routed.** Every other model call in
 * this app asks for a job and lets the routing decide. This step is different
 * in kind: it is the only place where four documents are weighed against each
 * other and one is chosen to lead, and the whole report's credibility rests on
 * that judgement being consistent. Naming the model keeps it consistent across
 * every audit rather than moving with whatever the Owner last connected.
 *
 * It cannot introduce a fault. Every entry in `priority` must name a finding id
 * that already exists, and the ids are checked against the reports on the way
 * back — a synthesis that invents a problem is discarded rather than published.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["executiveSummary", "theOneThing", "worthFixing", "priority", "whatIsWorking", "emailBrief"],
  properties: {
    executiveSummary: {
      type: "string",
      description:
        "Three or four sentences for the front page of the report, addressed to the person who owns this business. What their website is doing for them at the moment, what it is not, and what that is costing. No technical vocabulary at all, and no list.",
    },
    theOneThing: {
      type: "string",
      description:
        "The single thing worth fixing first, and why that one rather than the others. Two sentences. It does not have to be the most severe finding — it has to be the one that changes the most for the least.",
    },
    worthFixing: {
      type: "object",
      additionalProperties: false,
      required: ["problem", "costsThem", "whyWorthPaying"],
      properties: {
        problem: { type: "string", description: "The problem in one sentence, with no technical vocabulary." },
        costsThem: { type: "string", description: "What it costs them — customers, enquiries, credibility, the comparison against a competitor." },
        whyWorthPaying: { type: "string", description: "Why it is worth spending money on rather than living with." },
      },
    },
    priority: {
      type: "array",
      maxItems: 8,
      description: "The order to fix things in. Every entry must name a finding id that appears in the reports you were given.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "why"],
        properties: {
          findingId: { type: "string", description: "Exactly as given, e.g. ux-2 or sec-no-spf." },
          why: { type: "string", description: "Why it sits here in the order. One short sentence." },
        },
      },
    },
    whatIsWorking: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
      description:
        "What is genuinely good about this site, in the owner's words. Take these from the GOOD findings and from what was checked and found sound. If there is nothing, return an empty array rather than inventing one.",
    },
    emailBrief: {
      type: "object",
      additionalProperties: false,
      required: ["openOn", "consequence", "ask", "whyThatAsk", "doNotSay"],
      properties: {
        openOn: {
          type: "string",
          description:
            "The one observation a cold email should open on, written the way somebody would say it across a desk. It must be something the owner can check on their own site in ten seconds.",
        },
        consequence: { type: "string", description: "What that costs them, concretely and in people rather than in metrics." },
        ask: {
          type: "string",
          enum: ["DEMO", "FIX", "NOTHING"],
          description:
            "DEMO when the design itself is the problem and a free rebuilt page is the argument. FIX when the fault is technical — a certificate, a dead page, no way to make contact — because offering a redesign for those reads as chasing a bigger job. NOTHING when the site is sound and there is no honest case to write about.",
        },
        whyThatAsk: { type: "string", description: "One sentence on why that ask and not the other two." },
        doNotSay: {
          type: "array",
          maxItems: 5,
          items: { type: "string" },
          description:
            "Anything a writer might reasonably conclude from this report that the evidence does not actually support — a check that could not run, a page nobody saw, a number that is a floor rather than a total.",
        },
      },
    },
  },
} as const;

const SYSTEM = `You are compiling one website review out of four specialists' reports, for a business that has not asked for it and has never heard of us.

Two people read what you write. The business owner reads the summary and the priority order: they are not technical, they will not become technical, and they decide whether to spend money on the strength of whether the first paragraph describes something they recognise. A colleague reads the email brief, to write to them.

**The rules, in order of how much damage breaking them does:**

1. **You may not introduce a fault.** Every problem you name has to be one of the findings you were given, and every entry in the priority list must use a finding id exactly as it appears. If you want to make a point the findings do not support, leave it out. This report goes to a stranger about their own business, and they know the truth better than the reports do.

2. **Never turn "we could not check it" into "it is wrong".** The notes list what could not be examined. A check that did not run is not a finding; saying otherwise is a false statement about somebody's company.

3. **Rank by what it costs them, not by severity.** A CRITICAL security header and a homepage that does not say what the business sells are not equally urgent to somebody who wants the phone to ring. What changes the most for the least effort goes first.

4. **Say what is good.** A review that only criticises reads as a sales pitch and is read as one. If something is genuinely sound, it goes in \`whatIsWorking\` — and if the whole site is sound, say so and set the ask to NOTHING. Being able to say there is nothing worth writing about is what makes the other reports believable.

Write British English, plainly, the way a competent person explains something to a customer. No exclamation marks. Do not use: leverage, optimise, robust, seamless, cutting-edge, best practice, in today's digital landscape, or any sentence that would fit any business.`;

export interface SynthesisResult {
  synthesis: AuditSynthesis | null;
  costUsd: number;
  notes: string[];
}

export async function synthesise(
  report: Pick<WebsiteAuditReport, "businessName" | "website" | "overallScore" | "verdict" | "disciplines" | "notes">,
  evidence: AuditEvidence,
  business: { trade: string | null; town: string | null },
): Promise<SynthesisResult> {
  const findings = allFindings(report as WebsiteAuditReport);
  const validIds = new Set(findings.map((finding) => finding.id));

  if (!findings.length) {
    return {
      synthesis: null,
      costUsd: 0,
      notes: ["Nothing was found to compile — no reviewer produced a finding, so there is no summary to write."],
    };
  }

  try {
    const result = await callClaude<AuditSynthesis>({
      purpose: "audit.synthesis",
      system: SYSTEM,
      prompt: () => buildPrompt(report, evidence, business, findings),
      schema: SCHEMA as unknown as Record<string, unknown>,
      effort: "high",
      maxTokens: 4000,
      messages: {
        noKey: "No Anthropic key is connected, so the four sections could not be compiled into one summary. The sections themselves are all here. Add a key under Settings → AI models.",
      },
    });

    // The one check that matters: a priority entry naming a finding nobody
    // reported is a fault this step invented, and it would appear in the
    // document as though a reviewer had found it.
    const priority = result.data.priority.filter((entry) => validIds.has(entry.findingId));
    const invented = result.data.priority.length - priority.length;

    return {
      synthesis: { ...result.data, priority },
      costUsd: result.costUsd,
      notes: invented
        ? [`${invented} entr${invented === 1 ? "y" : "ies"} in the suggested order named a finding that does not exist, and ${invented === 1 ? "was" : "were"} dropped.`]
        : [],
    };
  } catch (err) {
    // The four sections are the report. Losing the front page because no key
    // is connected must not lose them.
    return {
      synthesis: null,
      costUsd: 0,
      notes: [`The four sections could not be compiled into one summary: ${(err as Error).message} Everything the reviewers found is still below.`],
    };
  }
}

function buildPrompt(
  report: Pick<WebsiteAuditReport, "businessName" | "website" | "overallScore" | "verdict" | "disciplines" | "notes">,
  evidence: AuditEvidence,
  business: { trade: string | null; town: string | null },
  findings: ReturnType<typeof allFindings>,
): string {
  const parts: string[] = [
    `The business: ${report.businessName}`,
    business.trade ? `What they do: ${business.trade}` : null,
    business.town ? `Where: ${business.town}` : null,
    report.website ? `The site reviewed: ${report.website}` : "They have no website that answered.",
    `The score the checks produced: ${report.overallScore} out of 100 — "${report.verdict}". It is arithmetic on the findings, not a judgement, so do not defend it or explain how it was reached.`,
    "",
  ].filter(Boolean) as string[];

  for (const discipline of report.disciplines) {
    parts.push(
      `## ${DISCIPLINE_NAMES[discipline.discipline]} — reviewed by the ${discipline.reviewer} (${discipline.reviewedBy}), scored ${discipline.score}/100`,
      discipline.headline,
      discipline.summary,
      "",
      discipline.checked.length ? `What this reviewer examined: ${discipline.checked.join("; ")}.` : "This reviewer could not examine anything.",
      discipline.notes.length ? `What it could not check: ${discipline.notes.join(" ")}` : "",
      "",
    );
  }

  parts.push(
    "## Every finding, worst first. These ids are the only ones you may use.",
    ...findings.map(
      (finding) =>
        `- \`${finding.id}\` [${finding.severity}] ${DISCIPLINE_NAMES[finding.discipline]} — ${finding.title}\n    What was seen: ${finding.observed}\n    Evidence: ${finding.evidence}\n    What it costs: ${finding.impact}\n    Plainly: ${finding.plainly}${finding.recommendation ? `\n    Fix: ${finding.recommendation}` : ""}`,
    ),
    "",
  );

  if (report.notes.length || evidence.notes.length) {
    parts.push(
      "## What could not be checked at all. None of this is a fault and none of it may be written as one.",
      ...[...new Set([...report.notes, ...evidence.notes])].map((note) => `- ${note}`),
      "",
    );
  }

  parts.push("Compile the review.");
  return parts.join("\n");
}
