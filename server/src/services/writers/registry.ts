/**
 * Which agent's words write which deliverable.
 *
 * The defect this exists to close: the Agents screen showed a prompt, the
 * founder edited it, and the next cold email came out identical — because the
 * email was never written by that prompt. It was written by a string constant
 * in `lib/emailDrafter.ts` that no screen displayed and no edit could reach.
 * The roster was a set of labels over a set of hard-coded writers, and
 * `DISCIPLINE_AGENTS` made that literal: it supplied the name printed on the
 * audit PDF — "Reviewed by the Page Reviewer" — while an anonymous prompt did
 * the reviewing.
 *
 * The doctrine was in two places at once. `outreach.writer`'s seed carries the
 * whole Cold Email Playbook in its `process` layer, and so did `draftSystem()`.
 * One of those was editable and the other was the one that ran.
 *
 * So every writing job is named here and given an owner. A job is a thing a
 * model writes; an owner is the agent whose card on the Agents screen governs
 * how it is written. The rule is one direction only — **an agent may own
 * several jobs, a job has exactly one owner** — because two agents editing one
 * deliverable is the contradiction that makes a model fall back to the generic
 * output it already knew.
 */

/** A thing a model writes, and the agent whose instruction governs it. */
export interface WriterJob {
  /** Stable id. Used in the settings key and in the API, so it does not change. */
  key: string;
  /** What it is, on the Agents screen. */
  label: string;
  /** The agent whose authored instruction writes it. */
  agentKey: string;
  /** The file that composes the call, for somebody reading this in a year. */
  where: string;
  /**
   * One sentence naming what the founder is changing if they edit it. Shown
   * under the agent's prompt, because "your words write this" is the fact the
   * screen was missing.
   */
  what: string;
  /**
   * True when the job writes something a person outside Dakyworld reads. These
   * are the ones where a prompt edit is visible to a customer, so the screen
   * marks them and the harness checks them first.
   */
  outward: boolean;
}

export const WRITER_JOBS: WriterJob[] = [
  {
    key: "email.cold",
    label: "Cold email",
    agentKey: "outreach.writer",
    where: "lib/emailDrafter.ts",
    what: "The first email to a business that has never heard of Dakyworld.",
    outward: true,
  },
  {
    key: "email.followup",
    label: "Follow-up email",
    agentKey: "outreach.followup",
    where: "lib/emailDrafter.ts",
    what: "The second and later emails to somebody who did not reply.",
    outward: true,
  },
  {
    key: "email.billing",
    label: "Invoice email",
    agentKey: "billing.collector",
    where: "lib/emailDrafter.ts",
    what: "The letters that deliver an invoice and chase a late one.",
    outward: true,
  },
  {
    key: "email.client",
    label: "Client email",
    agentKey: "client.notifier",
    where: "lib/emailDrafter.ts",
    what: "Project updates, handovers, onboarding and thank-yous — everything written to a client we already have.",
    outward: true,
  },
  {
    key: "message.phone",
    label: "WhatsApp and SMS",
    agentKey: "outreach.writer",
    where: "lib/messageDrafter.ts",
    what: "The short messages sent to a phone rather than an inbox.",
    outward: true,
  },
  {
    key: "proposal",
    label: "Proposal",
    agentKey: "proposal.writer",
    where: "lib/proposalWriter.ts",
    what: "The argued document that asks a business for money.",
    outward: true,
  },
  {
    key: "audit.ux",
    label: "Audit — what a visitor sees",
    agentKey: "review.look",
    where: "services/audit/ux.ts",
    what: "The reviewer that reads the screenshots and says what stops a first-time visitor.",
    outward: true,
  },
  {
    key: "audit.speed",
    label: "Audit — speed and findability",
    agentKey: "seo.specialist",
    where: "services/audit/performance.ts",
    // Deliberately narrow. This section's *findings* are arithmetic on a
    // header, a measured millisecond or a tag, and no model may add to them —
    // an edit here changes how the numbers are explained and can never
    // introduce a fault, which is the whole reason that reviewer is trusted.
    what: "How the measured speed and SEO numbers are explained. The findings themselves are measured, never written.",
    outward: true,
  },
  {
    key: "audit.content",
    label: "Audit — the words",
    agentKey: "content.writer",
    where: "services/audit/content.ts",
    what: "The reviewer that judges whether the page's words do the selling.",
    outward: true,
  },
  {
    key: "audit.synthesis",
    label: "Audit — the verdict",
    // The verdict is one judgement over four reviews, and it decides the
    // `consequence` sentence and the ask that the email drafter then reads as
    // fact. That makes it an outreach instrument as much as an audit one,
    // which is why it is owned by the writer whose doctrine it feeds.
    agentKey: "outreach.writer",
    where: "services/audit/synthesis.ts",
    what: "The single verdict over the four reviews, and the sentence the email is written from.",
    outward: true,
  },
  {
    key: "content.draft",
    label: "Dakyworld's own copy",
    agentKey: "content.writer",
    where: "services/tools/catalogue.ts",
    what: "Posts, landing pages and one-pagers written for Dakyworld itself, through the content.draft tool.",
    outward: true,
  },
  {
    key: "content.plain",
    label: "The plain-English rewrite",
    agentKey: "content.writer",
    where: "services/tools/catalogue.ts",
    what: "The content.plain tool, which rewrites business writing so it reads on one pass.",
    outward: false,
  },
  {
    key: "demo.page",
    label: "Demo page",
    agentKey: "dev.web",
    where: "services/demoBuilder.ts",
    what: "The free landing page built for one prospect, carrying their name in public.",
    outward: true,
  },
  {
    key: "lead.research",
    label: "Lead research",
    agentKey: "lead.enricher",
    where: "services/leadResearch.ts",
    what: "What is found out about a business before anybody writes to it.",
    outward: false,
  },
  {
    key: "homepage.look",
    label: "Homepage read",
    agentKey: "review.look",
    where: "services/homepageLook.ts",
    what: "The first read of a homepage, before the full audit.",
    outward: false,
  },
];

const BY_KEY = new Map(WRITER_JOBS.map((job) => [job.key, job]));

export function writerJob(key: string): WriterJob | null {
  return BY_KEY.get(key) ?? null;
}

/** The jobs one agent's wording governs. Empty for most of the roster, and that is honest. */
export function jobsOwnedBy(agentKey: string): WriterJob[] {
  return WRITER_JOBS.filter((job) => job.agentKey === agentKey);
}

/** Where a per-job override is stored. Read uncached — see brief.ts. */
export function briefSettingKey(jobKey: string): string {
  return `writer.brief.${jobKey}`;
}

/**
 * Which agent's wording writes an email of this purpose.
 *
 * Four owners rather than one, because "write an email" is not a job — a first
 * letter to a stranger, a nudge at somebody who did not reply, a chase for
 * money and a project update are four different pieces of writing with four
 * different registers, and the roster already splits them that way. Handing
 * all fifteen purposes to `outreach.writer` would put the cold email doctrine
 * — no price, never a meeting, one confirmed issue — in front of a model
 * writing a handover note to a paying client.
 *
 * The unmapped default is the client writer rather than the cold one. A
 * purpose nobody thought about is far likelier to be a note to somebody we
 * already work with than a first approach to a stranger, and the cold doctrine
 * is the one that does real damage when it lands in the wrong letter.
 */
export function emailJobFor(purpose: string): string {
  switch (purpose) {
    case "COLD_OUTREACH":
      return "email.cold";
    case "FOLLOW_UP":
    case "MEETING_REQUEST":
    case "REACTIVATION":
    case "DEMO_READY":
      return "email.followup";
    case "INVOICE_DELIVERY":
    case "INVOICE_REMINDER":
      return "email.billing";
    default:
      return "email.client";
  }
}
