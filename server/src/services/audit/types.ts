/**
 * The shapes the website audit team works in.
 *
 * Four reviewers look at one site from four directions — how it looks, how
 * fast it is and whether it can be found, what it says, and whether it is
 * safe — and every one of them has to answer in the same shape, because the
 * whole point is that their answers are combined into one document a business
 * owner reads in order.
 *
 * Two rules are encoded here rather than left to each reviewer's prompt:
 *
 *  - **Every finding carries its own evidence.** `evidence` is the header, the
 *    URL, the tag or the part of the screenshot the claim came from. A finding
 *    with nothing in it is a finding somebody made up, and this report goes out
 *    under Dakyworld's name about a stranger's business.
 *  - **Every finding says it twice.** `observed` is what is true, in the
 *    reviewer's own terms; `plainly` is the same point with no technical word
 *    in it at all. The PDF prints the first, the email uses the second. The
 *    owner is not a developer and never will be.
 */

import type { AuditSeverity } from "../companyAudit.js";

export type { AuditSeverity };

/** The four seats at the table. This order is the order they appear in the report. */
export const DISCIPLINES = ["UX", "SPEED_SEO", "CONTENT", "SECURITY"] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export const DISCIPLINE_NAMES: Record<Discipline, string> = {
  UX: "UI/UX",
  SPEED_SEO: "Speed & SEO",
  CONTENT: "Content",
  SECURITY: "Security",
};

/**
 * Who does each one, by agent key in services/agentRegistry.ts.
 *
 * The team is made out of the roster rather than standing beside it. When the
 * report says the UI/UX section was written by the UI/UX Designer, that is the
 * same agent on the Agents screen, with the same brief — not a label invented
 * for a document.
 */
export const DISCIPLINE_AGENTS: Record<Discipline, { key: string; name: string; role: string }> = {
  // Not design.ux any more. Looking at a page and designing one are two jobs,
  // and this one is the looking: the reviewer that reads the screenshots.
  UX: { key: "review.look", name: "Page Reviewer", role: "What a first-time visitor sees, and what stops them" },
  SPEED_SEO: { key: "seo.specialist", name: "SEO Specialist", role: "Whether the page is fast enough to keep and findable enough to reach" },
  CONTENT: { key: "content.writer", name: "Content Writer", role: "Whether the words do the selling the design cannot" },
  SECURITY: { key: "sec.analyst", name: "Security Analyst", role: "Whether the site, the certificate and the mail domain are safe" },
};

/**
 * A rectangle on the screenshot, in fractions of the image.
 *
 * Fractions rather than pixels because the picture is cropped and shrunk on the
 * way to the model and is resized again for the PDF: a pixel box measured
 * against one copy is wrong on every other. Fractions survive all of it, and
 * `annotate.ts` multiplies them back out against whatever image it is drawing on.
 */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which screenshot this box belongs to. */
  view: ScreenshotView;
}

export type ScreenshotView = "desktop" | "mobile";

export interface AuditFindingDetail {
  id: string;
  discipline: Discipline;
  severity: AuditSeverity;
  /** A few words, as a heading. "No description under the page title". */
  title: string;
  /** What is true, stated so somebody can go and check it. */
  observed: string;
  /** Where it was observed: a URL, a header, a tag, "the hero, top of page". */
  evidence: string;
  /** What it costs them — customers, enquiries, ranking, credibility, money. */
  impact: string;
  /** The same point with no technical vocabulary. This is the wording an email uses. */
  plainly: string;
  /** What to do about it, in one sentence. Null on a GOOD finding. */
  recommendation: string | null;
  /** Set on findings the reviewer could point at. Drawn on the picture. */
  region: Region | null;
  /** The numbered badge on the annotated screenshot, when it has a region. */
  marker: number | null;
}

export interface DisciplineReport {
  discipline: Discipline;
  /** The agent that owns this section, by name. */
  reviewer: string;
  /** The model that actually answered, since a fallback may have. */
  reviewedBy: string;
  /** 0-100, computed from the findings in code — never asked of a model. */
  score: number;
  /**
   * Whether this reviewer actually did its job.
   *
   * The distinction that makes the whole document honest. A section whose
   * reviewer never ran has no findings, and no findings scores 100 — so the
   * first version of this reported "Content 100/100 — nobody read the writing
   * on the page", which is a number and a sentence contradicting each other on
   * the same line. A section that could not run is *unscored*: it prints as a
   * dash, it says why, and `overallScore` leaves it out of the average rather
   * than crediting it.
   */
  scored: boolean;
  /** One sentence: the state of this discipline on this site. */
  headline: string;
  /** Two or three sentences a business owner reads instead of the findings. */
  summary: string;
  findings: AuditFindingDetail[];
  /** What this reviewer actually examined, so "fine" reads differently from "not looked at". */
  checked: string[];
  /** What could not be checked, and why. Never a failure. */
  notes: string[];
  costUsd: number;
  /**
   * Set when this one section was run again on its own, after the review.
   *
   * A section that failed for a reason that has since been fixed — no Apify
   * token, no vision model, a certificate replaced — can be re-run by itself
   * rather than by paying for the whole team again. When that happens this
   * section is newer than the rest of the document, and every surface that
   * prints it says so: a reader comparing a UI/UX section written today with a
   * speed section from three weeks ago is entitled to know which is which.
   */
  rerunAt?: string | null;
}

/** What the whole team concluded, written by Claude from the four reports. */
export interface AuditSynthesis {
  /** Two or three sentences for the front page. No jargon at all. */
  executiveSummary: string;
  /** The single thing worth fixing first, and why that one. */
  theOneThing: string;
  /** The case for spending money, in the owner's terms. */
  worthFixing: { problem: string; costsThem: string; whyWorthPaying: string };
  /** In order. Each entry names a finding id from one of the four reports. */
  priority: { findingId: string; why: string }[];
  /** What is genuinely good. A report that only criticises reads as a sales pitch. */
  whatIsWorking: string[];
  /**
   * The brief for the cold email, written for the drafter rather than for the
   * owner. This is the reason the Markdown exists at all.
   */
  emailBrief: {
    /** The one observation to open on, in the owner's words. */
    openOn: string;
    /** What it costs them, concretely. */
    consequence: string;
    /** What to offer: a demo page, a fix, or nothing at all. */
    ask: "DEMO" | "FIX" | "NOTHING";
    /** Why that ask and not the others. */
    whyThatAsk: string;
    /** Anything the email must not claim, because the evidence does not support it. */
    doNotSay: string[];
  };
}

export interface AuditScreenshot {
  view: ScreenshotView;
  /** The picture as captured, base64 PNG. What the reviewer was shown. */
  base64: string;
  width: number;
  height: number;
  /** The same picture with the findings boxed and numbered. */
  annotatedBase64: string | null;
  /** The signed Apify link to the full-size original, which expires. */
  imageUrl: string | null;
  takenAt: string;
  cropped: boolean;
}

export interface WebsiteAuditReport {
  leadId: string | null;
  businessName: string;
  /** The address that actually answered, which may not be the one on file. */
  website: string | null;
  ranAt: string;
  /** 0-100 across all four, weighted. Computed in code. Meaningless unless `scored`. */
  overallScore: number;
  /**
   * Whether enough of the site was examined to put one number on it.
   *
   * The same rule as `DisciplineReport.scored`, one level up. A single section
   * out of four is 22% of a website, and averaging it alone produced "92/100 —
   * Strong" for a site whose certificate had expired and which nobody could
   * open. A number that describes a fifth of something is not a smaller
   * version of the truth, it is a different claim.
   */
  scored: boolean;
  /** "Serious problems" through "Strong" — derived from the score, or "Not scored". */
  verdict: string;
  disciplines: DisciplineReport[];
  synthesis: AuditSynthesis | null;
  screenshots: AuditScreenshot[];
  /** Everything the team could not check, gathered into one list. */
  notes: string[];
  /**
   * Which of `notes` came from the two paid steps — the pictures and the rented
   * browser. Kept on the report so a re-run of one section can carry forward
   * the notes for the step it deliberately skipped and drop the ones it has
   * just disproved. Absent on rows written before section re-runs existed.
   */
  stepNotes?: { screenshots: string[]; rendered: string[] };
  costUsd: number;
}

// --- Scoring ----------------------------------------------------------------

/**
 * What each severity costs a score.
 *
 * In code, and the same for every discipline, because a score a model chooses
 * is a score that moves when the model changes. This one is arithmetic on the
 * findings: two people reading the same findings get the same number, and a
 * fixed fault provably raises it.
 */
const WEIGHT: Record<AuditSeverity, number> = { CRITICAL: 28, HIGH: 16, MEDIUM: 8, LOW: 3, GOOD: 0 };

/**
 * **A score out of 100 is a claim about the checks that did not fire.**
 *
 * This is subtraction from a hundred, so every point *not* deducted is an
 * assertion that something was looked at and found sound. That holds only when
 * the battery actually ran. A reviewer that made one check out of ten and found
 * one medium fault returns 92 — and 92 of those points were never earned by
 * anything.
 *
 * That is not hypothetical: a site whose certificate had expired could not be
 * opened at all, so the only thing examined was its mail domain, the only
 * finding was a missing DMARC record, and the report went out reading
 * "92/100 — Strong · No DMARC policy". Whoever reads that sees a number
 * flatly contradicting the sentence beside it, in a document about their own
 * business.
 *
 * So the arithmetic here is unchanged and always available — but a caller may
 * only publish it once its own checks ran (`DisciplineReport.scored`). Deciding
 * that is the reviewer's job, because only the reviewer knows what it skipped.
 */
export function scoreFindings(findings: { severity: AuditSeverity }[]): number {
  const lost = findings.reduce((total, finding) => total + WEIGHT[finding.severity], 0);
  return Math.max(0, Math.min(100, 100 - lost));
}

/**
 * The weights across disciplines.
 *
 * Not equal, deliberately. A site nobody can find and a site nobody trusts are
 * both worse for a small business than one that reads a little awkwardly, and
 * the thing that costs them a customer first is what the page looks like when
 * it opens.
 */
const DISCIPLINE_WEIGHT: Record<Discipline, number> = { UX: 0.32, SPEED_SEO: 0.28, CONTENT: 0.18, SECURITY: 0.22 };

/**
 * How much of the table has to have sat down before the document puts one
 * number on the front page.
 *
 * Half, by weight. Leaving out one section that failed and averaging the other
 * three is a fair summary of a site; averaging *one* section is not a summary
 * of anything — it is that section's score with the whole site's name on it.
 */
export const MIN_SCORED_WEIGHT = 0.5;

export function overallScore(reports: DisciplineReport[]): { score: number; scored: boolean } {
  // A discipline that could not run is left out of the average rather than
  // scored either way. "Nobody looked" is not "it is broken" and it is not
  // "it is perfect"; averaging in a zero states the first and averaging in a
  // hundred states the second, and both are claims about a stranger's website
  // that nothing checked.
  const present = reports.filter((report) => report.scored);
  if (!present.length) return { score: 0, scored: false };
  const covered = present.reduce((sum, report) => sum + DISCIPLINE_WEIGHT[report.discipline], 0);
  const weighted = present.reduce((sum, report) => sum + report.score * DISCIPLINE_WEIGHT[report.discipline], 0);
  // Rescaling to the sections that ran is what makes leaving one out fair — and
  // it is also what makes one section alone come out as the whole site's score,
  // so the coverage gate below is not optional. The epsilon is there because
  // 0.32 + 0.18 is not exactly 0.5 in binary.
  return { score: Math.round(weighted / covered), scored: covered >= MIN_SCORED_WEIGHT - 1e-9 };
}

/**
 * Whether a stored report may show its number.
 *
 * Rows written before the coverage gate existed carry no `scored` field, and
 * the honest reading of one of those is the rule that was in force when it was
 * written — not the new one applied retrospectively to a document nobody can
 * re-derive.
 */
export function reportScored(report: Pick<WebsiteAuditReport, "disciplines"> & { scored?: boolean }): boolean {
  return report.scored ?? report.disciplines.some((discipline) => discipline.scored);
}

export function verdictFor(score: number): string {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Solid, with gaps";
  if (score >= 50) return "Needs work";
  if (score >= 30) return "Losing them customers";
  return "Serious problems";
}

const SEVERITY_ORDER: AuditSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "GOOD"];

export function sortBySeverity<T extends { severity: AuditSeverity }>(findings: T[]): T[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/**
 * Worst first, and not all of them.
 *
 * A mechanical reviewer can produce thirty true findings about one homepage,
 * and a document with thirty findings in it is one nobody reads to the end —
 * which means the serious ones at the top are lost along with the trivia at
 * the bottom. Everything serious survives; the small stuff is capped. What was
 * cut is counted in the section's own summary rather than silently dropped.
 */
export function trimFindings<T extends { severity: AuditSeverity }>(
  findings: T[],
  caps: { medium?: number; low?: number; good?: number } = {},
): { kept: T[]; dropped: number } {
  const limits = { medium: caps.medium ?? 6, low: caps.low ?? 4, good: caps.good ?? 3 };
  const kept: T[] = [];
  let medium = 0;
  let low = 0;
  let good = 0;
  let dropped = 0;

  for (const finding of sortBySeverity(findings)) {
    if (finding.severity === "CRITICAL" || finding.severity === "HIGH") kept.push(finding);
    else if (finding.severity === "MEDIUM" && medium++ < limits.medium) kept.push(finding);
    else if (finding.severity === "LOW" && low++ < limits.low) kept.push(finding);
    else if (finding.severity === "GOOD" && good++ < limits.good) kept.push(finding);
    else dropped += 1;
  }

  return { kept, dropped };
}

/** Every finding across the four sections, worst first. */
export function allFindings(report: WebsiteAuditReport): AuditFindingDetail[] {
  return sortBySeverity(report.disciplines.flatMap((discipline) => discipline.findings));
}
