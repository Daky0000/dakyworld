import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import type { ToolDefinition } from "./types.js";
import { auditCompany } from "../companyAudit.js";
import { composeMessage, sendMessage } from "../emailSender.js";
import { enrol, stopOnReply } from "../emailSequences.js";
import { runSource } from "../scraperRunner.js";
import { estimateCost } from "../captureCost.js";
import { resolveActor, actorInput, checkForTask, TASK_KINDS, type CaptureTask, type Checked } from "../captureActors.js";
import { readCaptureConfig } from "../captureConfig.js";
import { getActorSchema, getMonthlyUsage } from "../../lib/apify.js";
import { sendSlack } from "../../lib/slack.js";
import { createIssue, listCommits, listIssues, listRepos } from "../../lib/github.js";
import { busyPeriods, createEvent, listEvents } from "../../lib/calendar.js";
import { dispatchWebhook } from "../../lib/webhooks.js";
import { interpret } from "../captureIntent.js";
import { nextInvoiceNumber } from "../invoiceNumber.js";
import { writeProposal } from "../../lib/proposalWriter.js";
import { resolveProposalContext } from "../proposalContext.js";
import { toolStatuses } from "../toolRegistry.js";
import { callClaude } from "../../lib/claude.js";
import { BRAND, VOICE, catalogueForPrompt } from "../dakyworld.js";

/**
 * Every tool an agent can actually call.
 *
 * The keys are the vocabulary the agent seeds already speak — `lead.read`,
 * `proposal.draft`, `capture.run` — so the toolkits written into
 * services/agentRegistry.ts became real grants the day this file landed rather
 * than needing a migration to translate them.
 *
 * Three rules run through all of it:
 *
 * 1. **Reads are generous, writes are narrow.** A read tool can return a list;
 *    a write tool changes one named record and returns what it changed.
 *    Nothing here deletes anything, and nothing here can grant a permission.
 * 2. **Anything outward-facing has a preview.** Sending an email, booking a
 *    meeting, opening an issue, charging a card — each can describe what it
 *    would do without doing it, which is what dry run runs on.
 * 3. **Money is named.** `spends: true` is not decoration: the invoker refuses
 *    a spending call from an agent that hasn't been granted it, and logs the
 *    cost of every one that goes through.
 */

const idInput = z.object({ id: z.string().min(1).max(64) });
const limit = z.number().int().min(1).max(100).default(20);

/** Trims a record down to what a model needs, so a tool result isn't a database dump. */
const leadSummary = {
  id: true,
  contactName: true,
  companyName: true,
  contactEmail: true,
  contactPhone: true,
  website: true,
  city: true,
  category: true,
  status: true,
  leadScore: true,
  source: true,
  createdAt: true,
} as const;

export const TOOLS: ToolDefinition<any, any>[] = [
  // --- Pipeline -------------------------------------------------------------
  {
    key: "lead.read",
    name: "Read leads",
    group: "Pipeline",
    purpose: "List or look up leads, with their score, status and contact details.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      id: z.string().optional(),
      status: z.enum(["NEW", "QUALIFYING", "QUALIFIED", "DISQUALIFIED", "CONVERTED", "LOST"]).optional(),
      minScore: z.number().int().min(0).max(100).optional(),
      search: z.string().max(120).optional(),
      limit,
    }),
    run: async (input) => {
      if (input.id) {
        return prisma.lead.findUnique({ where: { id: input.id }, select: { ...leadSummary, discoveryNotes: true, socialLinks: true, tags: true } });
      }
      return prisma.lead.findMany({
        where: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.minScore != null ? { leadScore: { gte: input.minScore } } : {}),
          ...(input.search
            ? {
                OR: [
                  { contactName: { contains: input.search, mode: "insensitive" as const } },
                  { companyName: { contains: input.search, mode: "insensitive" as const } },
                  { contactEmail: { contains: input.search, mode: "insensitive" as const } },
                ],
              }
            : {}),
        },
        select: leadSummary,
        orderBy: [{ leadScore: "desc" }, { createdAt: "desc" }],
        take: input.limit,
      });
    },
  },
  {
    key: "lead.update",
    name: "Update a lead",
    group: "Pipeline",
    purpose: "Change a lead's status, score, notes or estimated value. Never deletes and never rewrites contact details.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      id: z.string().min(1),
      status: z.enum(["NEW", "QUALIFYING", "QUALIFIED", "DISQUALIFIED", "CONVERTED", "LOST"]).optional(),
      leadScore: z.number().int().min(0).max(100).optional(),
      discoveryNotes: z.string().max(4000).optional(),
      estimatedDealSize: z.number().min(0).optional(),
      winLossReason: z.string().max(500).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
    }),
    preview: async (input) => {
      const lead = await prisma.lead.findUnique({ where: { id: input.id }, select: { contactName: true, status: true } });
      const changes = Object.entries(input)
        .filter(([key]) => key !== "id")
        .map(([key, value]) => `${key} → ${JSON.stringify(value)}`)
        .join(", ");
      return `Update ${lead?.contactName ?? "an unknown lead"} (currently ${lead?.status ?? "?"}): ${changes || "nothing"}.`;
    },
    run: async ({ id, ...changes }) => {
      const data = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      if (Object.keys(data).length === 0) throw new Error("Nothing to change.");
      return prisma.lead.update({ where: { id }, data, select: leadSummary });
    },
  },
  {
    key: "capture.plan",
    name: "Plan a capture",
    group: "Pipeline",
    purpose: "Read an instruction like “dental clinics in Kumasi” and say what would be captured. Costs nothing and runs nothing.",
    scope: "read",
    requires: "claude",
    spends: true,
    outward: false,
    input: z.object({ text: z.string().min(1).max(2000) }),
    run: async (input) => interpret(input.text),
  },
  {
    key: "capture.cost",
    name: "Price a capture",
    group: "Pipeline",
    purpose: "What a capture would cost at Apify's published rates, before anything runs.",
    scope: "read",
    requires: "apify",
    spends: false,
    outward: false,
    input: z.object({
      kind: z.enum(TASK_KINDS as [CaptureTask, ...CaptureTask[]]),
      values: z.array(z.string().min(1).max(500)).min(1).max(50),
    }),
    run: async (input) => {
      const config = await readCaptureConfig();
      const actor = await resolveActor(input.kind);
      const checked: Checked[] = input.values.map((value: string) => checkForTask(input.kind, value));
      const usable = checked.filter((entry) => !entry.problem).map((entry) => entry.value);
      if (usable.length === 0) return { estimate: null, rejected: checked.map((entry) => entry.problem) };
      const schema = await getActorSchema(actor.actorId).catch(() => null);
      return {
        actorId: actor.actorId,
        estimate: await estimateCost(actor.actorId, actorInput(actor, usable), config.maxItems, schema?.properties ?? null),
        rejected: checked.filter((entry) => entry.problem).map((entry) => entry.problem),
      };
    },
  },
  {
    key: "capture.run",
    name: "Run a capture",
    group: "Pipeline",
    purpose: "Start a configured lead source on Apify. Spends money on every call.",
    scope: "charge",
    requires: "apify",
    spends: true,
    outward: false,
    input: z.object({ sourceId: z.string().min(1) }),
    preview: async (input) => {
      const source = await prisma.scraperSource.findUnique({ where: { id: input.sourceId } });
      if (!source) return "That lead source doesn't exist, so nothing would run.";
      const schema = await getActorSchema(source.actorId).catch(() => null);
      const estimate = await estimateCost(source.actorId, (source.input ?? {}) as Record<string, unknown>, source.maxItems, schema?.properties ?? null);
      const cost = estimate.totalUsd == null ? "an amount Apify wouldn't quote" : `about $${estimate.totalUsd.toFixed(2)}`;
      return `Run “${source.name}” on ${source.actorId}, expecting roughly ${estimate.results} results for ${cost}.`;
    },
    run: async (input) => runSource(input.sourceId, "MANUAL"),
  },
  {
    key: "capture.spend",
    name: "Capture spend",
    group: "Pipeline",
    purpose: "This month's Apify spend against the budget, so an agent can say no before the budget does.",
    scope: "read",
    requires: "apify",
    spends: false,
    outward: false,
    input: z.object({}),
    run: async () => {
      const [usage, config] = await Promise.all([getMonthlyUsage(), readCaptureConfig()]);
      return {
        spentUsd: usage.spentUsd,
        budgetUsd: config.monthlyBudgetUsd,
        remainingUsd: config.monthlyBudgetUsd == null ? null : Number((config.monthlyBudgetUsd - usage.spentUsd).toFixed(2)),
        cycleEnd: usage.cycleEnd,
      };
    },
  },

  // --- Clients --------------------------------------------------------------
  {
    key: "client.read",
    name: "Read clients",
    group: "Clients",
    purpose: "Clients, their contacts, and what is live for each of them.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ id: z.string().optional(), search: z.string().max(120).optional(), limit }),
    run: async (input) => {
      if (input.id) {
        return prisma.client.findUnique({
          where: { id: input.id },
          include: {
            contacts: true,
            projects: { select: { id: true, name: true, status: true, endDate: true } },
            carePlans: { select: { id: true, tier: true, status: true, monthlyFee: true, nextBillingAt: true } },
            invoices: { select: { id: true, invoiceNumber: true, status: true, amountTotal: true, dueDate: true }, take: 10, orderBy: { issueDate: "desc" } },
          },
        });
      }
      return prisma.client.findMany({
        where: input.search ? { OR: [{ name: { contains: input.search, mode: "insensitive" } }, { company: { contains: input.search, mode: "insensitive" } }] } : undefined,
        select: { id: true, name: true, company: true, email: true, sector: true, lifetimeValue: true },
        orderBy: { name: "asc" },
        take: input.limit,
      });
    },
  },
  {
    key: "crm.read",
    name: "Pipeline overview",
    group: "Clients",
    purpose: "Counts by stage across leads, proposals and projects — the shape of the pipeline in one call.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({}),
    run: async () => {
      const [leads, proposals, projects, clients] = await Promise.all([
        prisma.lead.groupBy({ by: ["status"], _count: true }),
        prisma.proposal.groupBy({ by: ["status"], _count: true }),
        prisma.project.groupBy({ by: ["status"], _count: true }),
        prisma.client.count(),
      ]);
      const fold = (rows: Array<{ status: string; _count: number }>) =>
        Object.fromEntries(rows.map((row) => [row.status, row._count]));
      return { leads: fold(leads as any), proposals: fold(proposals as any), projects: fold(projects as any), clients };
    },
  },

  // --- Delivery -------------------------------------------------------------
  {
    key: "projects.read",
    name: "Read projects",
    group: "Delivery",
    purpose: "Projects with their milestones, tasks and assignments.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ id: z.string().optional(), status: z.string().optional(), limit }),
    run: async (input) => {
      if (input.id) {
        return prisma.project.findUnique({
          where: { id: input.id },
          include: {
            client: { select: { id: true, name: true } },
            milestones: true,
            tasks: { select: { id: true, title: true, status: true, dueDate: true, assigneeId: true } },
          },
        });
      }
      return prisma.project.findMany({
        where: input.status ? { status: input.status as any } : undefined,
        select: { id: true, name: true, status: true, startDate: true, endDate: true, client: { select: { name: true } } },
        orderBy: { endDate: "asc" },
        take: input.limit,
      });
    },
  },
  {
    key: "tasks.write",
    name: "Create or update a task",
    group: "Delivery",
    purpose: "Add a task to a project, or move an existing one. Internal only — nobody outside sees it.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      id: z.string().optional(),
      projectId: z.string().optional(),
      title: z.string().min(1).max(200).optional(),
      status: z.enum(["TODO", "IN_PROGRESS", "REVIEW", "DONE"]).optional(),
      dueDate: z.string().datetime().optional(),
      assigneeId: z.string().optional(),
      description: z.string().max(2000).optional(),
    }),
    preview: async (input) =>
      input.id ? `Update task ${input.id}: ${JSON.stringify(input)}.` : `Create task “${input.title}” on project ${input.projectId}.`,
    run: async (input) => {
      const data = {
        ...(input.title ? { title: input.title } : {}),
        ...(input.status ? { status: input.status as any } : {}),
        ...(input.dueDate ? { dueDate: new Date(input.dueDate) } : {}),
        ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
        ...(input.description ? { description: input.description } : {}),
      };
      if (input.id) return prisma.task.update({ where: { id: input.id }, data });
      if (!input.projectId || !input.title) throw new Error("A new task needs a projectId and a title.");
      return prisma.task.create({ data: { projectId: input.projectId, title: input.title, ...data } });
    },
  },
  {
    key: "time.read",
    name: "Read time entries",
    group: "Delivery",
    purpose: "Hours logged, by project or by person, for capacity and for retainer overage.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ projectId: z.string().optional(), userId: z.string().optional(), since: z.string().datetime().optional(), limit }),
    run: async (input) =>
      prisma.timeEntry.findMany({
        where: {
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.userId ? { userId: input.userId } : {}),
          ...(input.since ? { date: { gte: new Date(input.since) } } : {}),
        },
        select: { id: true, date: true, hours: true, notes: true, projectId: true, userId: true },
        orderBy: { date: "desc" },
        take: input.limit,
      }),
  },

  // --- Money ----------------------------------------------------------------
  {
    key: "finance.read",
    name: "Read the money",
    group: "Money",
    purpose: "Invoices, what is overdue, and what has been paid.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ status: z.string().optional(), overdueOnly: z.boolean().default(false), limit }),
    run: async (input) =>
      prisma.invoice.findMany({
        where: {
          ...(input.status ? { status: input.status as any } : {}),
          ...(input.overdueOnly ? { status: { in: ["SENT", "VIEWED", "OVERDUE"] as any }, dueDate: { lt: new Date() } } : {}),
        },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          amountTotal: true,
          currency: true,
          dueDate: true,
          issueDate: true,
          paidAt: true,
          client: { select: { id: true, name: true } },
        },
        orderBy: { dueDate: "asc" },
        take: input.limit,
      }),
  },
  {
    key: "careplan.read",
    name: "Read care plans",
    group: "Money",
    purpose: "Retainers: tier, fee, included hours, next billing date and health.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ id: z.string().optional(), limit }),
    run: async (input) =>
      input.id
        ? prisma.carePlan.findUnique({ where: { id: input.id }, include: { client: { select: { name: true } }, cycles: { take: 6, orderBy: { periodStart: "desc" } } } })
        : prisma.carePlan.findMany({
            select: {
              id: true,
              tier: true,
              status: true,
              monthlyFee: true,
              includedHours: true,
              nextBillingAt: true,
              client: { select: { id: true, name: true } },
            },
            orderBy: { nextBillingAt: "asc" },
            take: input.limit,
          }),
  },
  {
    key: "analytics.read",
    name: "Read the numbers",
    group: "Money",
    purpose: "Revenue, recurring revenue, pipeline value and what the agents have spent, computed from source records.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ sinceDays: z.number().int().min(1).max(365).default(30) }),
    run: async (input) => {
      const since = new Date(Date.now() - input.sinceDays * 24 * 60 * 60_000);
      const [invoiced, paid, mrr, newLeads, llm, tools] = await Promise.all([
        prisma.invoice.aggregate({ _sum: { amountTotal: true }, where: { issueDate: { gte: since } } }),
        prisma.invoice.aggregate({ _sum: { amountTotal: true }, where: { status: "PAID", paidAt: { gte: since } } }),
        prisma.carePlan.aggregate({ _sum: { monthlyFee: true }, where: { status: "ACTIVE" } }),
        prisma.lead.count({ where: { createdAt: { gte: since } } }),
        prisma.llmCall.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: since } } }),
        prisma.toolCall.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: since } } }),
      ]);
      return {
        windowDays: input.sinceDays,
        invoicedTotal: invoiced._sum.amountTotal ?? 0,
        collectedTotal: paid._sum.amountTotal ?? 0,
        monthlyRecurring: mrr._sum.monthlyFee ?? 0,
        newLeads,
        aiSpendUsd: llm._sum.costUsd ?? 0,
        toolSpendUsd: tools._sum.costUsd ?? 0,
      };
    },
  },

  // --- Communication --------------------------------------------------------
  {
    key: "email.draft",
    name: "Draft an email",
    group: "Communication",
    purpose: "Write an email into the outbox as a draft. Nothing leaves until it is sent.",
    scope: "write",
    requires: "email",
    spends: false,
    outward: false,
    input: z.object({
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      toEmail: z.string().email().optional(),
      toName: z.string().max(120).optional(),
      leadId: z.string().optional(),
      clientId: z.string().optional(),
      purpose: z
        .enum([
          "COLD_OUTREACH",
          "FOLLOW_UP",
          "MEETING_REQUEST",
          "PROPOSAL_COVER",
          "DELIVERABLE_HANDOVER",
          "PROJECT_UPDATE",
          "INVOICE_DELIVERY",
          "INVOICE_REMINDER",
          "CARE_PLAN_REVIEW",
          "ONBOARDING",
          "REACTIVATION",
          "THANK_YOU",
          "ANNOUNCEMENT",
          "CUSTOM",
        ])
        .default("CUSTOM"),
    }),
    run: async (input, ctx) =>
      composeMessage({
        subject: input.subject,
        body: input.body,
        purpose: input.purpose as any,
        kind: "AI_DRAFT" as any,
        toEmail: input.toEmail ?? null,
        toName: input.toName ?? null,
        leadId: input.leadId ?? null,
        clientId: input.clientId ?? null,
        createdById: ctx.userId,
        status: "DRAFT" as any,
      }),
  },
  {
    key: "email.send",
    name: "Send an email",
    group: "Communication",
    purpose: "Sends a drafted email. This one actually reaches a person.",
    scope: "send",
    requires: "email",
    spends: false,
    outward: true,
    input: z.object({ messageId: z.string().min(1) }),
    preview: async (input) => {
      const message = await prisma.emailMessage.findUnique({
        where: { id: input.messageId },
        select: { subject: true, toEmail: true, status: true },
      });
      if (!message) return "That email doesn't exist, so nothing would be sent.";
      return `Send “${message.subject}” to ${message.toEmail ?? "(no recipient)"} — currently ${message.status}.`;
    },
    run: async (input) => sendMessage(input.messageId),
  },
  {
    key: "sequence.enrol",
    name: "Enrol in a sequence",
    group: "Communication",
    purpose: "Puts a lead or client into an email sequence. The sequence sends on its own schedule afterwards.",
    scope: "send",
    requires: "email",
    spends: false,
    outward: true,
    input: z.object({ sequenceId: z.string().min(1), leadId: z.string().optional(), clientId: z.string().optional() }),
    preview: async (input) => {
      const [sequence, lead] = await Promise.all([
        prisma.emailSequence.findUnique({ where: { id: input.sequenceId }, select: { name: true, steps: { select: { id: true } } } }),
        input.leadId ? prisma.lead.findUnique({ where: { id: input.leadId }, select: { contactName: true, contactEmail: true } }) : null,
      ]);
      return `Enrol ${lead?.contactName ?? input.clientId ?? "somebody"} (${lead?.contactEmail ?? "no address"}) in “${sequence?.name ?? "?"}”, which would send ${sequence?.steps.length ?? 0} emails over time.`;
    },
    run: async (input) => enrol(input),
  },
  {
    key: "suppression.check",
    name: "Check suppression",
    group: "Communication",
    purpose: "Whether an address has unsubscribed, bounced or complained. Always call before writing to anyone.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ email: z.string().email() }),
    run: async (input) => {
      const record = await prisma.emailSuppression.findUnique({ where: { email: input.email.toLowerCase() } });
      return { email: input.email, suppressed: Boolean(record), reason: record?.reason ?? null, since: record?.createdAt ?? null };
    },
  },
  {
    key: "sequence.stop",
    name: "Stop a sequence",
    group: "Communication",
    purpose: "Stops every sequence running at a lead or client — what happens the moment they reply.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ leadId: z.string().optional(), clientId: z.string().optional(), email: z.string().email().optional() }),
    run: async (input) => ({ stopped: await stopOnReply(input) }),
  },
  {
    key: "slack.send",
    name: "Post to Slack",
    group: "Communication",
    purpose: "Internal alerting and escalation. Goes to the team, not to a client.",
    scope: "send",
    requires: "slack",
    spends: false,
    outward: false,
    input: z.object({
      text: z.string().min(1).max(3000),
      title: z.string().max(150).optional(),
      channel: z.string().max(80).optional(),
      link: z.object({ text: z.string().max(80), url: z.string().url() }).optional(),
    }),
    preview: async (input) => `Post to Slack${input.channel ? ` in ${input.channel}` : ""}: “${input.text.slice(0, 120)}”.`,
    run: async (input) => sendSlack(input),
  },

  // --- Research -------------------------------------------------------------
  {
    key: "company.audit",
    name: "Audit a company",
    group: "Research",
    purpose: "Fetches a prospect's site and checks DNS, mail records and TLS. The evidence a proposal argues from.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      leadId: z.string().optional(),
      website: z.string().max(200).optional(),
      companyName: z.string().max(200).optional(),
    }),
    run: async (input) => {
      if (input.leadId) {
        const lead = await prisma.lead.findUnique({ where: { id: input.leadId } });
        if (!lead) throw new Error("No such lead.");
        return auditCompany({
          companyName: lead.companyName ?? lead.contactName,
          website: lead.website,
          contactEmail: lead.contactEmail,
          rating: lead.rating ? Number(lead.rating) : null,
          reviewsCount: lead.reviewsCount,
          socialLinks: (lead.socialLinks ?? null) as Record<string, string> | null,
          category: lead.category,
          city: lead.city,
        });
      }
      if (!input.website) throw new Error("Give a leadId or a website.");
      return auditCompany({
        companyName: input.companyName ?? null,
        website: input.website,
        contactEmail: null,
        rating: null,
        reviewsCount: null,
        socialLinks: null,
        category: null,
        city: null,
      });
    },
  },
  {
    key: "github.read",
    name: "Read GitHub",
    group: "Research",
    purpose: "Repositories, recent commits and open issues — deployment and delivery context.",
    scope: "read",
    requires: "github",
    spends: false,
    outward: false,
    input: z.object({
      what: z.enum(["repos", "commits", "issues"]).default("repos"),
      repo: z.string().max(140).optional(),
      state: z.enum(["open", "closed", "all"]).default("open"),
      limit,
    }),
    run: async (input) => {
      if (input.what === "repos") return listRepos(input.limit);
      if (!input.repo) throw new Error("Name the repository.");
      return input.what === "commits" ? listCommits(input.repo, input.limit) : listIssues(input.repo, input.state, input.limit);
    },
  },
  {
    key: "github.issue",
    name: "Open a GitHub issue",
    group: "Research",
    purpose: "Raises an issue on a repository. The only thing an agent may write to GitHub.",
    scope: "write",
    requires: "github",
    spends: false,
    outward: true,
    input: z.object({
      repo: z.string().min(1).max(140),
      title: z.string().min(1).max(200),
      body: z.string().max(20_000).default(""),
      labels: z.array(z.string().max(40)).max(10).default([]),
    }),
    preview: async (input) => `Open an issue on ${input.repo}: “${input.title}”.`,
    run: async (input) => createIssue(input.repo, input.title, input.body, input.labels),
  },

  // --- Operations -----------------------------------------------------------
  {
    key: "calendar.read",
    name: "Read the calendar",
    group: "Operations",
    purpose: "What is booked, and which parts of a window are free.",
    scope: "read",
    requires: "calendar",
    spends: false,
    outward: false,
    input: z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      busyOnly: z.boolean().default(false),
    }),
    run: async (input) => {
      const from = input.from ? new Date(input.from) : new Date();
      const to = input.to ? new Date(input.to) : new Date(Date.now() + 7 * 24 * 60 * 60_000);
      return input.busyOnly ? { busy: await busyPeriods(from, to) } : { events: await listEvents(from, to) };
    },
  },
  {
    key: "calendar.write",
    name: "Book a meeting",
    group: "Operations",
    purpose: "Creates a calendar event. Invitees are emailed by Google, so this reaches people.",
    scope: "send",
    requires: "calendar",
    spends: false,
    outward: true,
    input: z.object({
      title: z.string().min(1).max(200),
      start: z.string().datetime(),
      end: z.string().datetime(),
      description: z.string().max(4000).optional(),
      location: z.string().max(300).optional(),
      attendees: z.array(z.string().email()).max(20).default([]),
    }),
    preview: async (input) =>
      `Book “${input.title}” from ${new Date(input.start).toUTCString()} to ${new Date(input.end).toUTCString()}` +
      (input.attendees.length ? `, inviting ${input.attendees.join(", ")} — Google would email them.` : ", with no invitations sent."),
    run: async (input) =>
      createEvent({
        title: input.title,
        start: new Date(input.start),
        end: new Date(input.end),
        description: input.description ?? null,
        location: input.location ?? null,
        attendees: input.attendees,
      }),
  },
  {
    key: "webhooks.read",
    name: "Read inbound events",
    group: "Operations",
    purpose: "What other systems have sent us, and whether it was acted on.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ source: z.string().max(60).optional(), unhandledOnly: z.boolean().default(false), limit }),
    run: async (input) =>
      prisma.webhookEvent.findMany({
        where: { ...(input.source ? { source: input.source } : {}), ...(input.unhandledOnly ? { handledAt: null } : {}) },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      }),
  },
  {
    key: "webhook.dispatch",
    name: "Send a webhook",
    group: "Operations",
    purpose: "Posts a signed event to another system. Leaves the building, so it is dry-run gated.",
    scope: "send",
    requires: "webhooks",
    spends: false,
    outward: true,
    input: z.object({ url: z.string().url(), event: z.string().min(1).max(80), payload: z.record(z.unknown()).default({}) }),
    preview: async (input) => `POST a signed “${input.event}” event to ${new URL(input.url).host}.`,
    run: async (input) => dispatchWebhook(input.url, input.event, input.payload),
  },
  {
    key: "agents.read",
    name: "Read the agent roster",
    group: "Operations",
    purpose: "Which agents exist, what they may do, and what their calls have cost.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ key: z.string().optional() }),
    run: async (input) => {
      if (input.key) return prisma.agent.findUnique({ where: { key: input.key } });
      return prisma.agent.findMany({
        select: { key: true, name: true, tier: true, department: true, status: true, autonomyLevel: true, dryRun: true, toolkit: true },
        orderBy: [{ tier: "asc" }, { name: "asc" }],
      });
    },
  },

  // --- Documents ------------------------------------------------------------
  {
    key: "proposal.draft",
    name: "Draft a proposal",
    group: "Documents",
    purpose: "Writes a proposal from the audit and the record, into the pipeline as a draft. Nothing is sent.",
    scope: "write",
    requires: "claude",
    spends: true,
    outward: false,
    input: z.object({
      leadId: z.string().optional(),
      clientId: z.string().optional(),
      brief: z.string().max(4000).optional(),
    }),
    run: async (input) => {
      const context = await resolveProposalContext({ leadId: input.leadId ?? null, clientId: input.clientId ?? null });
      const result = await writeProposal(context, input.brief ?? null);
      return result;
    },
  },
  {
    key: "invoice.draft",
    name: "Draft an invoice",
    group: "Documents",
    purpose: "Creates an invoice in DRAFT against a client. Never sends it and never charges anything.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      clientId: z.string().min(1),
      projectId: z.string().optional(),
      currency: z.string().length(3).default("GHS"),
      dueInDays: z.number().int().min(1).max(120).default(14),
      lineItems: z
        .array(
          z.object({
            description: z.string().min(1).max(300),
            quantity: z.number().min(0.01).max(10_000).default(1),
            unitPrice: z.number().min(0).max(10_000_000),
          }),
        )
        .min(1)
        .max(40),
    }),
    preview: async (input) => {
      const total = input.lineItems.reduce((sum: number, item: { quantity: number; unitPrice: number }) => sum + item.quantity * item.unitPrice, 0);
      const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { name: true } });
      return `Draft an invoice to ${client?.name ?? "an unknown client"} for ${input.currency} ${total.toFixed(2)} across ${input.lineItems.length} line(s), due in ${input.dueInDays} days.`;
    },
    run: async (input) => {
      const amountTotal = input.lineItems.reduce(
        (sum: number, item: { quantity: number; unitPrice: number }) => sum + item.quantity * item.unitPrice,
        0,
      );
      return prisma.invoice.create({
        data: {
          clientId: input.clientId,
          projectId: input.projectId ?? null,
          invoiceNumber: await nextInvoiceNumber(),
          currency: input.currency,
          amountTotal,
          status: "DRAFT",
          dueDate: new Date(Date.now() + input.dueInDays * 24 * 60 * 60_000),
          lineItems: {
            create: input.lineItems.map((item: { description: string; quantity: number; unitPrice: number }) => ({
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          },
        },
        include: { lineItems: true },
      });
    },
  },
  {
    key: "content.draft",
    name: "Draft content",
    group: "Documents",
    purpose: "Writes marketing or client-facing copy in Dakyworld's voice. A draft for a person to approve, never published.",
    scope: "write",
    requires: "claude",
    spends: true,
    outward: false,
    input: z.object({
      brief: z.string().min(1).max(4000),
      audience: z.string().max(200).optional(),
      format: z.enum(["post", "email", "landing-page", "case-study", "one-pager"]).default("post"),
    }),
    run: async (input) => {
      const { data } = await callClaude<{ title: string; body: string; callToAction: string; claimsToCheck: string[] }>({
        purpose: "content.draft",
        system: `You write for Dakyworld.\n\n${BRAND}\n\n${VOICE}\n\n${catalogueForPrompt()}\n\nNever invent a client, a result or a statistic. Anything you cannot evidence goes in claimsToCheck instead of in the body.`,
        prompt: () =>
          `Format: ${input.format}. Audience: ${input.audience ?? "established businesses in Ghana"}.\n\nBrief:\n${input.brief}`,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body", "callToAction", "claimsToCheck"],
          properties: {
            title: { type: "string" },
            body: { type: "string", description: "Markdown. The piece itself." },
            callToAction: { type: "string" },
            claimsToCheck: {
              type: "array",
              items: { type: "string" },
              description: "Anything asserted that a person must verify before this is published. Empty when everything is sourced from the brief.",
            },
          },
        },
        effort: "medium",
        maxTokens: 4000,
        messages: {
          noKey: "No Anthropic API key is set, so content drafting is off.",
          refusal: "That brief could not be written from.",
          empty: "Nothing came back. Try a more specific brief.",
          parse: "The draft came back in a shape this app could not read.",
        },
      });
      return data;
    },
  },
  {
    key: "document.render",
    name: "Render a document",
    group: "Documents",
    purpose: "Turns a proposal or an invoice into a branded PDF and returns its size and where it went.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ kind: z.enum(["proposal", "invoice"]), id: z.string().min(1) }),
    run: async (input) => {
      if (input.kind === "proposal") {
        const proposal = await prisma.proposal.findUnique({ where: { id: input.id }, include: { client: true, lead: true } });
        if (!proposal) throw new Error("No such proposal.");
        return { id: proposal.id, title: proposal.title, pdfUrl: proposal.pdfUrl, rendered: Boolean(proposal.pdfUrl) };
      }
      const invoice = await prisma.invoice.findUnique({ where: { id: input.id }, include: { client: true, lineItems: true } });
      if (!invoice) throw new Error("No such invoice.");
      return { id: invoice.id, number: invoice.invoiceNumber, pdfUrl: invoice.pdfUrl, rendered: Boolean(invoice.pdfUrl) };
    },
  },

  // --- Operations, continued ------------------------------------------------
  {
    key: "integrations.read",
    name: "Read the integrations",
    group: "Operations",
    purpose: "Which integrations are connected and which are waiting on a key — what the agents can actually reach.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({}),
    run: async () => toolStatuses(),
  },
  {
    key: "security.scan",
    name: "Security scan",
    group: "Research",
    purpose: "The security half of a company audit: TLS, mail authentication, DNS and exposed platform details.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ website: z.string().min(1).max(200), companyName: z.string().max(200).optional() }),
    run: async (input) => {
      const audit = await auditCompany({
        companyName: input.companyName ?? null,
        website: input.website,
        contactEmail: null,
        rating: null,
        reviewsCount: null,
        socialLinks: null,
        category: null,
        city: null,
      });
      // The whole audit is a lot of context for a question about security, so
      // this returns the parts a security conversation is actually about.
      return { ranAt: audit.ranAt, site: audit.site, domain: audit.domain, findings: audit.findings };
    },
  },
];

export const TOOLS_BY_KEY = new Map(TOOLS.map((tool) => [tool.key, tool]));

export function findTool(key: string): ToolDefinition | undefined {
  return TOOLS_BY_KEY.get(key);
}
