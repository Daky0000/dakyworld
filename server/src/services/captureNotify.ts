import type { ScraperRun, ScraperSource } from "@prisma/client";
import { SETTING, getSetting } from "../lib/settings.js";
import { readMailerConfig, sendMail } from "../lib/mailer.js";
import { signature, toHtml, toText } from "./emailRender.js";
import { readCaptureConfig } from "./captureConfig.js";
import { sendSlack, slackConfigured } from "../lib/slack.js";
import type { RunDiagnostics } from "./scraperRunner.js";

/**
 * Tells the Owner what a scrape did.
 *
 * Lead capture runs unattended at whatever hour the schedule says, so without
 * this the two outcomes that matter most are the two nobody sees: a run that
 * failed, and a run that succeeded but filed nothing because the search or the
 * score floor was wrong. Both look identical from the Leads page — an empty
 * morning — which is how a broken source survives for a fortnight.
 *
 * Off, failures-only, or every run: Settings → Lead capture. Failures-only by
 * default, because a daily "12 new leads" email stops being read by week two.
 *
 * Goes to Slack as well when Slack is connected — an overnight failure that
 * arrives as one more unread email is a failure you find on Thursday.
 *
 * Nothing here is allowed to matter to the run itself: if the mailbox isn't
 * connected, or SMTP refuses, or Slack is down, the scrape has still succeeded.
 */

const STATUS_HEADLINE: Record<string, string> = {
  SUCCEEDED: "finished",
  FAILED: "failed",
  ABORTED: "was stopped",
  TIMED_OUT: "ran out of time",
};

export async function reportRun(run: ScraperRun, source: ScraperSource): Promise<boolean> {
  const config = await readCaptureConfig();
  if (config.notify === "OFF") return false;

  const clean = run.status === "SUCCEEDED" && !run.error;
  if (config.notify === "FAILURES" && clean && run.leadsCreated > 0) return false;

  // A clean run that captured nothing is reported even in failures-only mode:
  // it is the quiet failure this exists to catch.
  const to = config.notifyEmail ?? (await getSetting(SETTING.MAIL_FROM_EMAIL));
  if (!to) return false;
  if (!(await readMailerConfig())) return false;

  const headline = STATUS_HEADLINE[run.status] ?? run.status.toLowerCase();
  const subject = clean
    ? run.leadsCreated > 0
      ? `Lead capture — ${run.leadsCreated} new from “${source.name}”`
      : `Lead capture — “${source.name}” found nothing`
    : `Lead capture — “${source.name}” ${headline}`;

  const body = [
    `“${source.name}” ${headline} at ${run.finishedAt?.toISOString().replace("T", " ").slice(0, 16) ?? "just now"} UTC.`,
    "",
    `Actor:      ${source.actorId}`,
    `Trigger:    ${run.trigger === "SCHEDULED" ? "scheduled run" : "started by hand"}`,
    `Rows read:  ${run.itemsFetched}`,
    `New leads:  ${run.leadsCreated}`,
    `Enriched:   ${run.leadsUpdated} existing`,
    `Filtered:   ${run.filtered} below the score floor of ${source.minScore}, or unusable`,
    run.costUsd != null ? `Cost:       $${run.costUsd.toFixed(2)}${run.estimateUsd != null ? ` (estimated $${run.estimateUsd.toFixed(2)})` : ""}` : "",
    // The account of what happened to the rows that didn't make it. This is
    // the difference between "0 new leads" and "0 new leads, all forty were
    // already in the pipeline" — one is a problem and one is not.
    describeDropped(run.diagnostics as RunDiagnostics | null),
    run.error ? `\nWhat went wrong:\n${run.error}` : "",
    clean && run.leadsCreated === 0 && run.itemsFetched > 0
      ? `\nEvery row was filtered out. Either the score floor of ${source.minScore} is too high for this segment, or the businesses were already in the pipeline.`
      : "",
    clean && run.itemsFetched === 0
      ? "\nThe actor returned no rows at all — usually the search terms or the location in the actor input."
      : "",
    `\n${await appUrl()}/lead-sources`,
  ]
    .filter(Boolean)
    .join("\n");

  const sign = await signature();
  await sendMail({ to, subject, html: toHtml(body, sign, null), text: toText(body, sign, null) });

  // Slack second, and never allowed to undo the email: the report has already
  // been delivered by the time this runs.
  if (await slackConfigured()) {
    await sendSlack({
      title: subject,
      text: body.split("\n").slice(0, 12).join("\n"),
      link: { text: "Open lead sources", url: `${await appUrl()}/lead-sources` },
    }).catch((err) => console.error("[capture] Slack report failed:", (err as Error).message));
  }

  return true;
}

/** The dropped-row reasons, worst first, as three lines at most. */
function describeDropped(diagnostics: RunDiagnostics | null): string {
  const dropped = diagnostics?.dropped ?? [];
  if (dropped.length === 0) return "";
  const lines = [...dropped]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((entry) => `  · ${entry.count}× ${entry.reason}`);
  return `\nWhy rows didn't become leads:\n${lines.join("\n")}`;
}

async function appUrl(): Promise<string> {
  return ((await getSetting(SETTING.APP_URL)) ?? "https://os.dakyworld.com").replace(/\/$/, "");
}
