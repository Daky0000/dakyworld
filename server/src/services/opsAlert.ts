import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { acquireLease } from "../lib/leases.js";
import { sendMail } from "../lib/mailer.js";
import { brandedNotice } from "./transactionalEmail.js";

/**
 * Telling the Owner, by email, that something needs a person.
 *
 * The 9 Oct 2026 worker crash loop ran for five hours with nobody told: the
 * process died, Railway restarted it, and the only record was a log line on a
 * deployment that had already been replaced. Email is the channel that is
 * always configured here (every account email depends on it), so everything
 * that must reach a person comes through this one place: the worker going
 * quiet, a run of server errors, a process crashing, and a website enquiry.
 */

export interface OwnerEmail {
  subject: string;
  paragraphs: string[];
  action?: { label: string; url: string } | null;
  footnotes?: string[];
  /** What the delivery log calls it, e.g. `ops:worker-down`. */
  category: string;
  /** Where a reply should go: an enquiry is answered by replying to it. */
  replyTo?: string | null;
}

/** Sends one email to `OWNER_EMAIL`. False when there is nobody to send it to. */
export async function emailOwner(message: OwnerEmail): Promise<boolean> {
  const to = process.env.OWNER_EMAIL?.trim();
  if (!to) {
    console.error(`[ops-alert] "${message.subject}" was not emailed: OWNER_EMAIL is not set.`);
    return false;
  }
  const { html, text } = await brandedNotice({
    greeting: null,
    paragraphs: message.paragraphs,
    action: message.action ?? null,
    footnotes: message.footnotes,
  });
  await sendMail({ to, subject: message.subject, html, text, category: message.category, ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
  return true;
}

/**
 * The same email, at most once per `leaseKey` per `quietSeconds`, across every
 * replica. A failed send frees the key again, so the next occurrence retries
 * rather than staying silent for the whole window.
 */
export async function alertOwnerOnce(leaseKey: string, quietSeconds: number, message: OwnerEmail): Promise<"sent" | "quiet" | "nobody"> {
  if (!(await acquireLease(leaseKey, randomUUID(), quietSeconds))) return "quiet";
  try {
    return (await emailOwner(message)) ? "sent" : "nobody";
  } catch (error) {
    await prisma.serviceLease.deleteMany({ where: { key: leaseKey } }).catch(() => undefined);
    throw error;
  }
}

/* --------------------------------------------------- a run of server errors -- */

/** Five unexplained 500s inside ten minutes is a fault, not bad luck. */
export const ERROR_BURST_WINDOW_MS = 10 * 60_000;
export const ERROR_BURST_THRESHOLD = 5;
const ERROR_BURST_LEASE = "error-burst-alert";
const ERROR_BURST_QUIET_SECONDS = 3600;

export interface ServerErrorNote {
  at: number;
  reference: string;
  /** Method and path, never the query string or the body. */
  route: string;
  /** The first line of the message, which is what a log search needs. */
  line: string;
}

const recentErrors: ServerErrorNote[] = [];

/**
 * Records one 500 and returns the window's errors once they reach the
 * threshold, or null. Pure apart from the module's own list, so the window and
 * the threshold can be checked without a server.
 */
export function noteServerError(note: ServerErrorNote, now = note.at): ServerErrorNote[] | null {
  recentErrors.push(note);
  while (recentErrors.length && recentErrors[0]!.at < now - ERROR_BURST_WINDOW_MS) recentErrors.shift();
  // Bounded whatever happens: the email lists the most recent few anyway.
  if (recentErrors.length > 50) recentErrors.splice(0, recentErrors.length - 50);
  return recentErrors.length >= ERROR_BURST_THRESHOLD ? recentErrors.slice() : null;
}

/** For the check: start from an empty window. */
export function resetServerErrors(): void {
  recentErrors.length = 0;
}

export function firstLine(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (message.split("\n")[0] ?? "").slice(0, 300);
}

/** Called by the error handler for every unexplained 500. Never throws. */
export function reportServerError(note: ServerErrorNote): void {
  const burst = noteServerError(note);
  if (!burst || process.env.NODE_ENV !== "production") return;
  const listed = burst.slice(-10).map((e) => `${new Date(e.at).toISOString().slice(11, 19)} UTC · ${e.route} · ref ${e.reference} · ${e.line}`);
  void alertOwnerOnce(ERROR_BURST_LEASE, ERROR_BURST_QUIET_SECONDS, {
    subject: `The OS answered ${burst.length} requests with an error in ten minutes`,
    paragraphs: [
      `In the last ten minutes ${burst.length} requests to the DakyXTech OS failed with "Something went wrong". Each one has a reference that appears beside its full error in the Railway logs.`,
      ...listed,
      "Open the API service in Railway, search the logs for one of these references, and read the error printed under it.",
    ],
    footnotes: ["You will hear about this again at most once an hour."],
    category: "ops:error-burst",
  }).catch((error) => console.error("[ops-alert] could not email about the error burst:", (error as Error).message));
}

/* ------------------------------------------------------ a crashing process -- */

/**
 * Logs and reports a crash, then exits exactly as Node would have.
 *
 * Without these handlers Node prints the error and exits, Railway restarts the
 * service, and nobody hears about it until the restarts run out. The behaviour
 * is kept, because a process after an uncaught exception is in an unknown
 * state and restarting is the safe answer. What changes is that somebody is
 * told: once an hour per service at most, and never holding the exit for more
 * than three seconds.
 */
export function installCrashReporting(service: string): void {
  let exiting = false;
  const crash = (kind: "uncaughtException" | "unhandledRejection", reason: unknown) => {
    console.error(`[crash] ${service}: ${kind}:`, reason);
    if (exiting) return;
    exiting = true;
    const exit = () => process.exit(1);
    if (process.env.NODE_ENV !== "production") return exit();
    const deadline = setTimeout(exit, 3000);
    void alertOwnerOnce(`crash-alert:${service}`, 3600, {
      subject: `The OS ${service} crashed and is restarting`,
      paragraphs: [
        `The ${service} process stopped on an error nothing caught (${kind}). Railway restarts it on its own, so the cause matters more than the restart.`,
        firstLine(reason),
        `Open the ${service} service in Railway and read the end of the logs from just before the restart; the full error is printed there under "[crash]".`,
      ],
      footnotes: ["If it keeps crashing you will hear again at most once an hour. Railway stops restarting a service that fails too many times in a row."],
      category: "ops:crash",
    })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(deadline);
        exit();
      });
  };
  process.on("uncaughtException", (error) => crash("uncaughtException", error));
  process.on("unhandledRejection", (reason) => crash("unhandledRejection", reason));
}
