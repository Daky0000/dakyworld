import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { mailerConfigured, sendMail } from "../lib/mailer.js";
import { brandedNotice } from "./transactionalEmail.js";
import { signInBaseFor } from "./accountAccess.js";

/**
 * An email to whoever published, when a publish did not reach the live site.
 *
 * The corner toast in the editor only helps while the editor is open. A host
 * build that fails after somebody has closed the tab, or a host that never
 * rebuilds, used to be found out by a customer looking at their own website a
 * day later. Now the person who pressed Publish is told, once, in plain words,
 * with what the host said when it said anything.
 *
 * Only for the two real failures: the host reporting a failed build
 * (`DEPLOY_FAILED`) and the live page still not showing the change after a day
 * (`VERIFY_FAILED`). A slow host is not a failure, and nobody is emailed about
 * one. Recorded on the job (`detail.notifiedAt`) so it is sent once.
 */
export async function notifyPublishProblem(jobId: string): Promise<"sent" | "skipped"> {
  const job = await prisma.publishJob.findUnique({
    where: { id: jobId },
    include: { startedBy: { select: { id: true, email: true, name: true } }, site: { select: { id: true, name: true } }, page: { select: { title: true, path: true } } },
  });
  if (!job || !["DEPLOY_FAILED", "VERIFY_FAILED"].includes(job.state)) return "skipped";
  const detail = (job.detail && typeof job.detail === "object" && !Array.isArray(job.detail) ? job.detail : {}) as Record<string, unknown>;
  if (detail.notifiedAt || !job.startedBy?.email) return "skipped";
  if (!(await mailerConfigured())) {
    console.warn(`[publish-notice] no mailer configured: publish ${job.id} on ${job.site.name} failed (${job.state}).`);
    return "skipped";
  }

  // Claimed before sending, so two ticks cannot both send it.
  const claimed = await prisma.publishJob.updateMany({
    // Unchanged since it was read: another tick sending first would have moved updatedAt.
    where: { id: job.id, state: job.state, updatedAt: job.updatedAt },
    data: { detail: { ...detail, notifiedAt: new Date().toISOString() } as Prisma.InputJsonValue },
  }).catch(() => ({ count: 0 }));
  if (!claimed.count) return "skipped";

  const what = job.page ? `${job.page.title} (${job.page.path})` : job.site.name;
  const paragraphs = job.state === "DEPLOY_FAILED"
    ? [
        `Your change to ${what} is saved in your website's repository, but your host could not rebuild the site, so it is not on your live website yet.`,
        ...(job.hostMessage ? [`Your host said: "${job.hostMessage}"`] : []),
        "This is usually something in the host's build settings. Whoever manages your hosting can open the host's deploy page to see the full log. Publishing again will try again.",
      ]
    : [
        `Your change to ${what} is saved in your website's repository, but a day later your live website still shows the old version.`,
        "Your host may have stopped rebuilding the site, or may be serving an old copy. Whoever manages your hosting can check the host's deploy page.",
      ];
  const base = await signInBaseFor(job.startedBy.id);
  const { html, text } = await brandedNotice({
    greeting: job.startedBy.name.split(" ")[0] ?? "there",
    paragraphs,
    action: { label: "See how your site goes live", url: `${base}/website/settings?site=${encodeURIComponent(job.site.id)}` },
    footnotes: ["You are getting this because you published this change. DakyX sends it once per publish."],
  });
  await sendMail({ to: job.startedBy.email, toName: job.startedBy.name, subject: `Your change to ${job.site.name} is not live yet`, html, text, category: "website:publish-problem" });
  return "sent";
}

/** Fire-and-forget, from the watcher. A failure here never touches the publish record. */
export function notifyPublishProblemSoon(jobId: string): void {
  const timer = setTimeout(() => void notifyPublishProblem(jobId).catch((error) => console.error(`[publish-notice] ${jobId}:`, error)), 0);
  timer.unref?.();
}
