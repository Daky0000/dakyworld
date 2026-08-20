import { DISCIPLINE_NAMES, reportScored, type AuditFindingDetail, type DisciplineReport, type WebsiteAuditReport } from "./types.js";

/**
 * The report as Markdown.
 *
 * Two readers, and they want opposite things, which is why this exists
 * alongside the PDF rather than instead of it. The PDF is for a person: it is
 * laid out, it carries the pictures with the problems drawn on them, and it
 * could be put in front of the business itself. The Markdown is for the cold
 * lead writer: no layout, no pictures, every finding in the same shape, and a
 * closing section that says in plain terms what the letter should open on and
 * what it must not claim.
 *
 * **The document is assembled here, in code, and only the prose inside it comes
 * from a model.** That is deliberate. A model asked to "write the report as
 * Markdown" produces a different document every time — sections renamed,
 * findings merged, evidence quietly dropped because it was repetitive. The
 * shape has to be identical across every audit, because the next thing that
 * reads it is another model, and a drafter that has learned where the evidence
 * lives should not have to re-learn it per company.
 *
 * The internal brief is fenced off under its own heading and marked. It is the
 * one part of this file that must never be pasted to the business, and the
 * heading says so in the document rather than only in this comment.
 */

export interface MarkdownOptions {
  /**
   * Where the pictures can be fetched from, when they have been stored.
   * Without it the Markdown says a picture exists rather than linking to one
   * that will 404.
   */
  screenshotBaseUrl?: string | null;
  /** Leave the email brief out — for a copy that might be shown to the business. */
  omitInternalBrief?: boolean;
}

const SEVERITY_LABEL: Record<AuditFindingDetail["severity"], string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  GOOD: "Good",
};

export function auditMarkdown(report: WebsiteAuditReport, options: MarkdownOptions = {}): string {
  const lines: string[] = [];
  const say = (...entries: (string | null | undefined)[]) => {
    for (const entry of entries) if (entry != null) lines.push(entry);
  };

  const ran = new Date(report.ranAt);

  say(
    `# Website review — ${report.businessName}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Site reviewed | ${report.website ?? "no website answered"} |`,
    `| Reviewed | ${ran.toISOString().slice(0, 10)} |`,
    `| Score | ${reportScored(report) ? `**${report.overallScore}/100** — ${report.verdict}` : "not scored — too little of the site could be examined to put one number on it"} |`,
    `| Reviewed by | ${report.disciplines.map((discipline) => discipline.reviewer).join(", ")} |`,
    "",
    "The score is arithmetic on the findings below, not a judgement: each fault costs a fixed number of points by severity, weighted across the sections that ran. A section that could not run is left out rather than counted either way. It moves when a fault is fixed and at no other time.",
    "",
  );

  // --- The front page -------------------------------------------------------
  if (report.synthesis) {
    const synthesis = report.synthesis;
    say("## In short", "", synthesis.executiveSummary, "", "### The one thing to do first", "", synthesis.theOneThing, "");

    say(
      "### Why it is worth spending money on",
      "",
      `**The problem.** ${synthesis.worthFixing.problem}`,
      "",
      `**What it costs them.** ${synthesis.worthFixing.costsThem}`,
      "",
      `**Why it is worth paying to fix.** ${synthesis.worthFixing.whyWorthPaying}`,
      "",
    );

    if (synthesis.whatIsWorking.length) {
      say("### What is already working", "", ...synthesis.whatIsWorking.map((entry) => `- ${entry}`), "");
    }

    if (synthesis.priority.length) {
      const byId = new Map(report.disciplines.flatMap((discipline) => discipline.findings).map((finding) => [finding.id, finding]));
      say("### Fix them in this order", "", "| # | What | Section | Why here |", "|---|---|---|---|");
      synthesis.priority.forEach((entry, index) => {
        const finding = byId.get(entry.findingId);
        if (!finding) return;
        say(`| ${index + 1} | ${escapeCell(finding.title)} | ${DISCIPLINE_NAMES[finding.discipline]} | ${escapeCell(entry.why)} |`);
      });
      say("");
    }
  } else {
    say(
      "## In short",
      "",
      "The four sections were not compiled into one summary — see the notes at the end for why. Everything the reviewers found is below, unchanged.",
      "",
    );
  }

  // --- The pictures ---------------------------------------------------------
  if (report.screenshots.length) {
    say("## What their homepage looks like", "");
    for (const shot of report.screenshots) {
      const label = shot.view === "mobile" ? "On a phone (390px wide)" : "On a desktop browser (1280px wide)";
      const annotated = Boolean(shot.annotatedBase64);
      say(`### ${label}`, "");
      if (options.screenshotBaseUrl) {
        const name = `${shot.view}${annotated ? "-marked" : ""}.png`;
        say(`![${label} — ${report.businessName}](${options.screenshotBaseUrl.replace(/\/$/, "")}/${name})`, "");
      } else {
        say(`_Picture taken ${new Date(shot.takenAt).toISOString().slice(0, 16).replace("T", " ")}. It is in the PDF._`, "");
      }
      if (annotated) {
        say("The numbered boxes mark roughly where each UI/UX point below applies. They are approximate — the area, not the pixel.", "");
      }
      if (shot.cropped) say("_The page is longer than this; the picture is the top of it, which is what a visitor sees first._", "");
    }
  }

  // --- The four sections ----------------------------------------------------
  for (const discipline of report.disciplines) {
    say(
      `## ${DISCIPLINE_NAMES[discipline.discipline]} — ${discipline.scored ? `${discipline.score}/100` : "not scored"}`,
      "",
      `*Reviewed by the ${discipline.reviewer}. ${discipline.reviewedBy}.*`,
      "",
      discipline.scored ? null : "> This section did not run, so it has no score and is left out of the overall. What follows is only what could be counted.",
      discipline.scored ? null : "",
      `**${discipline.headline}**`,
      "",
      discipline.summary,
      "",
    );

    const problems = discipline.findings.filter((finding) => finding.severity !== "GOOD");
    const good = discipline.findings.filter((finding) => finding.severity === "GOOD");

    if (problems.length) {
      for (const finding of problems) say(...findingLines(finding));
    } else if (discipline.checked.length) {
      say("Nothing was found wrong in this section.", "");
    }

    if (good.length) {
      say("### What is right here", "");
      for (const finding of good) say(`- **${finding.title}.** ${finding.observed}`);
      say("");
    }

    if (discipline.checked.length) {
      say("<details><summary>What was examined</summary>", "", ...discipline.checked.map((entry) => `- ${entry}`), "", "</details>", "");
    }
    if (discipline.notes.length) {
      say("**What could not be checked here:**", "", ...discipline.notes.map((note) => `- ${note}`), "");
    }
  }

  // --- What nobody looked at -----------------------------------------------
  if (report.notes.length) {
    say(
      "## What this review did not check",
      "",
      "None of the following is a fault, and none of it may be written to them as one. A check that did not run is not a finding.",
      "",
      ...report.notes.map((note) => `- ${note}`),
      "",
    );
  }

  // --- The internal half ----------------------------------------------------
  if (report.synthesis && !options.omitInternalBrief) {
    const brief = report.synthesis.emailBrief;
    say(
      "---",
      "",
      "## Internal — the brief for the email. Not for the client.",
      "",
      "Everything above could be shown to the business. This part could not: it is what to write to them and why.",
      "",
      `**Open on:** ${brief.openOn}`,
      "",
      `**What it costs them:** ${brief.consequence}`,
      "",
      `**The ask:** ${askLabel(brief.ask)} — ${brief.whyThatAsk}`,
      "",
    );
    if (brief.doNotSay.length) {
      say("**Do not claim any of this — the evidence does not support it:**", "", ...brief.doNotSay.map((entry) => `- ${entry}`), "");
    }
    say(
      "**The wording to reach for.** Every finding above carries a *plainly* line written with no technical vocabulary in it. Those are the sentences to use; the owner is not a developer and never will be.",
      "",
    );
  }

  say("---", "", `Prepared by the Dakyworld website audit team. Cost of this review: $${report.costUsd.toFixed(4)}.`, "");

  return lines.join("\n");
}

function findingLines(finding: AuditFindingDetail): string[] {
  return [
    `### ${SEVERITY_LABEL[finding.severity]} — ${finding.title}${finding.marker ? ` *(box ${finding.marker} on the picture)*` : ""}`,
    "",
    finding.observed,
    "",
    `- **What it costs them:** ${finding.impact}`,
    `- **Plainly:** ${finding.plainly}`,
    finding.recommendation ? `- **The fix:** ${finding.recommendation}` : null,
    `- **Evidence:** ${finding.evidence}`,
    "",
  ].filter((line): line is string => line !== null);
}

/**
 * What the first email should ask for, in the words the cold writer reads.
 *
 * This section of the Markdown is instructions to another writer, so it has to
 * agree with the playbook or it becomes a second, older voice arguing with it.
 * It used to say "ask for fifteen minutes", which Playbook v3 forbids in a
 * first email — the ask offers something rather than requesting time — and the
 * drafter was reading that sentence as a fact about the business it was writing
 * to. See `server/docs/cold-email-playbook.md`.
 */
function askLabel(ask: "DEMO" | "FIX" | "NOTHING"): string {
  if (ask === "DEMO") return "offer to build them a page they can look at";
  if (ask === "FIX") return "offer to find out what is causing it, or to send the exact change — never a call or a meeting in a first email";
  return "write nothing — there is no honest case here";
}

/** A pipe inside a Markdown table cell ends the cell. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}
