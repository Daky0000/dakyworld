import type { AgentTask } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { subjectOf } from "./memory.js";
import { dossierForPrompt } from "../context/dossier.js";

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

  const records = await resolveRecords(task);
  if (records.length > 0) {
    parts.push("", "WHAT THIS IS ABOUT — the current state of the record. Anything not here, fetch with a tool rather than assume:", ...records);
  }

  // The record says where this stands. The dossier says how it got there, and
  // without it an agent writes as though nobody here has spoken to this company
  // before — which, three letters in, is the thing the reader notices.
  //
  // Kept short on purpose: this is paid for on every task whether it turns out
  // to matter or not, so it is the headlines and a sentence saying the rest is
  // one `context.read` away.
  const dossier = await dossierForPrompt(taskSubjects(task));
  if (dossier) parts.push("", dossier);

  if (task.input && typeof task.input === "object") {
    parts.push("", `Additional context supplied with the task:\n${JSON.stringify(task.input, null, 1).slice(0, 3000)}`);
  }

  parts.push(
    "",
    "Work the task. Use your tools to establish what is true before you conclude anything. When you are finished, say what you did, what you found, and what a person should do next.",
  );

  return parts.join("\n");
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
