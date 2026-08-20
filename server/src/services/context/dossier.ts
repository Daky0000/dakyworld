import type { ContextNoteKind } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { findSecret, MemoryRefused } from "../agents/memory.js";

/**
 * Everything known about one company, as one document.
 *
 * An agent picking up a lead used to be handed the lead row and nothing else.
 * That is the record's *current state* — a name, a status, a score — and it
 * says nothing about how it got there. So the cold writer did not know the site
 * had been audited in June, the follow-up did not know they had replied asking
 * about price, and the collector did not know somebody had already agreed terms
 * on the phone. Each of those is a letter that reads as though nobody here has
 * been paying attention, because nobody had.
 *
 * **The dossier is assembled at read time, not stored.** Nothing here
 * duplicates a row into an event log. The audit is read from `WebsiteAudit`,
 * the letters from `EmailMessage`, the calls from `Communication`, and so on.
 * Two reasons, and the second is the one that decides it:
 *
 * 1. A fact with two homes eventually has two values. Correcting a record
 *    would leave the log saying the old thing, and the log is what an agent
 *    reads.
 * 2. **The history that already exists is in it on the first day.** A log only
 *    knows what happened after it was switched on; every company audited
 *    before this shipped would have had an empty dossier, which is exactly the
 *    case where an agent most needs one.
 *
 * What the source tables cannot hold is everything with no home of its own —
 * an observation worth passing on, a call somebody took, a decision and what
 * came of it. That is `ContextNote`, and it is the part agents add to as they
 * work.
 *
 * **Context is not memory.** Memory is what an agent *concluded* and is
 * presented as its own opinion, which the record can overrule. Context is what
 * *happened*, and it is evidence. Keeping them apart is what lets an agent be
 * told "your own conclusions lose to the record in front of you" and have that
 * mean something.
 */

export type SubjectKind = "lead" | "client" | "project";

export interface Subject {
  kind: SubjectKind;
  id: string;
  /** The canonical string — `lead:abc123`. Same vocabulary as memory's subjects. */
  key: string;
}

/** Null when the string is not a subject this can gather on. */
export function parseSubject(raw: string): Subject | null {
  const [kind, ...rest] = raw.split(":");
  const id = rest.join(":");
  if (!id) return null;
  if (kind !== "lead" && kind !== "client" && kind !== "project") return null;
  return { kind, id, key: `${kind}:${id}` };
}

/** One thing that happened, from whichever table happened to hold it. */
export interface DossierEntry {
  at: Date;
  /** A short label for the timeline — "Website review", "Email sent". */
  kind: string;
  title: string;
  /** The body, where there is one worth reading. Markdown. */
  detail?: string;
  /** Kept out of the recency cut. */
  pinned?: boolean;
}

const when = (date: Date) => date.toISOString().slice(0, 10);

const money = (amount: { toString(): string } | null | undefined, currency = "GHS") =>
  amount === null || amount === undefined ? "not set" : `${currency} ${Number(amount.toString()).toLocaleString("en-GB")}`;

/** Trims a block of prose to something a prompt can afford, on a word boundary. */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, clean.lastIndexOf(" ", max) || max)}…`;
}

// --- Who this is ------------------------------------------------------------

export interface DossierHeader {
  /** What to call them. */
  name: string;
  /** The lines under the name — status, score, where they came from. */
  facts: string[];
  /** True when the subject exists at all. */
  found: boolean;
  /** The other subject keys this company also answers to, if any. */
  alsoKnownAs: string[];
}

/**
 * The identity block, and the other keys the same company is filed under.
 *
 * A lead that converts becomes a `Client` and keeps its `Lead` row, so one
 * company can be `lead:abc` *and* `client:xyz` at once. Gathering only the key
 * that was asked for would hide half of its own history at exactly the moment
 * it gets interesting — the point of conversion. So both are gathered, always.
 */
async function resolveSubject(subject: Subject): Promise<{ header: DossierHeader; leadIds: string[]; clientIds: string[]; projectIds: string[] }> {
  const leadIds: string[] = [];
  const clientIds: string[] = [];
  const projectIds: string[] = [];
  const alsoKnownAs: string[] = [];

  if (subject.kind === "lead") {
    const lead = await prisma.lead.findUnique({
      where: { id: subject.id },
      select: {
        id: true, contactName: true, companyName: true, contactEmail: true, contactPhone: true,
        website: true, city: true, region: true, category: true, status: true, leadScore: true,
        source: true, estimatedDealSize: true, tags: true, createdAt: true, clientId: true,
      },
    });
    if (!lead) return { header: { name: subject.key, facts: [], found: false, alsoKnownAs: [] }, leadIds, clientIds, projectIds };

    leadIds.push(lead.id);
    if (lead.clientId) {
      clientIds.push(lead.clientId);
      alsoKnownAs.push(`client:${lead.clientId}`);
    }

    return {
      header: {
        name: lead.companyName || lead.contactName,
        found: true,
        alsoKnownAs,
        facts: [
          `Contact: ${lead.contactName}${lead.contactEmail ? ` · ${lead.contactEmail}` : ""}${lead.contactPhone ? ` · ${lead.contactPhone}` : ""}`,
          `Website: ${lead.website ?? "none on file"}`,
          `${[lead.city, lead.region, lead.category].filter(Boolean).join(" · ") || "No location or trade recorded"}`,
          `Pipeline: ${lead.status}, score ${lead.leadScore} · found via ${lead.source} on ${when(lead.createdAt)}`,
          `Estimated deal size: ${money(lead.estimatedDealSize)}`,
          lead.tags.length > 0 ? `Tags: ${lead.tags.join(", ")}` : "",
          lead.clientId ? "This lead has become a client — their client history is included below." : "",
        ].filter(Boolean),
      },
      leadIds,
      clientIds,
      projectIds,
    };
  }

  if (subject.kind === "client") {
    const client = await prisma.client.findUnique({
      where: { id: subject.id },
      select: {
        id: true, name: true, company: true, email: true, phone: true, address: true, sector: true,
        lifetimeValue: true, creditTerms: true, firstContactAt: true,
        leads: { select: { id: true } },
        projects: { select: { id: true } },
      },
    });
    if (!client) return { header: { name: subject.key, facts: [], found: false, alsoKnownAs: [] }, leadIds, clientIds, projectIds };

    clientIds.push(client.id);
    // The lead rows this client grew out of. Their audits, their first letters
    // and the argument that won the work all still hang off the lead.
    for (const lead of client.leads) {
      leadIds.push(lead.id);
      alsoKnownAs.push(`lead:${lead.id}`);
    }
    for (const project of client.projects) projectIds.push(project.id);

    return {
      header: {
        name: client.company || client.name,
        found: true,
        alsoKnownAs,
        facts: [
          `Contact: ${client.name}${client.email ? ` · ${client.email}` : ""}${client.phone ? ` · ${client.phone}` : ""}`,
          client.address ? `Address: ${client.address}` : "",
          client.sector ? `Sector: ${client.sector}` : "",
          `Lifetime value ${money(client.lifetimeValue)}${client.creditTerms ? ` · terms ${client.creditTerms}` : ""}`,
          client.firstContactAt ? `Client since ${when(client.firstContactAt)}` : "",
          client.leads.length > 0 ? `Grew out of ${client.leads.length} lead record(s), whose history is included below.` : "",
        ].filter(Boolean),
      },
      leadIds,
      clientIds,
      projectIds,
    };
  }

  const project = await prisma.project.findUnique({
    where: { id: subject.id },
    select: {
      id: true, name: true, serviceType: true, status: true, scopeSummary: true,
      startDate: true, endDate: true, budgetAmount: true,
      client: { select: { id: true, name: true, company: true } },
    },
  });
  if (!project) return { header: { name: subject.key, facts: [], found: false, alsoKnownAs: [] }, leadIds, clientIds, projectIds };

  projectIds.push(project.id);
  clientIds.push(project.client.id);
  alsoKnownAs.push(`client:${project.client.id}`);

  return {
    header: {
      name: project.name,
      found: true,
      alsoKnownAs,
      facts: [
        `For ${project.client.company || project.client.name}`,
        `${project.status} · ${project.serviceType} · budget ${money(project.budgetAmount)}`,
        `${project.startDate ? `Started ${when(project.startDate)}` : "Not started"}${project.endDate ? ` · ends ${when(project.endDate)}` : ""}`,
        `Scope: ${clip(project.scopeSummary, 400)}`,
      ].filter(Boolean),
    },
    leadIds,
    clientIds,
    projectIds,
  };
}

// --- What happened ----------------------------------------------------------

/**
 * Every dated thing about this company, newest first.
 *
 * Deliberately reads narrow columns. The full HTML of forty emails and the
 * stored markup of three audits would be several megabytes, and the caller
 * wants a timeline, not the archive — anything worth the whole of is fetched
 * by its own tool afterwards.
 */
export async function gatherEntries(subject: Subject): Promise<{ header: DossierHeader; entries: DossierEntry[] }> {
  const { header, leadIds, clientIds, projectIds } = await resolveSubject(subject);
  if (!header.found) return { header, entries: [] };

  const anyLead = leadIds.length > 0 ? { in: leadIds } : undefined;
  const anyClient = clientIds.length > 0 ? { in: clientIds } : undefined;
  const anyProject = projectIds.length > 0 ? { in: projectIds } : undefined;

  // Every subject key this company answers to, so a note filed against the lead
  // is found when the dossier is asked for by client id.
  const noteSubjects = [subject.key, ...header.alsoKnownAs];

  const [audits, research, comms, emails, proposals, invoices, demos, notes] = await Promise.all([
    anyLead
      ? prisma.websiteAudit.findMany({
          where: { leadId: anyLead },
          select: { id: true, ranAt: true, overallScore: true, verdict: true, website: true, report: true },
          orderBy: { ranAt: "desc" },
          take: 6,
        })
      : [],
    anyLead
      ? prisma.leadResearch.findMany({
          where: { leadId: anyLead },
          select: { ranAt: true, facts: true, notes: true },
          orderBy: { ranAt: "desc" },
          take: 3,
        })
      : [],
    prisma.communication.findMany({
      where: { OR: [{ leadId: anyLead }, { clientId: anyClient }, { projectId: anyProject }].filter((clause) => Object.values(clause)[0] !== undefined) },
      select: { type: true, summary: true, outcome: true, occurredAt: true },
      orderBy: { occurredAt: "desc" },
      take: 60,
    }),
    prisma.emailMessage.findMany({
      where: {
        OR: [{ leadId: anyLead }, { clientId: anyClient }, { projectId: anyProject }].filter((clause) => Object.values(clause)[0] !== undefined),
        status: { in: ["SENT", "SCHEDULED", "FAILED"] },
      },
      select: { subject: true, status: true, purpose: true, sentAt: true, scheduledFor: true, createdAt: true, bodyText: true, toEmail: true, error: true },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.proposal.findMany({
      where: { OR: [{ leadId: anyLead }, { clientId: anyClient }].filter((clause) => Object.values(clause)[0] !== undefined) },
      select: { title: true, status: true, serviceType: true, priceAmount: true, currency: true, sentAt: true, respondedAt: true, createdAt: true, scopeSummary: true },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    anyClient
      ? prisma.invoice.findMany({
          where: { clientId: anyClient },
          select: { invoiceNumber: true, status: true, amountTotal: true, currency: true, issueDate: true, dueDate: true, paidAt: true, paidVia: true },
          orderBy: { issueDate: "desc" },
          take: 20,
        })
      : [],
    anyLead
      ? prisma.demo.findMany({
          where: { leadId: anyLead },
          select: { slug: true, title: true, status: true, views: true, sentAt: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 6,
        })
      : [],
    prisma.contextNote.findMany({
      where: { subject: { in: noteSubjects } },
      orderBy: { occurredAt: "desc" },
      take: 120,
    }),
  ]);

  const entries: DossierEntry[] = [];

  for (const audit of audits) {
    // The findings are the part a letter argues from, so a few of the worst are
    // worth carrying; the whole report is a tool call away.
    const report = audit.report as { priorities?: Array<{ title?: string; finding?: string }> } | null;
    const priorities = (report?.priorities ?? [])
      .map((entry) => entry.title || entry.finding)
      .filter((value): value is string => Boolean(value))
      .slice(0, 4);
    entries.push({
      at: audit.ranAt,
      kind: "Website review",
      title: `Scored ${audit.overallScore}/100 — ${audit.verdict}${audit.website ? ` (${audit.website})` : ""}`,
      detail: priorities.length > 0 ? priorities.map((line) => `- ${clip(line, 160)}`).join("\n") : undefined,
    });
  }

  for (const row of research) {
    entries.push({
      at: row.ranAt,
      kind: "Research",
      title: "Looked them up against live sources",
      detail: [...row.facts.slice(0, 8).map((fact) => `- ${clip(fact, 180)}`), ...row.notes.slice(0, 3).map((note) => `- (unverified) ${clip(note, 160)}`)].join("\n") || undefined,
    });
  }

  for (const comm of comms) {
    entries.push({
      at: comm.occurredAt,
      kind: comm.type === "EMAIL" ? "Email" : comm.type === "CALL" ? "Call" : comm.type === "MEETING" ? "Meeting" : "Message",
      title: clip(comm.summary, 200),
      detail: comm.outcome ? `Outcome: ${clip(comm.outcome, 300)}` : undefined,
    });
  }

  for (const email of emails) {
    const at = email.sentAt ?? email.scheduledFor ?? email.createdAt;
    const state = email.status === "SENT" ? "Sent" : email.status === "FAILED" ? "Failed to send" : "Scheduled";
    entries.push({
      at,
      kind: "Email out",
      title: `${state}: "${clip(email.subject, 120)}" to ${email.toEmail}`,
      detail: email.status === "FAILED" && email.error ? `Error: ${clip(email.error, 200)}` : clip(email.bodyText, 400),
    });
  }

  for (const proposal of proposals) {
    entries.push({
      at: proposal.sentAt ?? proposal.createdAt,
      kind: "Proposal",
      title: `${proposal.title} — ${proposal.status}, ${money(proposal.priceAmount, proposal.currency)}`,
      detail: [proposal.serviceType, clip(proposal.scopeSummary, 300)].filter(Boolean).join(" · "),
    });
    if (proposal.respondedAt) {
      entries.push({ at: proposal.respondedAt, kind: "Proposal", title: `They responded — ${proposal.status}` });
    }
  }

  for (const invoice of invoices) {
    const overdue = invoice.status !== "PAID" && invoice.dueDate < new Date();
    entries.push({
      at: invoice.issueDate,
      kind: "Invoice",
      title: `${invoice.invoiceNumber} — ${money(invoice.amountTotal, invoice.currency)}, ${invoice.status}${overdue ? " (overdue)" : ""}`,
      detail: `Due ${when(invoice.dueDate)}`,
    });
    if (invoice.paidAt) {
      entries.push({
        at: invoice.paidAt,
        kind: "Payment",
        title: `${invoice.invoiceNumber} paid${invoice.paidVia ? ` by ${invoice.paidVia}` : ""}`,
      });
    }
  }

  for (const demo of demos) {
    entries.push({
      at: demo.sentAt ?? demo.createdAt,
      kind: "Demo page",
      title: `${demo.title} — ${demo.status}${demo.sentAt ? ", sent" : ", not sent"}${demo.views > 0 ? `, viewed ${demo.views}×` : ""}`,
      detail: `/demos/${demo.slug}`,
    });
  }

  for (const note of notes) {
    entries.push({
      at: note.occurredAt,
      kind: labelForNote(note.kind),
      title: clip(note.summary, 200),
      detail: note.body ?? undefined,
      pinned: note.pinned,
    });
  }

  entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { header, entries };
}

function labelForNote(kind: ContextNoteKind): string {
  switch (kind) {
    case "CALL":
      return "Call";
    case "MEETING":
      return "Meeting";
    case "REPLY":
      return "They replied";
    case "DECISION":
      return "Decision";
    case "OUTCOME":
      return "Outcome";
    case "RISK":
      return "Risk";
    default:
      return "Note";
  }
}

// --- Rendering --------------------------------------------------------------

export interface DossierOptions {
  /**
   * How many dated entries to print. Pinned notes are printed regardless and
   * do not count against it — the point of pinning something is that it does
   * not fall off the bottom.
   */
  limit?: number;
  /** Drop the bodies and keep the one-line titles. What the prompt gets. */
  brief?: boolean;
  /** Said at the end, when there is a tool that can fetch the rest. */
  moreAvailable?: boolean;
}

/**
 * The dossier as Markdown.
 *
 * Markdown rather than JSON because this is read by models far more often than
 * by code, and a heading costs fewer tokens than a quoted key repeated forty
 * times. It is also, not coincidentally, the form a person wants when they ask
 * to see it — which is why the PDF export renders this same text rather than
 * assembling a second version of it.
 */
export async function renderDossier(subjectKey: string, options: DossierOptions = {}): Promise<string> {
  const subject = parseSubject(subjectKey);
  if (!subject) return `No such record: ${subjectKey}.`;

  const { header, entries } = await gatherEntries(subject);
  if (!header.found) return `No record found for ${subjectKey}.`;

  const limit = options.limit ?? 40;
  const pinned = entries.filter((entry) => entry.pinned);
  const rest = entries.filter((entry) => !entry.pinned).slice(0, limit);
  const hidden = entries.filter((entry) => !entry.pinned).length - rest.length;

  const lines: string[] = [`# ${header.name}`, ""];
  for (const fact of header.facts) lines.push(`- ${fact}`);

  if (pinned.length > 0) {
    lines.push("", "## Worth knowing before you do anything", "");
    for (const entry of pinned) {
      lines.push(`- **${entry.title}**${entry.detail && !options.brief ? `  \n  ${entry.detail.replace(/\n/g, "\n  ")}` : ""}`);
    }
  }

  lines.push("", "## What has happened", "");
  if (rest.length === 0) {
    lines.push("_Nothing has been recorded about this company yet._");
  }

  for (const entry of rest) {
    lines.push(`### ${when(entry.at)} · ${entry.kind}`, "", entry.title);
    if (entry.detail && !options.brief) lines.push("", entry.detail);
    lines.push("");
  }

  if (hidden > 0) {
    lines.push(
      options.moreAvailable
        ? `_${hidden} older entr${hidden === 1 ? "y is" : "ies are"} not shown. Use \`context.read\` with a larger limit to see them._`
        : `_${hidden} older entr${hidden === 1 ? "y" : "ies"} not shown._`,
    );
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The short form that goes into every task brief.
 *
 * Hard-capped, because this is paid for on every single task whether it turns
 * out to matter or not. Titles only, the most recent handful, and a sentence
 * telling the agent the rest is one tool call away — which is the trade that
 * makes it affordable: the common case costs a few hundred tokens, and the
 * task that genuinely needs the whole history can ask for it.
 */
export async function dossierForPrompt(subjectKeys: string[]): Promise<string> {
  const usable = subjectKeys.map(parseSubject).filter((subject): subject is Subject => subject !== null);
  if (usable.length === 0) return "";

  // One subject is the normal case. Where a task names both a lead and the
  // client it became, the lead's dossier already gathers the client's history,
  // so rendering both would print most of it twice.
  const [primary] = usable;
  const rendered = await renderDossier(primary.key, { limit: 12, brief: true, moreAvailable: true });
  if (!rendered || rendered.startsWith("No record")) return "";

  return [
    "WHAT WE ALREADY KNOW ABOUT THIS COMPANY — assembled from our own records. This is what happened, not what anyone concluded; treat it as evidence you may cite.",
    "",
    rendered,
  ].join("\n");
}

// --- Adding to it -----------------------------------------------------------

export interface NoteInput {
  subject: string;
  kind?: ContextNoteKind;
  summary: string;
  body?: string | null;
  authorKey: string;
  pinned?: boolean;
  occurredAt?: Date;
  sourceTaskId?: string | null;
}

/**
 * Writes one entry into a company's history.
 *
 * The credential check is the same one memory uses, for the same reason and
 * not a second implementation of it: a note is re-read into a prompt every
 * time this company comes up, so a password written into one is a password
 * read aloud every morning until somebody notices.
 */
export async function appendNote(input: NoteInput) {
  const subject = parseSubject(input.subject);
  if (!subject) throw new MemoryRefused(`"${input.subject}" is not a record. Use lead:<id>, client:<id> or project:<id>.`);

  const summary = input.summary.trim().slice(0, 300);
  if (summary.length < 4) throw new MemoryRefused("That is too short to be worth recording.");

  const body = input.body?.trim().slice(0, 4000) || null;
  const secret = findSecret([summary, body].filter(Boolean).join("\n"));
  if (secret) {
    throw new MemoryRefused(
      `That looks like it contains ${secret}. A note is re-read into a prompt every time this company comes up — write down what happened, never the credential.`,
    );
  }

  return prisma.contextNote.create({
    data: {
      subject: subject.key,
      kind: input.kind ?? "NOTE",
      summary,
      body,
      authorKey: input.authorKey,
      pinned: input.pinned ?? false,
      occurredAt: input.occurredAt ?? new Date(),
      sourceTaskId: input.sourceTaskId ?? null,
    },
  });
}

export async function listNotes(subjectKey: string, limit = 100) {
  const subject = parseSubject(subjectKey);
  if (!subject) return [];
  const { alsoKnownAs } = (await resolveSubject(subject)).header;
  return prisma.contextNote.findMany({
    where: { subject: { in: [subject.key, ...alsoKnownAs] } },
    orderBy: [{ pinned: "desc" }, { occurredAt: "desc" }],
    take: limit,
  });
}

export async function editNote(id: string, changes: { summary?: string; body?: string | null; pinned?: boolean; kind?: ContextNoteKind }) {
  const data: Record<string, unknown> = {};

  if (changes.summary !== undefined || changes.body !== undefined) {
    const secret = findSecret([changes.summary ?? "", changes.body ?? ""].join("\n"));
    if (secret) throw new MemoryRefused(`That looks like it contains ${secret}. Write down what happened, never the credential.`);
  }
  if (changes.summary !== undefined) {
    const summary = changes.summary.trim().slice(0, 300);
    if (summary.length < 4) throw new MemoryRefused("That is too short to be worth recording.");
    data.summary = summary;
  }
  if (changes.body !== undefined) data.body = changes.body?.trim().slice(0, 4000) || null;
  if (changes.pinned !== undefined) data.pinned = changes.pinned;
  if (changes.kind !== undefined) data.kind = changes.kind;

  return prisma.contextNote.update({ where: { id }, data });
}

export async function deleteNote(id: string) {
  await prisma.contextNote.deleteMany({ where: { id } });
}
