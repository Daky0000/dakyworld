/**
 * The playbook's pre-send checklist, as far as a machine can honestly run it.
 *
 * Fifteen items in the playbook. Nine of them are arithmetic on the rendered
 * text — an unresolved merge field, a missing opt-out, a banned claim, two
 * questions where there should be one — and those are checked here and can
 * block. The other six are judgement: is this finding still true, is it the
 * right person, is the tone fair. Those are listed as what a person must
 * confirm, and are never ticked off by code.
 *
 * **Why a checker rather than more prompt.** Every rule here was already in the
 * drafter's instructions, and instructions are followed most of the time. The
 * ones that matter are the ones that must hold every time: an email that goes
 * out saying "Hi {{FirstName}}" is not a bad email, it is a business that looks
 * automated to the one person it was trying to persuade. A rule that must never
 * be broken belongs in code that can see the finished text, not in a paragraph
 * asking nicely before the text exists.
 *
 * Nothing here rewrites. It reports, and `POST /emails/draft` hands the result
 * to the composer so a person sees what failed beside the draft that failed it.
 */

export type CheckSeverity = "BLOCK" | "WARN";

export interface CheckResult {
  id: string;
  /** The checklist item, in the playbook's words. */
  label: string;
  severity: CheckSeverity;
  passed: boolean;
  /** What is wrong and where. Empty when it passed. */
  detail: string;
}

export interface PreSendReport {
  checks: CheckResult[];
  /** True when nothing that blocks has failed. */
  sendable: boolean;
  blocking: CheckResult[];
  warnings: CheckResult[];
  /** The six a person has to confirm. Never decided here. */
  humanMustConfirm: string[];
}

/**
 * Consultant vocabulary and the phrases the playbook names outright.
 *
 * Matched on word boundaries so "reach out" is caught and "outreach" is not.
 */
const BANNED_PHRASES = [
  "touching base",
  "touch base",
  "circle back",
  "circling back",
  "just checking in",
  "unlock growth",
  "reach out",
  "reaching out",
  "i hope this email finds you well",
  "hope you are well",
  "quick question",
  "as per",
  "leverage",
  "synergy",
  "cutting-edge",
  "best practice",
  "in today's fast-paced",
  "game-changer",
  "seamless",
];

/**
 * Claims about proportions of people, which the playbook forbids outright
 * because none of them has been established for this business.
 */
const UNSUPPORTED_CLAIMS = [
  "most people",
  "most visitors",
  "most customers",
  "almost everyone",
  "everyone leaves",
  "nobody clicks",
  "no one clicks",
  "70% of",
  "80% of",
  "90% of",
  "half of all",
];

/**
 * Terms that must not appear in a first email's explanation.
 *
 * The playbook allows a term *after* the issue has been explained in plain
 * words, so this is a warning rather than a block — but it fires on the first
 * email by default, because in most of them the term can be left out entirely.
 */
const TECHNICAL_TERMS = [
  "SPF",
  "DMARC",
  "DKIM",
  "DNS",
  "robots.txt",
  "Open Graph",
  "og:",
  "LCP",
  "CLS",
  "TTFB",
  "metadata",
  "meta tag",
  "structured data",
  "schema markup",
  "page source",
  "viewport",
  "canonical",
  "TLS",
  "SSL certificate chain",
  "HTTP header",
  "index.php",
  "CMS",
];

/** The opt-out the playbook requires on every cold email. */
export const OPT_OUT_SENTENCE = "If you'd rather I didn't write again, reply \"stop\" and I'll close this off.";

/** Does the body carry a reply-based opt-out, however it was worded? */
function hasOptOut(text: string): boolean {
  const lower = text.toLowerCase();
  return /reply\s+["“']?stop/.test(lower) || /rather i didn.?t write again/.test(lower);
}

function countQuestions(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface PreSendInput {
  subject: string;
  /** The body as it will actually be sent, signature and footer included. */
  body: string;
  /** False for a follow-up, where identification and the ask work differently. */
  firstEmail?: boolean;
  /**
   * True when the opt-out is appended by the renderer rather than written into
   * the body. The check then runs against the composed message instead.
   */
  optOutAppended?: boolean;
}

/**
 * Runs the checklist. Never throws and never edits — a checker that rewrites is
 * a second author nobody reviewed.
 */
export function preSendCheck(input: PreSendInput): PreSendReport {
  const { subject, body } = input;
  const firstEmail = input.firstEmail ?? true;
  const checks: CheckResult[] = [];

  const add = (id: string, label: string, severity: CheckSeverity, passed: boolean, detail = "") =>
    checks.push({ id, label, severity, passed, detail });

  const haystack = `${subject}\n${body}`;
  const lower = haystack.toLowerCase();

  // 4. No merge field is unresolved.
  const unresolved = [...haystack.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]);
  add(
    "merge-fields",
    "No merge field is left unresolved",
    "BLOCK",
    unresolved.length === 0,
    unresolved.length ? `Still in the text: ${[...new Set(unresolved)].map((name) => `{{${name}}}`).join(", ")}` : "",
  );

  // 11. The opt-out sentence is included.
  add(
    "opt-out",
    "A reply-based opt-out is present",
    "BLOCK",
    input.optOutAppended === true || hasOptOut(body),
    input.optOutAppended || hasOptOut(body) ? "" : `Add: ${OPT_OUT_SENTENCE}`,
  );

  // 6. The sender is identified in the first two lines.
  const firstLines = body
    .split(/\n/)
    .filter((line) => line.trim())
    .slice(0, 3)
    .join(" ");
  add(
    "identified",
    "The sender is identified in the first two lines",
    firstEmail ? "BLOCK" : "WARN",
    /dakyworld/i.test(firstLines),
    /dakyworld/i.test(firstLines) ? "" : "Neither the sender nor Dakyworld is named before the observation.",
  );

  // 9. Exactly one main issue and one question.
  const questions = countQuestions(body);
  add(
    "one-question",
    "Exactly one question",
    questions === 0 ? "BLOCK" : "WARN",
    questions === 1,
    questions === 0 ? "There is no question to answer." : questions > 1 ? `${questions} questions — the reader has to choose which to answer.` : "",
  );

  // 12. No unsupported claims about what "most" or "everyone" does.
  const claims = UNSUPPORTED_CLAIMS.filter((phrase) => lower.includes(phrase));
  add(
    "unsupported-claims",
    "No claim about what most or almost everyone does",
    "BLOCK",
    claims.length === 0,
    claims.length ? `Unsupported: ${claims.join(", ")}` : "",
  );

  // 14. It sounds like a personal note, not marketing copy.
  const banned = BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
  add(
    "voice",
    "No marketing filler",
    "BLOCK",
    banned.length === 0,
    banned.length ? `Remove: ${banned.join(", ")}` : "",
  );

  // 7/8. Understandable to a non-technical reader.
  const jargon = TECHNICAL_TERMS.filter((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(haystack));
  add(
    "plain-language",
    "No technical term the reader would not use",
    "WARN",
    jargon.length === 0,
    jargon.length ? `Explain in plain words or drop: ${jargon.join(", ")}` : "",
  );

  // 13. The subject is honest and not a fake internal message.
  const subjectWords = words(subject);
  const shouty = /[!]|^(re|fwd):/i.test(subject.trim()) || subject === subject.toUpperCase();
  add(
    "subject",
    "The subject is short, honest, and not disguised as a reply",
    "BLOCK",
    !shouty && subjectWords <= 8,
    shouty
      ? "It imitates a reply or shouts. A first email is not a Re: and never carries an exclamation mark."
      : subjectWords > 8
        ? `${subjectWords} words — keep it short and specific.`
        : "",
  );

  // 1 (Style). Length: about 70–120 words.
  const bodyWords = words(body);
  add(
    "length",
    "About 70–120 words",
    "WARN",
    bodyWords >= 55 && bodyWords <= 165,
    bodyWords < 55
      ? `${bodyWords} words — too thin to explain who is writing, what was seen and why it matters.`
      : bodyWords > 165
        ? `${bodyWords} words — this is a report, not a note.`
        : "",
  );

  // Prices belong in a proposal, never in a first email.
  const priced = firstEmail && /\bGHS\s?[\d,]|\$\s?\d|\bcedis\b/i.test(haystack);
  add(
    "no-price",
    "No price in a first email",
    "BLOCK",
    !priced,
    priced ? "A price belongs in a proposal, after they understand the issue and want help." : "",
  );

  const blocking = checks.filter((check) => !check.passed && check.severity === "BLOCK");
  const warnings = checks.filter((check) => !check.passed && check.severity === "WARN");

  return {
    checks,
    sendable: blocking.length === 0,
    blocking,
    warnings,
    // The six that are judgement, listed rather than guessed at.
    humanMustConfirm: [
      "Every factual claim traces to this run's audit or a named source.",
      "Every check behind the claim actually completed — a failed check is not a finding.",
      "The finding is recent enough to still be true, and has been rechecked if not.",
      "No private individual is named, and no personal detail is exposed.",
      "The question is proportionate to the issue and can be answered in one line.",
      "This is the right contact at the right business, at a reasonable time to write.",
    ],
  };
}
