import type { LeadThesis, LeadVerdictKind } from "@prisma/client";
import { callModel } from "../../lib/models/call.js";
import type { CompanyAudit } from "../companyAudit.js";
import { auditForPrompt } from "../companyAudit.js";
import type { HomepageLook } from "../homepageLook.js";
import { SIGNALS, parseQualifier, type SignalEvidence } from "./signals.js";

/**
 * Whether one business fits one thesis, and why.
 *
 * Two passes, in this order and never the other way round:
 *
 * 1. **What can be checked, is checked** — from the audit, the homepage look
 *    and the record itself. Free, repeatable, and the same answer every time.
 * 2. **What is left is prose**, so it goes to a model *with the evidence
 *    attached* and a hard instruction to cite what it saw. This is the half
 *    that costs money, which is why it runs second and only on the qualifiers
 *    that need it.
 *
 * **A disqualifier ends it.** Any one that fires rejects the business outright
 * whatever the score — that is the difference between a disqualifier and a
 * qualifier worth nothing, and it is why the two are separate columns.
 *
 * **Nothing checked means nothing decided.** A business whose site would not
 * load and whose audit therefore found nothing is `UNDECIDED`, not rejected.
 * Scoring it zero against a list it was never measured against would delete a
 * real prospect on the strength of a bad afternoon at their host — and because
 * the rejection writes a tombstone, it would delete them permanently.
 */

export interface JudgedSignal {
  /** The signal key, or `prose` for a qualifier a model had to read. */
  signal: string;
  /** The sentence from the thesis this came from. */
  says: string;
  /** True fired, false did not, null could not be told. */
  matched: boolean | null;
  /** What was actually seen. Empty when nothing was. */
  evidence: string;
  /** Which side of the thesis this line is on. */
  kind: "qualifier" | "disqualifier";
  /**
   * A defining test rather than a supporting one — written `!signal — …`.
   *
   * A qualifier that does not fire lowers the score. A **required** one that
   * does not fire ends it, because some tests are not there to be weighed: the
   * "no website" thesis has three supporting checks a well-run business passes
   * easily, and without this a company with a perfectly good site scored three
   * of four and qualified under a thesis about not having one.
   */
  required?: boolean;
}

export interface Judgement {
  verdict: LeadVerdictKind;
  /** 0–100, out of the qualifiers that could actually be checked. */
  score: number;
  signals: JudgedSignal[];
  /** One sentence a person can read without opening anything else. */
  reason: string;
  costUsd: number;
  /** Set when the prose pass could not run. Never a failure — a note. */
  note: string | null;
}

/** What the model is allowed to answer with. Closed, fully required, no exotic keywords. */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      description: "One entry per numbered line you were given, in the same order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line", "matched", "evidence"],
        properties: {
          line: { type: "integer", description: "The number of the line this answers." },
          matched: {
            type: "string",
            enum: ["YES", "NO", "CANNOT_TELL"],
            description:
              "YES only when the evidence below states it. CANNOT_TELL when nothing you were given settles it — that is the correct answer far more often than it feels like.",
          },
          evidence: {
            type: "string",
            description:
              "The exact thing you saw that decided it, quoted or closely paraphrased from what you were given. Empty string when the answer is CANNOT_TELL. Never a general statement about businesses of this kind.",
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You are checking one business against one written test, for Dakyworld, an outsourced technology partner in Ghana.

You are given: a target description, some numbered statements, and the evidence that was actually gathered about this business — a technical audit of their website and mail domain, and, where somebody looked, what their homepage shows a visitor.

Answer each numbered statement YES, NO, or CANNOT_TELL, and quote the thing that decided it.

The rules that matter:

1. **Only the evidence in front of you counts.** Not what businesses of this trade usually do, not what the name suggests, not what is likely. If the evidence does not settle it, the answer is CANNOT_TELL.
2. **CANNOT_TELL is a real answer and the right one often.** A wrong YES puts a stranger's business into a sales pipeline under a claim nobody checked. A wrong NO deletes a real prospect for good.
3. **Evidence must be specific.** "Their site is outdated" is not evidence; "the page declares WordPress 4.9, released 2017" is.
4. Absence of a finding is not proof of absence unless the evidence says that check ran.`;

/** The evidence, as the lines a model reads. Deliberately the same text a person would be shown. */
function evidenceBlock(evidence: SignalEvidence, facts: string[]): string {
  const parts: string[] = [];
  const lead = evidence.lead;
  parts.push(
    [
      `Business: ${lead.companyName ?? "unnamed"}`,
      lead.category ? `Trade: ${lead.category}` : null,
      lead.city ? `Town: ${lead.city}` : null,
      `Website on record: ${lead.website ?? "none"}`,
      `Email on record: ${lead.contactEmail ?? "none"}`,
      `Phone on record: ${lead.contactPhone ?? "none"}`,
      lead.reviewsCount != null ? `Public reviews: ${lead.reviewsCount}${lead.rating != null ? ` at ${lead.rating}` : ""}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  if (evidence.audit) parts.push(`--- What the audit checked ---\n${auditForPrompt(evidence.audit)}`);
  else parts.push("--- No audit was run on this business. ---");

  if (evidence.look) {
    parts.push(
      [
        "--- What their homepage shows a visitor ---",
        `First impression: ${evidence.look.firstImpression}`,
        `Says what they sell above the fold: ${evidence.look.offerClear ? "yes" : "no"}`,
        `Shows how to make contact: ${evidence.look.contactClear ? "yes" : "no"}`,
        evidence.look.looksDated ? `Dated: ${evidence.look.looksDated}` : null,
        `Looks like a business of this size: ${evidence.look.fitsTheBusiness ? "yes" : `no — ${evidence.look.fitNote}`}`,
        evidence.look.speed ? `On a phone: ${evidence.look.speed}` : null,
        evidence.look.states ? `The page states: ${JSON.stringify(evidence.look.states)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } else {
    parts.push("--- Nobody has looked at their homepage. ---");
  }

  if (facts.length > 0) parts.push(`--- Also found ---\n${facts.slice(0, 30).join("\n")}`);
  return parts.join("\n\n");
}

export interface JudgeInput {
  thesis: Pick<LeadThesis, "name" | "target" | "rationale" | "qualifiers" | "disqualifiers" | "minScore">;
  evidence: SignalEvidence;
  /** The plain lines `leadPrep` produced, so the model sees what a person would. */
  facts?: string[];
  /** Skip the model pass — for a check that must not spend anything. */
  offline?: boolean;
}

export async function judge(input: JudgeInput): Promise<Judgement> {
  const { thesis, evidence } = input;
  const lines: JudgedSignal[] = [];
  const prose: Array<{ index: number; entry: JudgedSignal }> = [];

  const read = (raw: string, kind: "qualifier" | "disqualifier") => {
    const { signal, prose: says, required } = parseQualifier(raw);
    if (signal) {
      const outcome = SIGNALS[signal.key].test(evidence);
      lines.push({ signal: signal.key, says, matched: outcome.fired, evidence: outcome.evidence, kind, required });
      return;
    }
    const entry: JudgedSignal = { signal: "prose", says, matched: null, evidence: "", kind, required };
    lines.push(entry);
    prose.push({ index: prose.length + 1, entry });
  };

  for (const raw of thesis.qualifiers) read(raw, "qualifier");
  for (const raw of thesis.disqualifiers) read(raw, "disqualifier");

  // --- The half a model has to read ----------------------------------------
  let costUsd = 0;
  let note: string | null = null;

  if (prose.length > 0 && !input.offline) {
    try {
      const numbered = prose.map((item) => `${item.index}. ${item.entry.says}`).join("\n");
      const result = await callModel<{ lines: Array<{ line: number; matched: string; evidence: string }> }>({
        purpose: "hunt.judge",
        job: "triage",
        system: SYSTEM,
        schema: SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 1600,
        prompt: () =>
          [
            `Target: ${thesis.target}`,
            `Why we are looking for them: ${thesis.rationale}`,
            "",
            "Statements to check:",
            numbered,
            "",
            "Evidence gathered about this business:",
            evidenceBlock(evidence, input.facts ?? []),
          ].join("\n"),
      });
      costUsd += result.costUsd ?? 0;
      for (const answer of result.data.lines ?? []) {
        const target = prose.find((item) => item.index === answer.line);
        if (!target) continue;
        target.entry.matched = answer.matched === "YES" ? true : answer.matched === "NO" ? false : null;
        target.entry.evidence = (answer.evidence ?? "").trim();
        // A YES with nothing behind it is the failure this whole design exists
        // to prevent, so it is demoted here rather than argued with in the
        // prompt. The model is told to cite; this is what happens when it does
        // not.
        if (target.entry.matched === true && !target.entry.evidence) {
          target.entry.matched = null;
          target.entry.evidence = "Claimed, with nothing cited — not counted.";
        }
      }
    } catch (err) {
      // Not a failure of the hunt. The machine-checkable signals still decide,
      // and the note says which lines nobody read — which is what stops a
      // half-checked lead being reported as a fully checked one.
      note = `${prose.length} written test(s) could not be read: ${(err as Error).message}`;
    }
  } else if (prose.length > 0) {
    note = `${prose.length} written test(s) were skipped — no model call was allowed on this run.`;
  }

  return settle(lines, thesis.minScore, costUsd, note);
}

/** The arithmetic, kept apart from the gathering so it can be tested on its own. */
export function settle(lines: JudgedSignal[], minScore: number, costUsd = 0, note: string | null = null): Judgement {
  const disqualified = lines.find((line) => line.kind === "disqualifier" && line.matched === true);
  if (disqualified) {
    return {
      verdict: "REJECTED",
      score: 0,
      signals: lines,
      reason: `Ruled out: ${disqualified.says}${disqualified.evidence ? ` — ${disqualified.evidence}` : ""}`,
      costUsd,
      note,
    };
  }

  const qualifiers = lines.filter((line) => line.kind === "qualifier");

  // The defining tests, before any weighing. One that came back false ends it;
  // one nobody could answer leaves the whole thing undecided, because a thesis
  // cannot be confirmed on its supporting evidence alone — and "undecided"
  // keeps the business rather than deleting it, which is the safe side of a
  // question nobody could answer.
  const required = qualifiers.filter((line) => line.required);
  const undefining = required.find((line) => line.matched === false);
  if (undefining) {
    return {
      verdict: "REJECTED",
      score: 0,
      signals: lines,
      reason: `Does not fit at all: ${undefining.says}${undefining.evidence ? ` — ${undefining.evidence}` : ""}`,
      costUsd,
      note,
    };
  }
  const unknown = required.find((line) => line.matched === null);
  if (unknown) {
    return {
      verdict: "UNDECIDED",
      score: 0,
      signals: lines,
      reason: `The one thing this hunt is about could not be checked: ${unknown.says} Kept, and worth another look.`,
      costUsd,
      note,
    };
  }

  // **Out of what was checkable, not out of the whole list.** A thesis with six
  // qualifiers of which four could not be told is scored out of two; scoring it
  // out of six would mean a business is punished for evidence nobody gathered.
  const decided = qualifiers.filter((line) => line.matched !== null);
  const fired = decided.filter((line) => line.matched === true);

  if (decided.length === 0) {
    return {
      verdict: "UNDECIDED",
      score: 0,
      signals: lines,
      reason:
        qualifiers.length === 0
          ? "This thesis has no qualifiers, so there was nothing to measure against."
          : "Nothing could be checked — the site did not answer and no audit was possible. Kept, and worth another look.",
      costUsd,
      note,
    };
  }

  const score = Math.round((fired.length / decided.length) * 100);
  const named = fired.map((line) => line.says);
  const missing = decided.filter((line) => line.matched === false).map((line) => line.says);
  const unchecked = qualifiers.length - decided.length;

  if (score >= minScore) {
    return {
      verdict: "QUALIFIED",
      score,
      signals: lines,
      reason:
        `Fits on ${fired.length} of ${decided.length} checks: ${named.join("; ")}.` +
        (unchecked > 0 ? ` ${unchecked} could not be checked.` : ""),
      costUsd,
      note,
    };
  }

  return {
    verdict: "REJECTED",
    score,
    signals: lines,
    reason:
      `Scored ${score}, under the ${minScore} this thesis asks for. ` +
      (missing.length > 0 ? `Does not fit: ${missing.slice(0, 3).join("; ")}.` : "Nothing matched.") +
      (unchecked > 0 ? ` ${unchecked} could not be checked.` : ""),
    costUsd,
    note,
  };
}
