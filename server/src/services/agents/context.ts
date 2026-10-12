import type { AgentTask } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { livingContextBlock, subjectOf } from "./memory.js";
import { dossierForPrompt, parseSubject } from "../context/dossier.js";

/**
 * What the agent is told the task is.
 *
 * A brief on its own — "follow up on this lead" — makes an agent's first three
 * tool calls a re-read of things the system already knew when it raised the
 * task. So the record the task is about is put in front of it, resolved, at
 * the start.
 *
 * Deliberately narrow. It is what a person would put in the first line of a
 * handover note, not a database dump: enough to know what this is and where it
 * stands, and no more, because everything beyond that the agent can fetch with
 * a tool if it turns out to matter — and fetching is how a fact becomes
 * evidence it may cite.
 */

/** The memory subjects a task touches. Order matters: the first is where `remember` files. */
export function taskSubjects(task: Pick<AgentTask, "leadId" | "clientId" | "projectId" | "proposalId" | "invoiceId">): string[] {
  const subjects: string[] = [];
  if (task.leadId) subjects.push(subjectOf.lead(task.leadId));
  if (task.clientId) subjects.push(subjectOf.client(task.clientId));
  if (task.projectId) subjects.push(subjectOf.project(task.projectId));
  if (task.proposalId) subjects.push(subjectOf.proposal(task.proposalId));
  if (task.invoiceId) subjects.push(subjectOf.invoice(task.invoiceId));
  return subjects;
}

const money = (amount: { toString(): string } | null | undefined, currency = "GHS") =>
  amount === null || amount === undefined ? "not set" : `${currency} ${Number(amount.toString()).toLocaleString("en-GB")}`;

const when = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : "not set");

/** Everything the task points at, resolved into a block a person could read. */
export async function describeTask(task: AgentTask): Promise<string> {
  const parts: string[] = [`TASK: ${task.title}`, "", task.brief];

  if (task.dueAt) parts.push("", `Due: ${when(task.dueAt)}.`);
  if (task.origin === "AGENT" && task.parentId) {
    const parent = await prisma.agentTask.findUnique({
      where: { id: task.parentId },
      select: { title: true, agent: { select: { name: true } } },
    });
    if (parent) parts.push("", `Handed to you by ${parent.agent.name}, as part of: ${parent.title}.`);
  }

  const subjects = taskSubjects(task);
  // `readHistory` renders the first subject, and only a lead, a client or a
  // project has a history to render — the same test the tool itself applies.
  const readWith = subjects[0] && parseSubject(subjects[0]) ? "readHistory" : undefined;
  const [records, livingState, dossier, otherWork] = await Promise.all([
    resolveRecords(task),
    livingContextBlock(subjects, { readWith }),
    dossierForPrompt(subjects),
    otherWorkOn(task),
  ]);

  if (livingState) {
    parts.push("", livingState);
  }

  if (records.length > 0) {
    parts.push("", "WHAT THIS IS ABOUT — the current state of the record. Anything not here, fetch with a tool rather than assume:", ...records);
  }

  // The record says where this stands. The dossier says how it got there, and
  // without it an agent writes as though nobody here has spoken to this company
  // before — which, three letters in, is the thing the reader notices.
  //
  // Kept short on purpose: this is paid for on every task whether it turns out
  // to matter or not, so it is the headlines and a sentence saying the rest is
  // one `readHistory` away.
  if (dossier) parts.push("", dossier);

  if (otherWork) parts.push("", otherWork);

  // The checks a delegating manager wrote down for this piece of work. Printed
  // as a list the agent has to answer item by item rather than left inside the
  // JSON below, where a list of conditions reads as more background.
  const { acceptance, rest } = splitAcceptance(task.input);
  if (rest && typeof rest === "object") {
    parts.push("", `Additional context supplied with the task:\n${JSON.stringify(rest, null, 1).slice(0, 3000)}`);
  }
  if (acceptance.length > 0) {
    parts.push("", "ACCEPTANCE — say, for each, whether it is met:", ...acceptance.map((item) => `- ${item}`));
  }

  // There used to be a closing paragraph here telling the agent to call
  // `update_living_context`. The working region of the system prompt and the
  // tool's own description already say it, and a third wording in a third
  // place is how a model ends up averaging instructions into none of them.
  return parts.join("\n");
}

/**
 * Pulls `input.acceptance` out of a task's input, when it is a list of words.
 *
 * Anything else is left exactly where it was: no acceptance means the input is
 * returned untouched and the brief reads byte for byte as it did before this
 * existed, and an input left with nothing in it once the list is taken out is
 * not printed as an empty `{}`.
 */
function splitAcceptance(input: AgentTask["input"]): { acceptance: string[]; rest: AgentTask["input"] | undefined } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { acceptance: [], rest: input };
  const { acceptance, ...others } = input as Record<string, unknown>;
  const items = Array.isArray(acceptance)
    ? acceptance
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/\s+/g, " ").trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  if (items.length === 0) return { acceptance: [], rest: input };
  return { acceptance: items, rest: Object.keys(others).length > 0 ? (others as AgentTask["input"]) : undefined };
}

/** Still working, or waiting on somebody — the states in which two agents can collide. */
const OPEN_STATUSES: AgentTask["status"][] = ["QUEUED", "RUNNING", "BLOCKED", "NEEDS_APPROVAL"];
const RECENTLY_ENDED_MS = 24 * 60 * 60_000;
const OTHER_WORK_LINES = 5;
const OTHER_WORK_READ = 40;

/**
 * What else is being done, or was just done, about the same record.
 *
 * Without it nothing told an agent that a colleague was already writing to
 * this lead, or had finished an hour ago, and two agents could work one
 * company at once with neither aware of the other. It is information and
 * nothing more: it never refuses, because a manager raising the same work
 * twice on purpose must still get it done twice (`checks/replayGuard.ts`).
 *
 * This task, the one that handed it over and the ones it handed on are left
 * out — the agent knows about those already. Its own *other* work on the
 * record is not, and is listed under its own name: a second copy of the same
 * job, or the letter it already wrote this morning, is the duplicate most
 * worth seeing before starting.
 *
 * A rehearsal sees only rehearsal work and real work sees none of it, for the
 * same reason a rehearsal never posts a card: it is a test, and a test is not
 * news about a customer.
 */
async function otherWorkOn(task: AgentTask): Promise<string | null> {
  const onRecord = [
    task.leadId ? { leadId: task.leadId } : null,
    task.clientId ? { clientId: task.clientId } : null,
    task.projectId ? { projectId: task.projectId } : null,
    task.proposalId ? { proposalId: task.proposalId } : null,
    task.invoiceId ? { invoiceId: task.invoiceId } : null,
  ].filter((clause) => clause !== null);
  if (onRecord.length === 0) return null;

  const now = Date.now();
  const where = {
    AND: [
      { OR: onRecord },
      { OR: [{ status: { in: OPEN_STATUSES } }, { finishedAt: { gte: new Date(now - RECENTLY_ENDED_MS) } }] },
      // Spelt with an explicit null: `parentId` is nullable, and a bare
      // "not this id" is unknown — so false — for every task with no parent.
      { OR: [{ parentId: null }, { parentId: { not: task.id } }] },
    ],
    id: { notIn: [task.id, ...(task.parentId ? [task.parentId] : [])] },
    rehearsal: task.rehearsal,
  };

  const rows = await prisma.agentTask.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: OTHER_WORK_READ,
    select: {
      title: true,
      status: true,
      summary: true,
      blockedReason: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      agent: { select: { name: true } },
    },
  });
  if (rows.length === 0) return null;
  // Counted only when the read came back full, the one case where there can be
  // more than it holds — this runs at the start of every task on a record.
  const total = rows.length < OTHER_WORK_READ ? rows.length : await prisma.agentTask.count({ where });

  // Work still in flight first, because that is the collision; then whatever
  // finished most recently.
  const open = (status: AgentTask["status"]) => (OPEN_STATUSES.includes(status) ? 0 : 1);
  const shown = [...rows].sort((a, b) => open(a.status) - open(b.status)).slice(0, OTHER_WORK_LINES);

  const lines = shown.map((row) => {
    const at = row.finishedAt ?? row.startedAt ?? row.createdAt;
    const note = (row.summary ?? row.blockedReason ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    return `- ${row.agent.name} | ${row.title.replace(/\s+/g, " ").trim()} | ${row.status} | ${ago(now - at.getTime())} | ${note || "no summary yet"}`;
  });
  if (total > shown.length) lines.push(`+${total - shown.length} more`);

  return ["OTHER WORK ON THIS RECORD (colleagues' reports, not verified):", ...lines].join("\n");
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function resolveRecords(task: AgentTask): Promise<string[]> {
  const blocks: string[] = [];

  if (task.leadId) {
    const lead = await prisma.lead.findUnique({
      where: { id: task.leadId },
      select: {
        id: true,
        contactName: true,
        contactEmail: true,
        contactPhone: true,
        companyName: true,
        website: true,
        city: true,
        category: true,
        status: true,
        leadScore: true,
        source: true,
        estimatedDealSize: true,
        discoveryNotes: true,
        discoveryCallAt: true,
        createdAt: true,
        _count: { select: { communications: true, proposals: true } },
      },
    });
    if (lead) {
      blocks.push(
        [
          `LEAD ${lead.id}`,
          `  ${lead.contactName}${lead.companyName ? ` at ${lead.companyName}` : ""} — ${lead.status}, score ${lead.leadScore}`,
          `  Email: ${lead.contactEmail ?? "none on file"} · Phone: ${lead.contactPhone ?? "none"} · Website: ${lead.website ?? "none found"}`,
          `  ${[lead.city, lead.category].filter(Boolean).join(" · ") || "no location or category"} · found via ${lead.source}`,
          `  Estimated deal size: ${money(lead.estimatedDealSize)} · ${lead._count.communications} contact(s) logged · ${lead._count.proposals} proposal(s)`,
          lead.discoveryCallAt ? `  Discovery call: ${when(lead.discoveryCallAt)}` : "",
          lead.discoveryNotes ? `  Discovery notes: ${lead.discoveryNotes.slice(0, 500)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  if (task.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: task.clientId },
      select: {
        id: true,
        name: true,
        company: true,
        email: true,
        phone: true,
        sector: true,
        lifetimeValue: true,
        firstContactAt: true,
        _count: { select: { projects: true, invoices: true, carePlans: true } },
      },
    });
    if (client) {
      blocks.push(
        [
          `CLIENT ${client.id}`,
          `  ${client.name}${client.company ? ` (${client.company})` : ""}${client.sector ? ` — ${client.sector}` : ""}`,
          `  Email: ${client.email ?? "none on file"} · Phone: ${client.phone ?? "none"}`,
          `  Lifetime value ${money(client.lifetimeValue)} · client since ${when(client.firstContactAt)}`,
          `  ${client._count.projects} project(s) · ${client._count.invoices} invoice(s) · ${client._count.carePlans} care plan(s)`,
        ].join("\n"),
      );
    }
  }

  if (task.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: task.projectId },
      select: {
        id: true,
        name: true,
        serviceType: true,
        status: true,
        scopeSummary: true,
        startDate: true,
        endDate: true,
        budgetAmount: true,
        client: { select: { name: true } },
        _count: { select: { tasks: true, milestones: true } },
      },
    });
    if (project) {
      const open = await prisma.task.count({ where: { projectId: project.id, status: { not: "DONE" } } });
      blocks.push(
        [
          `PROJECT ${project.id}`,
          `  ${project.name} for ${project.client.name} — ${project.status}, ${project.serviceType}`,
          `  Started ${when(project.startDate)} · ends ${when(project.endDate)} · budget ${money(project.budgetAmount)}`,
          `  ${project._count.milestones} milestone(s) · ${open} of ${project._count.tasks} task(s) still open`,
          `  Scope: ${project.scopeSummary.slice(0, 500)}`,
        ].join("\n"),
      );
    }
  }

  if (task.proposalId) {
    const proposal = await prisma.proposal.findUnique({
      where: { id: task.proposalId },
      select: {
        id: true,
        title: true,
        serviceType: true,
        status: true,
        priceAmount: true,
        currency: true,
        priceTier: true,
        sentAt: true,
        expiresAt: true,
        scopeSummary: true,
      },
    });
    if (proposal) {
      blocks.push(
        [
          `PROPOSAL ${proposal.id}`,
          `  ${proposal.title} — ${proposal.status}, ${proposal.serviceType}`,
          `  ${money(proposal.priceAmount, proposal.currency)}${proposal.priceTier ? ` (${proposal.priceTier})` : ""}`,
          `  Sent ${when(proposal.sentAt)} · expires ${when(proposal.expiresAt)}`,
          `  Scope: ${proposal.scopeSummary.slice(0, 400)}`,
        ].join("\n"),
      );
    }
  }

  if (task.invoiceId) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: task.invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        amountTotal: true,
        currency: true,
        issueDate: true,
        dueDate: true,
        paidAt: true,
        client: { select: { name: true } },
      },
    });
    if (invoice) {
      const overdueBy =
        invoice.status !== "PAID" && invoice.dueDate < new Date()
          ? ` — overdue by ${Math.floor((Date.now() - invoice.dueDate.getTime()) / 86_400_000)} day(s)`
          : "";
      blocks.push(
        [
          `INVOICE ${invoice.id}`,
          `  ${invoice.invoiceNumber} to ${invoice.client.name} — ${invoice.status}${overdueBy}`,
          `  ${money(invoice.amountTotal, invoice.currency)} · issued ${when(invoice.issueDate)} · due ${when(invoice.dueDate)}${invoice.paidAt ? ` · paid ${when(invoice.paidAt)}` : ""}`,
        ].join("\n"),
      );
    }
  }

  return blocks;
}
