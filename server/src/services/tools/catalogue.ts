import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { PROSE_CRAFT } from "../craft.js";
import { raisePayment, settleFromProvider } from "../payments.js";
import { defaultCallingCode, displayPhone, smsCost, toE164, waLink } from "../../lib/phone.js";
import { draftMessage } from "../../lib/messageDrafter.js";
import { resolveContext } from "../emailContext.js";
import { agentBranchName, commitFiles, createBranch, createRepo, getPullRequest, listTree, mergePullRequest, openPullRequest, readFile } from "../../lib/github.js";
import type { ToolDefinition } from "./types.js";
import { auditCompany } from "../companyAudit.js";
import { isStale, prepareLead, prepareLeads, storedPrep } from "../leadPrep.js";
import { lookAtHomepage } from "../homepageLook.js";
import { runWebsiteAudit } from "../audit/team.js";
import { DISCIPLINE_NAMES } from "../audit/types.js";
import { normaliseSiteUrl } from "../siteShot.js";
import { polishEmail } from "../../lib/emailPolish.js";
import { buildDemo, demoUrl, subjectFromLead } from "../demoBuilder.js";
import { appUrl } from "../emailSender.js";
import { composeMessage, sendMessage } from "../emailSender.js";
import {
  composeMessage as composePhoneMessage,
  leadReachability,
  reachabilityOf,
  resolveThread,
  sendPhoneMessage,
  windowOpen,
  windowRemainingMinutes,
} from "../messageSender.js";
import { enrol, stopOnReply } from "../emailSequences.js";
import { handOverMessage, inboxSummary, markHandled } from "../mailbox/actions.js";
import { NEEDS_NO_REPLY } from "../mailbox/router.js";
import { imapConfigured } from "../../lib/imap.js";
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
import { callModel, generateImage } from "../../lib/models/call.js";
import { PROVIDERS, routeFor } from "../../lib/models/registry.js";
import { BRAND, VOICE, catalogueForPrompt } from "../dakyworld.js";
import { writerSystem } from "../writers/brief.js";
import { allMcpTools, callOn, imageProvider, mcpTools } from "./mcpTools.js";
import { companyProfile } from "../systemProfile.js";
// Circular with services/agents/hiring.ts, which imports listAllTools from
// here. Safe because every reference in both directions is inside a function
// body rather than at module scope — see the note at the top of hiring.ts.
import { closeGap, findOverlaps, hirePolicy, openGaps, proposeHire, searchRoster } from "../agents/hiring.js";

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

/**
 * An aspect ratio in the words an agent uses, as the size ChatGPT takes.
 *
 * Anything unrecognised comes back square rather than being passed through: an
 * invalid size is a 400 from the vendor after the prompt was built, and a
 * square picture is a picture.
 */
function sizeFor(aspectRatio?: string): string {
  switch ((aspectRatio ?? "1:1").trim()) {
    case "16:9":
    case "3:2":
    case "landscape":
      return "1536x1024";
    case "9:16":
    case "2:3":
    case "portrait":
      return "1024x1536";
    default:
      return "1024x1024";
  }
}

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

/**
 * The shipped doctrine for `content.draft`, overridable by `content.writer`.
 *
 * Same rule as every other writer in this system: the judgement is the
 * agent's once somebody has edited it, the shape of the answer is not. See
 * `services/writers/brief.ts`.
 */
export const CONTENT_DRAFT_DOCTRINE = `You write for Dakyworld.

${VOICE}

How a piece earns its place:

1. **Say the useful thing first.** A reader decides in one line whether to keep going. No throat-clearing, no "in today's digital landscape", no paragraph explaining why the topic matters before saying anything about it.
2. **One piece, one job.** Know what the reader should be able to do at the end that they could not do at the start, and cut everything that does not serve it.
3. **Concrete beats comprehensive.** One worked example a reader recognises is worth five bullet points covering the field. If you are listing, ask whether the list is doing work or hiding the fact that nothing specific is being said.
4. **Write to somebody who is busy and not technical.** Explain the thing before naming it, and where the name adds nothing, leave it out.
5. **No pitch unless the brief asks for one.** A piece that turns into an advertisement in its last paragraph loses the reader it just earned.

${PROSE_CRAFT}`;

/**
 * The invention rule is contract, not doctrine.
 *
 * `claimsToCheck` is a field a person reads before anything ships, so the
 * instruction that fills it has to survive a rewritten voice — a doctrine edit
 * that dropped it would leave unsourced statistics sitting in the body with an
 * empty list beside them saying everything had been checked.
 */
const CONTENT_DRAFT_CONTRACT = `**Never invent a client, a result, a statistic or a proportion.** Not "most businesses", not "studies show", not "8 in 10". You have no such figure. Say what happens to *a* person doing *a* thing and let the reader supply the scale.

Anything you cannot evidence goes in \`claimsToCheck\` rather than in the body. That field existing is not permission to be vague in the body — it is where a claim goes to be checked before it ships.

Return the body as Markdown.`;

/** The shipped doctrine for `content.plain`, overridable by `content.writer`. */
export const CONTENT_PLAIN_DOCTRINE = `You rewrite business writing so a busy person understands it on one reading.

${VOICE}

What you change:
- Consultant vocabulary, and any sentence that could be said in half the words.
- The passive voice, where the doer matters.
- Jargon a reader outside the trade would stumble on — either explain it in the sentence or cut it.
- Sentences carrying three ideas. One idea each.
- Anything that reads as though a machine wrote it: throat-clearing openings, "it's not just X, it's Y", "in today's fast-paced world", a dash in every sentence, and closing paragraphs that restate the opening.

${PROSE_CRAFT}`;

/**
 * What an editor may never do, and where the cuts are declared.
 *
 * This is contract rather than doctrine for the same reason the email polish's
 * is: this stage is the *last* writer, so whatever it is told becomes the
 * house style. An edit that loosened "never change a figure" would not change
 * the register — it would let a rewrite quietly alter a price.
 */
const CONTENT_PLAIN_CONTRACT = `What you never change:
- A fact, a figure, a date, a name, a price or a promise. If a number is in the draft it is in your rewrite, unaltered.
- The meaning. A shorter piece that says something different is a failure, not an edit.
- A claim you think is wrong — that is somebody else's job. Say so in \`changes\` and leave the sentence alone.

British spelling. No exclamation marks. Nothing you cut goes unmentioned: anything you dropped goes in \`removed\` so a person can put it back.`;

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
    key: "lead.prepare",
    name: "Look at a business",
    group: "Pipeline",
    purpose:
      "Researches a lead from live sources, fills the blanks their scrape left, checks their site and mail domain, and photographs their homepage. What an email has to be written from.",
    scope: "write",
    requires: "models",
    job: "research",
    // Live search is billed per request as well as per token, and the
    // screenshot is an Apify run. Both are small; neither is free.
    spends: true,
    outward: false,
    input: z.object({
      leadId: z.string().min(1),
      skipResearch: z.boolean().default(false).describe("Skip the live-source pass, for a record that is already complete."),
      skipLook: z.boolean().default(false).describe("Skip the screenshot and the model that reads it."),
      force: z.boolean().default(false).describe("Look again even though the last look is still fresh."),
    }),
    preview: async (input) => {
      const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, select: { contactName: true, companyName: true, website: true } });
      const who = lead?.companyName ?? lead?.contactName ?? "an unknown lead";
      return `Research ${who} against live sources, fill any blank fields, check ${lead?.website ?? "their domain"}${
        lead?.website && !input.skipLook ? ", and photograph their homepage and read it" : ""
      }. Nothing on the record would be overwritten.`;
    },
    run: async (input) => {
      if (!input.force) {
        const stored = await storedPrep(input.leadId);
        // Re-running a fresh look costs money and produces the same answer.
        if (stored && !isStale(stored.ranAt)) {
          return { reused: true, ranAt: stored.ranAt, facts: stored.facts, notes: stored.notes };
        }
      }
      const prep = await prepareLead(input.leadId, { skipResearch: input.skipResearch, skipLook: input.skipLook });
      return {
        reused: false,
        ranAt: prep.ranAt,
        filled: prep.filled,
        proposedContact: prep.proposedContact,
        look: prep.look,
        facts: prep.facts,
        notes: prep.notes,
        costUsd: prep.costUsd,
      };
    },
  },
  {
    key: "lead.prepareMany",
    name: "Look at a list of businesses",
    group: "Pipeline",
    purpose:
      "The same as looking at one business, for many at once — and the only efficient way to do it, because the screenshots go into as few Apify runs as possible.",
    scope: "write",
    requires: "models",
    job: "research",
    spends: true,
    outward: false,
    input: z.object({
      leadIds: z.array(z.string().min(1)).min(1).max(50),
      skipLook: z.boolean().default(false).describe("Skip the screenshots and the model that reads them."),
      skipFresh: z.boolean().default(true).describe("Leave alone anything already looked at recently."),
    }),
    preview: async (input) => {
      const leads = await prisma.lead.findMany({ where: { id: { in: input.leadIds } }, select: { website: true } });
      const sites = leads.filter((lead) => lead.website).length;
      const runs = input.skipLook ? 0 : Math.ceil(sites / 20);
      return `Research ${leads.length} business(es) against live sources, check their sites, and photograph ${sites} homepage(s) in ${runs} Apify run(s) rather than ${sites}. Nothing on any record would be overwritten.`;
    },
    run: async (input) => {
      let ids: string[] = input.leadIds;
      if (input.skipFresh) {
        const fresh = await prisma.leadResearch.findMany({
          where: { leadId: { in: ids }, ranAt: { gt: new Date(Date.now() - 30 * 86_400_000) } },
          select: { leadId: true },
        });
        const skip = new Set(fresh.map((row) => row.leadId));
        ids = ids.filter((id) => !skip.has(id));
      }
      if (ids.length === 0) return { prepared: 0, skipped: input.leadIds.length, note: "Every one of these was looked at recently." };

      const result = await prepareLeads(ids, { skipLook: input.skipLook });
      return {
        prepared: result.prepared.length,
        skipped: input.leadIds.length - ids.length,
        failed: result.failed,
        screenshotRuns: result.screenshotRuns,
        screenshotsTaken: result.screenshotsTaken,
        costUsd: result.costUsd,
        // The saving, stated, so an agent reporting back can say it.
        note: `${result.screenshotsTaken} screenshot(s) in ${result.screenshotRuns} run(s).`,
      };
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
  // --- The mailbox, read rather than written to -----------------------------
  //
  // Every tool above this point writes *out*. These three are how an agent
  // reaches what arrived: what is in the mailbox, who a message belongs to,
  // and saying it has been dealt with. None of them touches the mail server —
  // they read rows that `services/mailbox/` already filed, so an agent can
  // still work the backlog while the connection is down.
  {
    key: "inbox.read",
    name: "Read the inbox",
    group: "Communication",
    purpose:
      "What has arrived: one message in full, a whole conversation, or everything nobody has dealt with yet. Read this before answering anybody — it is the only place a reply they sent actually is.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      messageId: z.string().optional(),
      threadId: z.string().optional(),
      /** Blank returns what is still open, which is the question actually being asked. */
      status: z.enum(["NEW", "TRIAGED", "ROUTED", "HANDLED", "IGNORED", "FAILED"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    run: async (input) => {
      if (input.messageId) {
        const message = await prisma.mailMessage.findUnique({
          where: { id: input.messageId },
          include: { thread: { select: { subject: true, counterpartEmail: true, messageCount: true } } },
        });
        if (!message) return { found: false, message: null };
        return { found: true, message: { ...inboxSummary(message), body: message.bodyText, thread: message.thread } };
      }

      if (input.threadId) {
        const messages = await prisma.mailMessage.findMany({
          where: { threadId: input.threadId },
          orderBy: { sentAt: "asc" },
          take: input.limit,
        });
        return {
          threadId: input.threadId,
          messages: messages.map((message) => ({ ...inboxSummary(message), body: message.bodyText.slice(0, 2_000) })),
        };
      }

      const messages = await prisma.mailMessage.findMany({
        where: {
          direction: "INBOUND",
          // The same definition of "open" the Inbox screen uses. An agent
          // asked what is outstanding must not be handed the newsletters.
          ...(input.status
            ? { triage: input.status }
            : { handledAt: null, triage: { not: "IGNORED" as const }, OR: [{ intent: null }, { intent: { notIn: NEEDS_NO_REPLY } }] }),
        },
        orderBy: { receivedAt: "desc" },
        take: input.limit,
      });
      const connected = await imapConfigured();
      return {
        mailboxConnected: connected,
        // Said out loud rather than returning a quietly short list: an agent
        // told "nothing has arrived" when nothing is connected will conclude
        // the business has no post.
        note: connected ? null : "No mailbox is connected for reading, so this is only what was read before. Settings → Email.",
        messages: messages.map(inboxSummary),
      };
    },
  },
  {
    key: "inbox.route",
    name: "Hand a message to somebody",
    group: "Communication",
    purpose:
      "Give one message to the agent whose job it is, with a sentence saying why. Search the roster with findAgent first — handing work to the wrong colleague is worse than leaving it for a person.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      messageId: z.string().min(1),
      agentKey: z.string().min(1),
      why: z.string().min(10).max(500),
    }),
    run: async (input, ctx) => handOverMessage({ ...input, by: ctx.agentKey ?? undefined }),
  },
  {
    key: "inbox.handled",
    name: "Close a message",
    group: "Communication",
    purpose:
      "Say a message has been dealt with, and how. A message nobody closes stays on the Inbox screen for ever, which is deliberate — that screen is the list of what is still owed a reply.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      messageId: z.string().min(1),
      note: z.string().min(3).max(500),
      /** Ignored means deliberately not acted on — a newsletter, a receipt, junk. */
      ignored: z.boolean().default(false),
    }),
    run: async (input) => markHandled(input),
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
    key: "site.look",
    name: "Look at a homepage",
    group: "Research",
    purpose:
      "Photographs a homepage and says what a first-time visitor actually sees — the half of a site review that reading the markup cannot answer.",
    scope: "read",
    // The screenshot is an Apify run; without a token there is no picture and
    // nothing to look at, so that is the gate even though a model reads it.
    requires: "apify",
    job: "vision",
    spends: true,
    outward: false,
    input: z.object({
      website: z.string().min(1).max(200),
      companyName: z.string().max(200).optional(),
    }),
    preview: async (input) => `Open ${input.website} in a browser, photograph the top of the homepage, and have a model describe what is there.`,
    run: async (input) => {
      const result = await lookAtHomepage({ website: input.website, companyName: input.companyName ?? null, audit: null });
      return { look: result.look, shot: result.shot, notes: result.notes };
    },
  },
  {
    key: "audit.website",
    name: "Run the website audit team",
    group: "Research",
    purpose:
      "Four reviewers over one site — UI/UX, speed and findability, content, security — compiled into one report, with the findings drawn onto a screenshot of the homepage. Produces a branded PDF and a Markdown copy.",
    scope: "write",
    // Two screenshots through Apify and three model calls, so both gates
    // apply. Declaring only one of them would let a run start with half of
    // what it needs and produce a report full of "could not be checked".
    requires: "apify",
    job: "vision",
    spends: true,
    // Nothing is sent anywhere and nothing is published — the report is a row
    // in this database with two files beside it.
    outward: false,
    input: z.object({
      leadId: z.string().optional().describe("The lead whose website to review."),
      website: z.string().max(300).optional().describe("A web address, when there is no lead behind it."),
      businessName: z.string().max(200).optional(),
    }),
    preview: async (input) => {
      const who = input.leadId
        ? ((await prisma.lead.findUnique({ where: { id: input.leadId }, select: { companyName: true, contactName: true, website: true } })) ?? null)
        : null;
      const site = input.website ?? who?.website ?? "their site";
      return `Photograph ${site} on a desktop and a phone, then have the ${Object.values(DISCIPLINE_NAMES).join(", ")} reviewers each go over it, compile the four into one report, and file a PDF and a Markdown copy.`;
    },
    run: async (input) => {
      let subject: Parameters<typeof runWebsiteAudit>[0];

      if (input.leadId) {
        const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, include: { research: true } });
        if (!lead) throw new Error("No such lead.");
        const website = normaliseSiteUrl(input.website ?? lead.website ?? "");
        if (!website) {
          // The same refusal the route makes, for the same reason: a review of
          // a business with no website is four sections saying there was
          // nothing to check, rendered as a PDF.
          throw new Error(
            "There is no website on this lead to review. For a business with no site at all the absence is the argument — build them a demo page instead.",
          );
        }
        const look = (lead.research?.look ?? null) as { states?: { trade?: string | null; town?: string | null } } | null;
        subject = {
          leadId: lead.id,
          businessName: lead.companyName ?? lead.contactName,
          website,
          trade: look?.states?.trade ?? lead.category,
          town: look?.states?.town ?? lead.city,
        };
      } else {
        const website = normaliseSiteUrl(input.website ?? "");
        if (!website) throw new Error("Give a leadId or a website this can open.");
        subject = {
          leadId: null,
          businessName: input.businessName?.trim() || new URL(website).hostname.replace(/^www\./, ""),
          website,
          trade: null,
          town: null,
        };
      }

      const run = await runWebsiteAudit(subject);
      // Not the whole report: it is tens of kilobytes and it would go into the
      // agent's context in full, on every turn after this one. What comes back
      // is the shape of it plus the ids to fetch the rest with.
      return {
        auditId: run.auditId,
        businessName: run.report.businessName,
        website: run.report.website,
        // Null rather than a number an agent would quote in a letter: an
        // unscored review is one where too little of the site could be
        // examined, and its arithmetic is not a smaller version of the truth.
        overallScore: run.report.scored ? run.report.overallScore : null,
        verdict: run.report.verdict,
        sections: run.report.disciplines.map((discipline) => ({
          section: DISCIPLINE_NAMES[discipline.discipline],
          reviewer: discipline.reviewer,
          score: discipline.scored ? discipline.score : null,
          headline: discipline.headline,
          findings: discipline.findings.length,
        })),
        theOneThing: run.report.synthesis?.theOneThing ?? null,
        pdfFileId: run.pdfFileId,
        markdownFileId: run.markdownFileId,
        couldNotCheck: run.report.notes,
        costUsd: run.report.costUsd,
      };
    },
  },
  {
    key: "audit.read",
    name: "Read a website review",
    group: "Research",
    purpose: "What the audit team found on a site, as the Markdown report — the evidence an email or a proposal argues from.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      auditId: z.string().optional(),
      leadId: z.string().optional().describe("The most recent review of this lead's site."),
      full: z.boolean().default(false).describe("The whole report rather than the summary and the email brief."),
    }),
    run: async (input) => {
      const audit = input.auditId
        ? await prisma.websiteAudit.findUnique({ where: { id: input.auditId } })
        : input.leadId
          ? await prisma.websiteAudit.findFirst({ where: { leadId: input.leadId }, orderBy: { ranAt: "desc" } })
          : null;
      if (!audit) throw new Error("No review found. Run audit.website first, or give an auditId.");

      const report = audit.report as unknown as {
        scored?: boolean;
        disciplines: { discipline: keyof typeof DISCIPLINE_NAMES; reviewer: string; score: number; scored: boolean; headline: string; summary: string }[];
        synthesis: { executiveSummary: string; theOneThing: string; emailBrief: unknown } | null;
        notes: string[];
      };

      // Same rule as the PDF and the screen: the stored column holds the
      // arithmetic, and it is only a score when enough of the site was
      // examined for one. Rows predating the gate keep the older rule.
      const scored = report.scored ?? (report.disciplines ?? []).some((discipline) => discipline.scored);

      // The full Markdown is several thousand words. Handing it over by
      // default would fill an agent's context with a document it mostly does
      // not need — the summary and the brief are what a letter is written
      // from, and `full` is there for the times that is not enough.
      if (input.full) return { auditId: audit.id, ranAt: audit.ranAt, markdown: audit.markdown };

      return {
        auditId: audit.id,
        businessName: audit.businessName,
        website: audit.website,
        ranAt: audit.ranAt,
        overallScore: scored ? audit.overallScore : null,
        verdict: audit.verdict,
        sections: report.disciplines?.map((discipline) => ({
          section: DISCIPLINE_NAMES[discipline.discipline],
          reviewer: discipline.reviewer,
          score: discipline.scored ? discipline.score : null,
          headline: discipline.headline,
          summary: discipline.summary,
        })),
        executiveSummary: report.synthesis?.executiveSummary ?? null,
        theOneThing: report.synthesis?.theOneThing ?? null,
        emailBrief: report.synthesis?.emailBrief ?? null,
        // Handed over with the findings rather than left for somebody to ask
        // about: a writer who does not know what was skipped will state the
        // gap as a fault.
        couldNotCheck: report.notes ?? [],
      };
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
  // --- Getting paid ---------------------------------------------------------
  //
  // Two rails because Ghana has two answers, and the agent picks per client.
  // Stripe acquires in neither, which is why every invoice this system has
  // produced so far printed with no way to settle it.
  //
  // All three of these are `outward` — a payment request arrives in front of a
  // client under Dakyworld's name — so an agent below autonomy 3 prepares one
  // and it waits in the approval queue with its reasoning attached.
  {
    key: "payment.link",
    name: "Raise a payment link",
    group: "Money",
    purpose:
      "Opens a Paystack payment page for an invoice and puts the link on the record. The client can pay by card, mobile money or bank transfer. Use this when they are comfortable paying on the web, or when you are putting a link in an email.",
    scope: "send",
    requires: "paystack",
    spends: false,
    outward: true,
    input: z.object({ invoiceId: z.string().min(1) }),
    preview: async (input) => {
      const invoice = await prisma.invoice.findUnique({
        where: { id: input.invoiceId },
        select: { invoiceNumber: true, amountTotal: true, currency: true, status: true, client: { select: { name: true, email: true } } },
      });
      if (!invoice) return `There is no invoice with the id ${input.invoiceId}.`;
      if (invoice.status === "PAID") return `${invoice.invoiceNumber} has already been paid, so no link would be raised.`;
      return `Open a Paystack payment page for ${invoice.invoiceNumber} — ${invoice.currency} ${Number(invoice.amountTotal.toString()).toLocaleString("en-GB")} from ${invoice.client.name} (${invoice.client.email ?? "no email on file"}) — and put the link on the invoice.`;
    },
    run: async (input) => raisePayment(input.invoiceId, "paystack"),
  },
  {
    key: "payment.momo",
    name: "Request mobile money",
    group: "Money",
    purpose:
      "Opens a Hubtel checkout for an invoice, so the client can pay from the phone they already have open. Use this where a hosted web page is the wrong ask — which for a great many small businesses here it is.",
    scope: "charge",
    requires: "hubtel",
    // Not marked `spends` — this collects money rather than spending it, and
    // the flag drives the autonomy-4 gate, which exists to stop an agent
    // running up a bill. Requesting payment is `outward`, which is the gate
    // that actually applies to it.
    spends: false,
    outward: true,
    input: z.object({ invoiceId: z.string().min(1) }),
    preview: async (input) => {
      const invoice = await prisma.invoice.findUnique({
        where: { id: input.invoiceId },
        select: { invoiceNumber: true, amountTotal: true, currency: true, status: true, client: { select: { name: true, phone: true } } },
      });
      if (!invoice) return `There is no invoice with the id ${input.invoiceId}.`;
      if (invoice.status === "PAID") return `${invoice.invoiceNumber} has already been paid, so nothing would be requested.`;
      return `Ask ${invoice.client.name} (${invoice.client.phone ?? "no phone on file"}) for ${invoice.currency} ${Number(invoice.amountTotal.toString()).toLocaleString("en-GB")} against ${invoice.invoiceNumber}, through Hubtel mobile money.`;
    },
    run: async (input) => raisePayment(input.invoiceId, "hubtel"),
  },
  {
    key: "payment.status",
    name: "Check a payment",
    group: "Money",
    purpose:
      "Asks the provider directly whether an invoice has been paid, and marks it paid if it has. Reading only — it never asks anybody for money.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ invoiceId: z.string().min(1) }),
    run: async (input) => {
      const invoice = await prisma.invoice.findUnique({
        where: { id: input.invoiceId },
        select: { invoiceNumber: true, status: true, paidAt: true, paidVia: true, paymentProvider: true, paymentRef: true, paymentUrl: true },
      });
      if (!invoice) return { found: false };
      if (!invoice.paymentRef) {
        return { found: true, invoiceNumber: invoice.invoiceNumber, status: invoice.status, raised: false, note: "No payment has been raised for this invoice yet." };
      }
      // Asks the provider rather than trusting the row, because the row is only
      // as fresh as the last webhook that arrived.
      const settled = await settleFromProvider(invoice.paymentRef);
      return {
        found: true,
        invoiceNumber: invoice.invoiceNumber,
        raised: true,
        provider: invoice.paymentProvider,
        paymentUrl: invoice.paymentUrl,
        status: settled?.invoice.status ?? invoice.status,
        paidAt: settled?.invoice.paidAt ?? invoice.paidAt,
        paidVia: settled?.invoice.paidVia ?? invoice.paidVia,
        justSettled: settled?.changed ?? false,
      };
    },
  },
  // --- The phone channels ---------------------------------------------------
  //
  // Most of a scraped list has a number and no email, so for the largest group
  // of leads in the database these are the only tools that can reach anybody
  // at all. Four rules run through them and are worth reading once:
  //
  //  - **Nothing here calls a provider directly.** Every send goes through
  //    services/messageSender.ts, which is where the opt-out list is checked,
  //    the thread is written and the contact is logged on the lead. A tool
  //    that called Meta or Hubtel itself would send messages the outbox has
  //    never heard of, which is the same as no outbox.
  //  - **WhatsApp and SMS are separate grants** because they are separate
  //    accounts with separate costs. An agent trusted to text an invoice
  //    reminder is not thereby trusted to start WhatsApp conversations.
  //  - **`whatsapp.link` is not outward** — it prepares a message and a person
  //    presses send. That is the difference between a draft and an act, and it
  //    is why this one is the tool an agent on a low autonomy level can still
  //    usefully hold.
  //  - **The previews say what the message will cost and whether it can go at
  //    all.** On this channel the second question has a real answer: outside
  //    the 24-hour window WhatsApp carries only an approved template.
  {
    key: "message.reach",
    name: "How to reach somebody",
    group: "Communication",
    purpose:
      "Says which channel a lead can actually be reached on — email, WhatsApp, a text — and why. Reading only. Ask this before writing anything, because it is the difference between an email nobody can receive and a message that lands.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      leadId: z.string().cuid().optional(),
      email: z.string().max(200).optional(),
      phone: z.string().max(24).optional().describe("Any usual form — 024…, +233…"),
    }),
    run: async (input) => {
      const reach = input.leadId ? await leadReachability(input.leadId) : await reachabilityOf({ email: input.email, phone: input.phone });
      return {
        channel: reach.channel,
        why: reach.why,
        email: reach.email,
        phone: reach.phone ? { number: reach.phone.display, mobile: reach.phone.mobile, country: reach.phone.country } : null,
      };
    },
  },
  {
    key: "message.draft",
    name: "Draft a WhatsApp or a text",
    group: "Communication",
    purpose:
      "Writes a short message for a phone, from what is on the record. Returns the words and never sends them. Forty words on WhatsApp, fewer by text — a message on somebody's phone is not a shorter email.",
    scope: "write",
    requires: "models",
    job: "text",
    spends: true,
    outward: false,
    input: z.object({
      channel: z.enum(["WHATSAPP", "SMS"]),
      leadId: z.string().cuid().optional(),
      clientId: z.string().cuid().optional(),
      toPhone: z.string().max(24).optional(),
      toName: z.string().max(120).optional(),
      purpose: z
        .enum(["COLD_OUTREACH", "FOLLOW_UP", "MEETING_REQUEST", "DEMO_READY", "INVOICE_DELIVERY", "INVOICE_REMINDER", "PROJECT_UPDATE", "THANK_YOU", "ONBOARDING", "REACTIVATION", "CUSTOM"])
        .default("COLD_OUTREACH"),
      brief: z.string().max(1200).optional().describe("What this message is for, in your words."),
    }),
    run: async (input) => {
      const context = await resolveMessageContext(input);
      const draft = await draftMessage({
        channel: input.channel,
        purpose: input.purpose,
        context,
        brief: input.brief ?? null,
      });
      return {
        body: draft.body,
        rationale: draft.rationale,
        confidence: draft.confidence,
        writtenBy: draft.model,
        words: draft.body.trim().split(/\s+/).length,
        cost: draft.cost ?? null,
      };
    },
  },
  {
    key: "whatsapp.send",
    name: "Send a WhatsApp message",
    group: "Communication",
    purpose:
      "Sends one WhatsApp message. Inside 24 hours of their last reply it carries what you wrote; outside it, only a template Meta approved in advance — name one, or use whatsapp.link instead and let a person send it.",
    scope: "send",
    requires: "whatsapp",
    spends: true,
    outward: true,
    input: z.object({
      leadId: z.string().cuid().optional(),
      clientId: z.string().cuid().optional(),
      to: z.string().max(24).optional().describe("Only needed when there is no lead or client to take the number from."),
      message: z.string().max(1000).optional().describe("Free text. Only delivered inside the 24-hour window."),
      template: z.string().max(120).optional().describe("An approved template name. Required outside the window — see whatsapp.templates."),
      variables: z.array(z.string().max(400)).max(10).optional().describe("Values for the template's {{1}}, {{2}} … in order."),
      purpose: z
        .enum(["COLD_OUTREACH", "FOLLOW_UP", "MEETING_REQUEST", "DEMO_READY", "INVOICE_DELIVERY", "INVOICE_REMINDER", "PROJECT_UPDATE", "THANK_YOU", "ONBOARDING", "REACTIVATION", "CUSTOM"])
        .default("CUSTOM"),
    }),
    preview: async (input) => describeSend("WHATSAPP", input),
    run: async (input) => {
      const message = await composePhoneMessage({
        channel: "WHATSAPP",
        purpose: input.purpose,
        kind: input.template ? "TEMPLATE" : "AUTOMATION",
        body: input.message ?? null,
        templateName: input.template ?? null,
        templateVariables: input.variables ?? [],
        toPhone: input.to ?? null,
        leadId: input.leadId ?? null,
        clientId: input.clientId ?? null,
      });
      const result = await sendPhoneMessage(message.id);
      if (!result.sent) throw new Error(result.reason ?? "The message was not sent.");
      return { messageId: message.id, to: displayPhone(message.toPhone), providerMessageId: result.providerMessageId ?? null };
    },
  },
  {
    key: "whatsapp.link",
    name: "Prepare a WhatsApp message to send by hand",
    group: "Communication",
    purpose:
      "Writes the message and returns a wa.me link a person opens and sends from their own WhatsApp. No template approval, no fee, and it arrives from a human being rather than a brand — which is what a small business here actually replies to. Nothing is sent by this tool.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      leadId: z.string().cuid().optional(),
      clientId: z.string().cuid().optional(),
      to: z.string().max(24).optional(),
      message: z.string().min(4).max(1000),
      purpose: z
        .enum(["COLD_OUTREACH", "FOLLOW_UP", "MEETING_REQUEST", "DEMO_READY", "REACTIVATION", "CUSTOM"])
        .default("COLD_OUTREACH"),
    }),
    run: async (input) => {
      const message = await composePhoneMessage({
        channel: "WHATSAPP",
        purpose: input.purpose,
        kind: "AI_DRAFT",
        route: "LINK",
        body: input.message,
        toPhone: input.to ?? null,
        leadId: input.leadId ?? null,
        clientId: input.clientId ?? null,
        status: "READY",
      });
      return {
        messageId: message.id,
        to: displayPhone(message.toPhone),
        link: waLink(message.toPhone, message.body),
        note: "Nothing has been sent. Open the link, check the message, and press send — then mark it sent in the app.",
      };
    },
  },
  {
    key: "whatsapp.templates",
    name: "List the approved WhatsApp templates",
    group: "Communication",
    purpose:
      "The templates Meta has approved, with how many variables each takes. Outside the 24-hour window these are the only things that can be sent, so read this before writing a first WhatsApp to anybody.",
    scope: "read",
    requires: "whatsapp",
    spends: false,
    outward: false,
    input: z.object({ includeUnapproved: z.boolean().default(false) }),
    run: async (input) => {
      const templates = await prisma.whatsAppTemplate.findMany({
        where: input.includeUnapproved ? undefined : { status: "APPROVED" },
        orderBy: { name: "asc" },
        select: { name: true, language: true, category: true, status: true, body: true, variableCount: true, variableHints: true, rejectionReason: true },
      });
      return { templates, note: templates.length ? undefined : "No approved template exists yet, so a first WhatsApp can only go out as a wa.me link — see whatsapp.link." };
    },
  },
  {
    key: "sms.send",
    name: "Send a text message",
    group: "Communication",
    purpose:
      "Sends one SMS. For a payment reminder or an appointment confirmation — the things that get read. Costs money per 160 characters and cannot be recalled, so it is the last resort, not the first: check message.reach before reaching for it.",
    scope: "send",
    requires: "hubtelSms",
    spends: true,
    outward: true,
    input: z.object({
      to: z.string().min(9).max(24).optional().describe("Any usual form — 024…, 0244…, +233…. Only needed when there is no lead or client."),
      leadId: z.string().cuid().optional(),
      clientId: z.string().cuid().optional(),
      message: z.string().min(4).max(480).describe("Kept short. Say who it is from, because a sender id is easy to miss."),
      purpose: z
        .enum(["INVOICE_DELIVERY", "INVOICE_REMINDER", "PROJECT_UPDATE", "MEETING_REQUEST", "THANK_YOU", "ONBOARDING", "CUSTOM"])
        .default("CUSTOM"),
    }),
    preview: async (input) => describeSend("SMS", input),
    run: async (input) => {
      const message = await composePhoneMessage({
        channel: "SMS",
        purpose: input.purpose,
        kind: "AUTOMATION",
        body: input.message,
        toPhone: input.to ?? null,
        leadId: input.leadId ?? null,
        clientId: input.clientId ?? null,
      });
      const result = await sendPhoneMessage(message.id);
      if (!result.sent) throw new Error(result.reason ?? "The text was not sent.");
      return {
        messageId: message.id,
        to: displayPhone(message.toPhone),
        segments: message.segments,
        providerMessageId: result.providerMessageId ?? null,
      };
    },
  },
  // --- Changing the software ------------------------------------------------
  //
  // These let an agent write code, including to the repository that runs the
  // agents. The split is deliberate and is the whole safety story: opening a
  // pull request changes nothing that anybody can see, and merging one deploys
  // to Railway. So `code.propose` is ordinary write work, and `code.merge` is
  // `outward` — which routes it through the approval queue, where the Owner
  // reads the diffstat and the agent's reasoning before anything ships.
  //
  // `repo.allowedRepos` is the outer fence and is empty by default: an agent
  // can read any repository the token can see and write to none until somebody
  // names one.
  {
    key: "repo.read",
    name: "Read a repository",
    group: "Operations",
    purpose: "Lists a folder in a repository, or reads one file. For understanding a codebase before proposing a change to it.",
    scope: "read",
    requires: "github",
    spends: false,
    outward: false,
    input: z.object({
      repo: z.string().min(1).describe("owner/name, or just the name when a default owner is set."),
      path: z.string().max(300).default("").describe("A file to read, or a folder to list. Empty lists the root."),
      ref: z.string().max(200).optional().describe("A branch or commit. Defaults to the default branch."),
    }),
    run: async (input) => {
      // A path with an extension is almost always a file; try that first and
      // fall back to listing, because asking GitHub twice is cheaper than
      // making the agent guess which one it wanted.
      if (input.path && /\.[a-z0-9]+$/i.test(input.path)) {
        const content = await readFile(input.repo, input.path, input.ref);
        if (content !== null) return { kind: "file", path: input.path, content: content.slice(0, 60_000) };
      }
      return { kind: "tree", path: input.path, entries: await listTree(input.repo, input.path, input.ref) };
    },
  },
  {
    key: "repo.create",
    name: "Create a repository",
    group: "Operations",
    purpose: "Opens a new private repository, for a client project that is starting.",
    scope: "write",
    requires: "github",
    spends: false,
    outward: true,
    input: z.object({
      name: z.string().min(2).max(80),
      description: z.string().max(350).optional(),
      private: z.boolean().default(true).describe("Leave true unless the client has asked for it to be public."),
    }),
    preview: async (input) =>
      `Create a ${input.private ? "private" : "PUBLIC"} repository called ${input.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}${
        input.description ? ` — "${input.description}"` : ""
      }.`,
    run: async (input) => createRepo(input),
  },
  {
    key: "code.propose",
    name: "Propose a code change",
    group: "Operations",
    purpose:
      "Opens a branch, commits a set of files to it, and raises a pull request explaining the change. Changes nothing that is live — merging is a separate decision a person makes.",
    scope: "write",
    requires: "github",
    spends: false,
    // Not outward: a pull request is visible to nobody outside the company and
    // changes nothing running. Held back only by the agent's own dry-run flag,
    // which is what dry run is for — preparing work somebody then looks at.
    outward: false,
    input: z.object({
      repo: z.string().min(1),
      title: z.string().min(6).max(200).describe("What the change does, in the imperative — 'fix the invoice footer'."),
      body: z
        .string()
        .min(30)
        .max(20_000)
        .describe("Why the change is right, what you checked, and what could go wrong. Whoever merges this reads only what you write here."),
      files: z
        .array(z.object({ path: z.string().min(1).max(300), content: z.string().max(200_000) }))
        .min(1)
        .max(30)
        .describe("The complete new content of each file. Read the file first — this replaces it entirely."),
    }),
    preview: async (input) =>
      `Open a pull request on ${input.repo} — "${input.title}" — changing ${input.files.length} file(s): ${input.files
        .map((file: { path: string }) => file.path)
        .slice(0, 6)
        .join(", ")}.`,
    run: async (input) => {
      const branch = agentBranchName(input.title);
      await createBranch(input.repo, branch);
      const commit = await commitFiles({ repo: input.repo, branch, message: input.title, files: input.files });
      const pr = await openPullRequest({
        repo: input.repo,
        branch,
        title: input.title,
        // Said on the pull request itself, so somebody reading it on GitHub
        // rather than in this app still knows what wrote it.
        body: `${input.body}\n\n---\nOpened by a Dakyworld OS agent. Nothing here is merged automatically.`,
      });
      return { ...pr, commit: commit.sha };
    },
  },
  {
    key: "code.merge",
    name: "Merge a pull request",
    group: "Operations",
    purpose:
      "Merges a pull request. On this repository that deploys to production, so it always needs a person to approve it.",
    scope: "write",
    requires: "github",
    spends: false,
    // The reason this is `outward` when opening a pull request is not: merging
    // puts code in front of clients. The flag is what routes it through the
    // approval queue rather than a prompt asking the agent to be careful.
    outward: true,
    input: z.object({
      repo: z.string().min(1),
      number: z.number().int().min(1),
      method: z.enum(["squash", "merge", "rebase"]).default("squash"),
    }),
    preview: async (input) => {
      try {
        const pr = await getPullRequest(input.repo, input.number);
        if (pr.merged) return `#${input.number} on ${input.repo} has already been merged.`;
        return `Merge #${input.number} on ${input.repo} — "${pr.title}" — ${pr.changedFiles ?? "?"} file(s), +${pr.additions ?? "?"} −${
          pr.deletions ?? "?"
        }. On this repository, merging deploys.`;
      } catch (err) {
        return `Merge #${input.number} on ${input.repo}. (Could not read it just now: ${(err as Error).message})`;
      }
    },
    run: async (input) => mergePullRequest(input.repo, input.number, input.method),
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
    requires: "models",
    job: "text",
    spends: true,
    outward: false,
    input: z.object({
      brief: z.string().min(1).max(4000),
      audience: z.string().max(200).optional(),
      format: z.enum(["post", "email", "landing-page", "case-study", "one-pager"]).default("post"),
    }),
    run: async (input) => {
      const { data, provider } = await callModel<{ title: string; body: string; callToAction: string; claimsToCheck: string[] }>({
        purpose: "content.draft",
        job: "text",
        system: await writerSystem("content.draft", CONTENT_DRAFT_DOCTRINE, {
          facts: [BRAND, catalogueForPrompt()],
          contract: CONTENT_DRAFT_CONTRACT,
        }),
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
          noKey: "No model is connected for writing. Add a key under Settings → AI models.",
          refusal: "That brief could not be written from.",
          empty: "Nothing came back. Try a more specific brief.",
          parse: "The draft came back in a shape this app could not read.",
        },
      });
      // Named, because a draft's claims are worth weighing differently
      // depending on who wrote them.
      return { ...data, writtenBy: PROVIDERS[provider].name };
    },
  },
  {
    key: "content.factcheck",
    name: "Check the facts",
    group: "Documents",
    purpose:
      "Reads a draft against live sources and says which claims still hold, which have gone stale, and which cannot be evidenced at all.",
    scope: "read",
    requires: "models",
    job: "factcheck",
    // Perplexity bills per search as well as per token. Named, so the spend
    // gate applies.
    spends: true,
    outward: false,
    input: z.object({
      text: z.string().min(20).max(12000).describe("The draft to check. Paste it whole — a claim is judged in its context."),
      subject: z.string().max(200).optional().describe("What it is about, when the text alone doesn't say."),
      recency: z
        .enum(["day", "week", "month", "year", "any"])
        .default("year")
        .describe("How recent a source has to be to count. 'year' suits most business copy; 'week' suits anything about a live event."),
    }),
    run: async (input) => {
      const route = await routeFor("factcheck");
      const result = await callModel<{
        verdict: string;
        claims: { claim: string; status: string; finding: string; source: string }[];
        stale: string[];
        summary: string;
      }>({
        purpose: "content.factcheck",
        job: "factcheck",
        system: `You check business copy against what is true right now. Today is ${new Date().toISOString().slice(0, 10)}.

Pull out every checkable claim — a statistic, a price, a date, a product name, a standard, a regulation, a company fact — and judge each one against sources you can actually cite.

Four verdicts and no others:
- CONFIRMED: a source says this, and the source is current.
- OUTDATED: it was true and is not any more. Say what it is now.
- UNSUPPORTED: no source says it either way. This is not the same as false, and you must not report it as false.
- WRONG: a source contradicts it.

Rules:
- Never mark something CONFIRMED without a source you actually read. An unsourced confirmation is worse than no check at all, because somebody will publish on the strength of it.
- Judge the claim as written, not a more defensible version of it.
- Opinions, offers and statements about the writer's own business are not checkable facts. Leave them out rather than guessing.`,
        prompt: () => [input.subject ? `What this is about: ${input.subject}` : "", "The draft:", input.text].filter(Boolean).join("\n\n"),
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "claims", "stale", "summary"],
          properties: {
            verdict: {
              type: "string",
              enum: ["SAFE_TO_PUBLISH", "NEEDS_EDITS", "DO_NOT_PUBLISH"],
              description: "DO_NOT_PUBLISH only when something is WRONG. An UNSUPPORTED claim is NEEDS_EDITS.",
            },
            claims: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["claim", "status", "finding", "source"],
                properties: {
                  claim: { type: "string", description: "The sentence as written." },
                  status: { type: "string", enum: ["CONFIRMED", "OUTDATED", "UNSUPPORTED", "WRONG"] },
                  finding: { type: "string", description: "What is actually the case, and what to write instead." },
                  source: { type: "string", description: "The URL you read. Empty only for UNSUPPORTED." },
                },
              },
            },
            stale: {
              type: "array",
              items: { type: "string" },
              description: "Anything that is true today and has a date on which it stops being — a price, a deadline, a version.",
            },
            summary: { type: "string", description: "Two or three sentences for whoever is about to publish this." },
          },
        },
        ...(input.recency !== "any" ? { recency: input.recency } : {}),
        maxTokens: 6000,
        messages: {
          noKey: "No model is connected for fact-checking. Add a Perplexity key under Settings → AI models.",
          empty: "Nothing came back from the check. Try again.",
        },
      });

      return {
        ...result.data,
        // The honest part. Checking a claim against a model's training data is
        // a different and much weaker thing than checking it against the live
        // web, and whoever reads this has to be able to tell which they got.
        checkedBy: PROVIDERS[result.provider].name,
        checkedAgainstLiveSources: result.provider === "perplexity",
        sources: result.sources,
        note:
          result.provider === "perplexity"
            ? null
            : (route.note ??
              `${PROVIDERS[result.provider].name} answered this from what it already knows rather than from live sources. Treat CONFIRMED as "probably" until a Perplexity key is connected.`),
      };
    },
  },
  {
    key: "content.humanise",
    name: "Rewrite in plain English",
    group: "Documents",
    purpose: "Rewrites a draft so it reads like a person wrote it and lands on one reading. Keeps every fact; changes only how it is said.",
    scope: "read",
    requires: "models",
    job: "humanise",
    spends: true,
    outward: false,
    input: z.object({
      text: z.string().min(20).max(12000),
      audience: z
        .string()
        .max(200)
        .optional()
        .describe("Who reads it — 'a clinic owner who is not technical', 'a finance director'. Changes what needs explaining."),
      keepLength: z
        .boolean()
        .default(false)
        .describe("True to hold roughly the same length. False lets it get shorter, which is usually the improvement."),
    }),
    run: async (input) => {
      const result = await callModel<{ rewritten: string; changes: string[]; readingLevel: string; removed: string[] }>({
        purpose: "content.humanise",
        job: "humanise",
        system: await writerSystem("content.plain", CONTENT_PLAIN_DOCTRINE, { contract: CONTENT_PLAIN_CONTRACT }),
        prompt: () =>
          [
            input.audience ? `Who reads this: ${input.audience}` : "",
            input.keepLength ? "Hold roughly the same length." : "Shorter is better, as long as nothing is lost.",
            "The draft:",
            input.text,
          ]
            .filter(Boolean)
            .join("\n\n"),
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["rewritten", "changes", "readingLevel", "removed"],
          properties: {
            rewritten: { type: "string", description: "The rewrite. Plain text or markdown, matching whatever came in." },
            changes: { type: "array", items: { type: "string" }, description: "What you changed and why — one line each, not a diff." },
            readingLevel: { type: "string", description: "Roughly who can now read this without re-reading a sentence." },
            removed: {
              type: "array",
              items: { type: "string" },
              description: "Anything you cut, verbatim, so a person can judge whether it mattered.",
            },
          },
        },
        maxTokens: 8000,
        messages: {
          noKey: "No model is connected for rewriting. Add a Perplexity key under Settings → AI models.",
          empty: "Nothing came back from the rewrite. Try again.",
        },
      });

      return { ...result.data, rewrittenBy: PROVIDERS[result.provider].name };
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

  // --- Studio ---------------------------------------------------------------
  //
  // What the specialist agents actually make. Four of these are Claude-backed
  // and produce a *specification* — a design brief, an edit plan, an ad
  // concept, a page — because that is the honest boundary of what this app can
  // do on its own, and because a spec is what a designer, an editor or a
  // developer actually needs handed to them.
  //
  // The fifth, `image.generate`, makes a picture, and it can only do that
  // through a connected MCP server. It is deliberately a *named capability*
  // rather than a named provider: an agent's toolkit says "this one draws",
  // and which service draws is a connection the Owner makes and can change
  // without touching a seed. See services/tools/mcpTools.ts.
  {
    key: "design.brief",
    name: "Write a design brief",
    group: "Studio",
    purpose: "Turns a request for artwork into a brief a designer can work from: purpose, audience, sizes, hierarchy, colour and the exact copy.",
    scope: "read",
    requires: "claude",
    spends: false,
    outward: false,
    input: z.object({
      what: z.string().min(3).max(600).describe("What is being designed — 'social post announcing the new site', 'trade-show pull-up banner'."),
      audience: z.string().max(300).optional(),
      /** Where it will be seen. Drives the sizes and the safe areas. */
      placements: z.array(z.string().max(80)).max(8).optional(),
      mustSay: z.array(z.string().max(200)).max(10).optional(),
      clientId: z.string().cuid().optional(),
    }),
    run: async (input) => {
      const client = input.clientId
        ? await prisma.client.findUnique({ where: { id: input.clientId }, select: { name: true, company: true, sector: true } })
        : null;
      const profile = await companyProfile();

      return callClaude<{
        title: string;
        objective: string;
        audience: string;
        keyMessage: string;
        hierarchy: string[];
        copy: { role: string; text: string }[];
        artDirection: string;
        palette: { role: string; hex: string; use: string }[];
        typography: string;
        sizes: { placement: string; dimensions: string; note: string }[];
        avoid: string[];
      }>({
        purpose: "design.brief",
        system: `You write design briefs for ${profile.displayName}, an outsourced IT company. A brief is instructions for a designer, not a description of a finished thing.

${BRAND}

${VOICE}

The brand design system, which every brief must work inside:
- Ink #08101F, Navy #0B0A16, Blue #3157FF, Blue-light #6490FF, Cyan #6FE4FF, Lime #B8FF3D, Cream #F4F5F0, Muted #69758A, Line #DFE4EB.
- Space Grotesk for display, DM Sans for body.
- Lime is a mark colour and an action colour only, roughly 1-5% of a surface. It is never type on white. On a light surface the accent is blue.
- Blue is structure, selection and emphasis.

Write copy that could be set as-is. Never invent a client result, a statistic or a claim. Give real pixel dimensions for every placement you are given, and say what is in the safe area.`,
        prompt: () =>
          [
            `Design: ${input.what}`,
            input.audience ? `Audience: ${input.audience}` : "",
            input.placements?.length ? `Placements: ${input.placements.join(", ")}` : "Placements: pick the two or three that fit.",
            input.mustSay?.length ? `Must say:\n${input.mustSay.map((line: string) => `- ${line}`).join("\n")}` : "",
            client ? `For the client: ${client.company ?? client.name}${client.sector ? ` (${client.sector})` : ""}.` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        schema: {
          type: "object",
          required: ["title", "objective", "audience", "keyMessage", "hierarchy", "copy", "artDirection", "palette", "typography", "sizes", "avoid"],
          properties: {
            title: { type: "string" },
            objective: { type: "string", description: "What this piece has to achieve, in one sentence." },
            audience: { type: "string" },
            keyMessage: { type: "string", description: "The one thing a viewer must take away." },
            hierarchy: { type: "array", items: { type: "string" }, description: "What is read first, second, third." },
            copy: {
              type: "array",
              items: { type: "object", required: ["role", "text"], properties: { role: { type: "string" }, text: { type: "string" } } },
              description: "Every word that appears, set-ready. Roles like headline, subhead, CTA.",
            },
            artDirection: { type: "string" },
            palette: {
              type: "array",
              items: {
                type: "object",
                required: ["role", "hex", "use"],
                properties: { role: { type: "string" }, hex: { type: "string" }, use: { type: "string" } },
              },
            },
            typography: { type: "string" },
            sizes: {
              type: "array",
              items: {
                type: "object",
                required: ["placement", "dimensions", "note"],
                properties: { placement: { type: "string" }, dimensions: { type: "string" }, note: { type: "string" } },
              },
            },
            avoid: { type: "array", items: { type: "string" }, description: "What would break the brand system on this piece." },
          },
        },
        effort: "medium",
      }).then((result) => result.data);
    },
  },
  {
    key: "video.plan",
    name: "Plan a video edit",
    group: "Studio",
    purpose: "Turns raw footage and an objective into an edit plan: structure, shot list, on-screen text, captions, music direction and the cut per platform.",
    scope: "read",
    requires: "claude",
    spends: false,
    outward: false,
    input: z.object({
      objective: z.string().min(3).max(600),
      footage: z.string().max(2000).optional().describe("What has been shot, in the editor's words."),
      durationSeconds: z.number().int().min(5).max(1800).optional(),
      platforms: z.array(z.string().max(40)).max(6).optional(),
      clientId: z.string().cuid().optional(),
    }),
    run: async (input) => {
      const profile = await companyProfile();
      return callClaude<{
        title: string;
        angle: string;
        structure: { section: string; seconds: number; whatHappens: string; onScreenText: string }[];
        shotList: string[];
        captionScript: string;
        musicDirection: string;
        cuts: { platform: string; aspect: string; duration: string; note: string }[];
        thumbnailIdea: string;
      }>({
        purpose: "video.plan",
        system: `You plan video edits for ${profile.displayName}.

${BRAND}

${VOICE}

An edit plan is instructions to an editor with a timeline open. Give real second counts that add up to the target duration. On-screen text is set in Space Grotesk; keep it to a handful of words per card. Lime is a mark colour, never a text colour on a light frame. Never invent a client result or a statistic — if a number would help and you were not given one, say what to ask for.`,
        prompt: () =>
          [
            `Objective: ${input.objective}`,
            input.footage ? `Footage available:\n${input.footage}` : "Footage: not described — plan around what would need shooting and say so.",
            `Target duration: ${input.durationSeconds ?? 45} seconds`,
            input.platforms?.length ? `Platforms: ${input.platforms.join(", ")}` : "Platforms: pick what fits.",
          ].join("\n\n"),
        schema: {
          type: "object",
          required: ["title", "angle", "structure", "shotList", "captionScript", "musicDirection", "cuts", "thumbnailIdea"],
          properties: {
            title: { type: "string" },
            angle: { type: "string", description: "Why anyone watches past the first two seconds." },
            structure: {
              type: "array",
              items: {
                type: "object",
                required: ["section", "seconds", "whatHappens", "onScreenText"],
                properties: {
                  section: { type: "string" },
                  seconds: { type: "number" },
                  whatHappens: { type: "string" },
                  onScreenText: { type: "string" },
                },
              },
            },
            shotList: { type: "array", items: { type: "string" } },
            captionScript: { type: "string", description: "The burned-in caption track, as one block of text." },
            musicDirection: { type: "string" },
            cuts: {
              type: "array",
              items: {
                type: "object",
                required: ["platform", "aspect", "duration", "note"],
                properties: { platform: { type: "string" }, aspect: { type: "string" }, duration: { type: "string" }, note: { type: "string" } },
              },
            },
            thumbnailIdea: { type: "string" },
          },
        },
        effort: "medium",
      }).then((result) => result.data);
    },
  },
  {
    key: "ad.concept",
    name: "Write ad concepts",
    group: "Studio",
    purpose: "Paid-social concepts: the hook, the visual, the primary text, the headline and the call to action, sized per platform.",
    scope: "read",
    requires: "claude",
    spends: false,
    outward: false,
    input: z.object({
      offer: z.string().min(3).max(600).describe("What is being advertised."),
      audience: z.string().max(400).optional(),
      platforms: z.array(z.string().max(40)).max(6).optional(),
      /** How many distinct angles to write. Variants of one idea test nothing. */
      concepts: z.number().int().min(1).max(5).default(3),
      budgetNote: z.string().max(300).optional(),
    }),
    run: async (input) => {
      const profile = await companyProfile();
      return callClaude<{
        concepts: {
          name: string;
          angle: string;
          hook: string;
          visual: string;
          primaryText: string;
          headline: string;
          description: string;
          callToAction: string;
          whyItMightWork: string;
        }[];
        specs: { platform: string; placement: string; dimensions: string; textLimit: string }[];
        testPlan: string;
        claimsToCheck: string[];
      }>({
        purpose: "ad.concept",
        system: `You write paid-social advertising for ${profile.displayName}.

${BRAND}

${VOICE}

${catalogueForPrompt()}

Each concept is a genuinely different angle, not a rewording of the last one — two variants of one idea test nothing. Respect the platform's character limits and say what they are. Never invent a client, a result or a statistic; anything you cannot evidence goes in claimsToCheck instead of in the copy. No exclamation marks, no emoji, no "in today's fast-paced world".`,
        prompt: () =>
          [
            `Offer: ${input.offer}`,
            input.audience ? `Audience: ${input.audience}` : "",
            input.platforms?.length ? `Platforms: ${input.platforms.join(", ")}` : "Platforms: Facebook and Instagram feed.",
            input.budgetNote ? `Budget context: ${input.budgetNote}` : "",
            `Write ${input.concepts} concepts.`,
          ]
            .filter(Boolean)
            .join("\n"),
        schema: {
          type: "object",
          required: ["concepts", "specs", "testPlan", "claimsToCheck"],
          properties: {
            concepts: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "angle", "hook", "visual", "primaryText", "headline", "description", "callToAction", "whyItMightWork"],
                properties: {
                  name: { type: "string" },
                  angle: { type: "string" },
                  hook: { type: "string", description: "The first line, which decides whether the rest is read." },
                  visual: { type: "string", description: "What the image or video shows — enough for a designer to make it." },
                  primaryText: { type: "string" },
                  headline: { type: "string" },
                  description: { type: "string" },
                  callToAction: { type: "string" },
                  whyItMightWork: { type: "string" },
                },
              },
            },
            specs: {
              type: "array",
              items: {
                type: "object",
                required: ["platform", "placement", "dimensions", "textLimit"],
                properties: { platform: { type: "string" }, placement: { type: "string" }, dimensions: { type: "string" }, textLimit: { type: "string" } },
              },
            },
            testPlan: { type: "string", description: "What to run first, against what, and what result would settle it." },
            claimsToCheck: { type: "array", items: { type: "string" } },
          },
        },
        effort: "medium",
      }).then((result) => result.data);
    },
  },
  {
    key: "web.page",
    name: "Build a page",
    group: "Studio",
    purpose: "Produces a complete, self-contained HTML page on the brand design system — the thing a developer opens and edits rather than starts from nothing.",
    scope: "read",
    requires: "models",
    job: "html",
    spends: false,
    outward: false,
    input: z.object({
      page: z.string().min(3).max(400).describe("What page this is — 'service page for automation', 'landing page for the care plans'."),
      sections: z.array(z.string().max(120)).max(12).optional(),
      goal: z.string().max(400).optional().describe("What a visitor should do."),
      notes: z.string().max(2000).optional(),
    }),
    run: async (input) => {
      const profile = await companyProfile();
      const result = await callModel<{ html: string; sections: string[]; notes: string[] }>({
        purpose: "web.page",
        job: "html",
        system: `You build web pages for ${profile.displayName}.

${BRAND}

${VOICE}

${catalogueForPrompt()}

Output one complete HTML document. Rules it must follow:
- Self-contained: all CSS in one <style> block, no frameworks, no external scripts. Google Fonts is the one allowed external link.
- The brand system: Ink #08101F, Navy #0B0A16, Blue #3157FF, Blue-light #6490FF, Cyan #6FE4FF, Lime #B8FF3D, Cream #F4F5F0, Muted #69758A, Line #DFE4EB. Space Grotesk for display, DM Sans for body.
- Lime is a mark and an action colour only, roughly 1-5% of the surface, and never type on white. Blue is structure and emphasis.
- Responsive with real breakpoints. Semantic HTML, one h1, alt text on every image, visible focus states, and contrast that passes AA.
- Real copy in Dakyworld's voice, not lorem ipsum. Never invent a client, a result or a statistic. Only quote a price that is in the catalogue above.
- The company's own contact details are: ${profile.email}, ${profile.phone}, ${profile.web}, ${profile.location}.`,
        prompt: () =>
          [
            `Page: ${input.page}`,
            input.goal ? `What a visitor should do: ${input.goal}` : "",
            input.sections?.length ? `Sections:\n${input.sections.map((section: string) => `- ${section}`).join("\n")}` : "",
            input.notes ? `Notes:\n${input.notes}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        schema: {
          type: "object",
          required: ["html", "sections", "notes"],
          properties: {
            html: { type: "string", description: "The complete document, from <!doctype html> to </html>." },
            sections: { type: "array", items: { type: "string" }, description: "The sections you built, in order." },
            notes: { type: "array", items: { type: "string" }, description: "What a developer should change before this ships — real images, real links, anything you had to assume." },
          },
        },
        // A page is long output and gets read closely by whoever ships it.
        effort: "high",
        maxTokens: 16000,
      });
      return { ...result.data, builtBy: PROVIDERS[result.provider].name };
    },
  },
  {
    key: "image.generate",
    name: "Generate an image",
    group: "Studio",
    purpose: "Makes a picture. Goes to ChatGPT when a key is set, and to a connected MCP image server otherwise.",
    scope: "send",
    // "models" rather than "mcp": there are two ways to draw a picture now and
    // requiring the one that used to be the only way would refuse work the
    // other can do.
    requires: "models",
    job: "image",
    // Every image service charges per picture. Named, so the spend gate applies
    // and the call is refused for an agent below autonomy 4.
    spends: true,
    outward: false,
    input: z.object({
      prompt: z.string().min(3).max(2000),
      /** Passed straight through when the provider takes one. */
      aspectRatio: z.string().max(16).optional(),
      count: z.number().int().min(1).max(4).default(1),
      style: z.string().max(300).optional(),
      quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
    }),
    run: async (input) => {
      const prompt = input.style ? `${input.prompt}. Style: ${input.style}` : input.prompt;

      // ChatGPT first when it is connected and images are routed to it: it is
      // the route the Owner configured, and it returns the bytes rather than a
      // link that expires.
      const route = await routeFor("image");
      if (route.ready && route.serving === "openai") {
        const result = await generateImage({
          purpose: "image.generate",
          prompt,
          count: input.count,
          size: sizeFor(input.aspectRatio),
          quality: input.quality,
        });
        return {
          provider: PROVIDERS.openai.name,
          model: result.model,
          images: result.images.map((url) => ({ type: "image", url })),
          costUsd: result.costUsd,
        };
      }

      // Otherwise whatever MCP server advertises an image tool — the path this
      // tool had before ChatGPT was an option, kept because it still works.
      const provider = await imageProvider();
      if (!provider) {
        throw new Error(
          route.note ??
            "Nothing here can draw a picture. Add a ChatGPT key under Settings → AI models, or connect an MCP server that advertises an image tool.",
        );
      }
      const result = await callOn(provider.server, provider.tool.name, {
        prompt,
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio, aspectRatio: input.aspectRatio } : {}),
        ...(input.count > 1 ? { n: input.count, count: input.count } : {}),
      });
      if (result.isError) throw new Error(result.text || "The image service reported that it failed.");
      return {
        provider: provider.server.name,
        tool: provider.tool.name,
        text: result.text,
        // Where the pictures are. A provider answers with links, not bytes.
        images: result.parts.filter((part) => part.type === "image" || part.mimeType?.startsWith("image/")),
        structured: result.structured,
      };
    },
    preview: async (input) => {
      const route = await routeFor("image");
      if (route.ready && route.serving === "openai") {
        return `Would ask ${PROVIDERS.openai.name} for ${input.count} image(s): "${input.prompt.slice(0, 160)}". Nothing was generated and nothing was charged.`;
      }
      const provider = await imageProvider();
      return provider
        ? `Would ask ${provider.server.name} for ${input.count} image(s): "${input.prompt.slice(0, 160)}". Nothing was generated and nothing was charged.`
        : `Would generate an image, but nothing here can draw one — so nothing would happen. Add a ChatGPT key under Settings → AI models.`;
    },
  },
  {
    key: "email.polish",
    name: "Polish an email",
    group: "Documents",
    purpose:
      "The last read before a person sees a draft: makes it sound like somebody wrote it, keeps every fact exactly as it was, and says whether the email actually does its job.",
    scope: "read",
    requires: "models",
    job: "humanise",
    spends: true,
    outward: false,
    input: z.object({
      subject: z.string().min(1).max(300),
      body: z.string().min(20).max(12000),
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
      recipient: z.string().max(200).optional(),
      facts: z
        .array(z.string().max(500))
        .max(60)
        .optional()
        .describe("What the draft was written from. Given so the polish can tell a fact from an invention."),
    }),
    run: async (input) =>
      polishEmail({
        subject: input.subject,
        body: input.body,
        purpose: input.purpose,
        recipient: input.recipient ?? null,
        facts: input.facts,
      }),
  },
  {
    key: "demo.build",
    name: "Build a demo page",
    group: "Studio",
    purpose:
      "Builds a landing page for one prospect — their name, trade and services — from what the scan found, against design references from real published work. Hosted at /demos/<slug>.",
    scope: "write",
    requires: "models",
    job: "html",
    // A design lookup on Perplexity and a whole page of HTML from ChatGPT.
    // The largest single model spend in the app.
    spends: true,
    // The page is publicly reachable the moment it exists, so this counts as
    // reaching outside the company even though nothing is sent.
    outward: true,
    input: z.object({
      leadId: z.string().min(1),
      rebuild: z.boolean().default(true).describe("Replace the page at the existing link rather than opening a second one."),
    }),
    preview: async (input) => {
      const lead = await prisma.lead.findUnique({
        where: { id: input.leadId },
        select: { contactName: true, companyName: true, website: true, research: { select: { ranAt: true } } },
      });
      const who = lead?.companyName ?? lead?.contactName ?? "an unknown lead";
      return `Build a ${lead?.website ? "redesign of" : "first landing page for"} ${who}, publish it at a public /demos link, and leave it as a draft for a person to read. ${
        lead?.research ? "" : "Nobody has looked at this business yet, so the page would be generic — run the scan first."
      }`.trim();
    },
    run: async (input) => {
      const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, include: { research: true } });
      if (!lead) throw new Error("No such lead.");
      if (!lead.research) {
        // A demo built from a bare record is a template with a name dropped
        // into it, which is the one thing this feature exists not to be.
        throw new Error("Nobody has looked at this business yet. Run lead.prepare first — a demo built from a bare record is a template.");
      }
      const result = await buildDemo(subjectFromLead(lead, lead.research.audit as never, lead.research.look as never), {
        rebuild: input.rebuild,
      });
      return result;
    },
  },
  {
    key: "demo.read",
    name: "Read demos",
    group: "Studio",
    purpose: "What has been built for whom, whether the link has gone out, and whether they opened it.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ leadId: z.string().optional(), status: z.enum(["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "ARCHIVED"]).optional(), limit }),
    run: async (input) => {
      const base = await appUrl();
      const demos = await prisma.demo.findMany({
        where: { ...(input.leadId ? { leadId: input.leadId } : {}), ...(input.status ? { status: input.status } : {}) },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          slug: true,
          title: true,
          businessName: true,
          status: true,
          version: true,
          views: true,
          lastViewedAt: true,
          sentAt: true,
          leadId: true,
        },
      });
      return demos.map((demo) => ({ ...demo, url: demoUrl(demo.slug, base) }));
    },
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

  // --- Hiring ---------------------------------------------------------------
  //
  // Granted to the Agent Creator and to nobody else. Every other agent reaches
  // this ground through `needSkill`, which records a need and decides nothing —
  // see services/agents/hiring.ts for why the two are separate.
  {
    key: "agent.gaps",
    name: "Read the skill gaps",
    group: "Operations",
    purpose: "Every craft an agent has said Dakyworld does not have, and how many separate agents have asked for it.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ gapId: z.string().max(64).optional() }),
    run: async (input) => {
      if (input.gapId) return prisma.agentGap.findUnique({ where: { id: input.gapId } });
      return openGaps();
    },
  },
  {
    key: "agent.roster",
    name: "Search the roster",
    group: "Operations",
    purpose: "Who already does a kind of work, matched on what they are good at rather than on a tool key. The check before proposing a hire.",
    scope: "read",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({ need: z.string().min(3).max(200) }),
    run: async (input) => {
      const matches = await searchRoster(input.need);
      return {
        matches,
        // Said in words rather than left to be inferred from an empty array:
        // "no matches" and "I did not look properly" produce the same JSON.
        verdict: matches.length === 0 ? "Nobody on the roster is a match for this." : `${matches.length} existing agent(s) do some of this already.`,
      };
    },
  },
  {
    key: "agent.hire",
    name: "Propose a new agent",
    group: "Operations",
    purpose:
      "Files a complete design for a new agent. It does NOT create one — the Owner approves it in Slack, or the standing hiring policy does. Nothing exists until then.",
    scope: "write",
    requires: "database",
    spends: false,
    // Not outward — nobody outside the company sees a hire. It is gated by the
    // hiring policy and by dry run, which are the two that mean anything here:
    // the autonomy ladder is about acting on the world, and this acts on the
    // company.
    outward: false,
    input: z.object({
      key: z.string().min(3).max(48).describe("Lowercase letters, numbers and dots, e.g. finance.bookkeeper."),
      name: z.string().min(1).max(80),
      title: z.string().min(1).max(120),
      department: z.enum(["EXECUTIVE", "REVENUE", "DELIVERY", "FINANCE", "MARKETING", "TECHNOLOGY", "CLIENT", "RISK", "PEOPLE"]),
      managerKey: z.string().min(1).max(64).describe("An existing agent for this one to report to and escalate into."),
      mission: z.string().min(10).max(600).describe("One sentence with one verb in it. A mission needing an 'and' is usually two agents."),
      deliverable: z.string().min(10).max(300).describe("The single finished thing this agent produces. If you cannot name one, this is not one agent."),
      skills: z.array(z.string().max(80)).min(1).max(12).describe("What it is good at, in a client's words rather than in tool keys."),
      kpis: z.array(z.string().max(120)).max(8).default([]),
      toolkit: z.array(z.string().max(64)).max(30).default([]).describe("Tool keys from the catalogue. Anything that is not a real key is dropped and named back to you."),
      escalationPolicy: z.string().min(10).max(600),
      avatar: z.string().max(4).optional().describe("One glyph for the roster card."),
      prompt: z
        .record(z.string().max(4000))
        .describe("The ten prompt layers: role, mission, scope, dataRules, tools, policy, process, escalateWhen, output, memory. Write process and output properly — they are what makes it good at the job rather than generically competent."),
      rationale: z.string().min(20).max(2000).describe("Why this is a new agent rather than work for somebody who already exists. Name the agents you checked."),
      gapId: z.string().max(64).optional().describe("The gap this answers, when it answers one."),
    }),
    preview: async (input, ctx) => {
      const overlaps = await findOverlaps(`${input.title} ${input.mission} ${input.deliverable}`, input.skills);
      const policy = await hirePolicy();
      return [
        `Propose hiring ${input.name} (${input.key}) — ${input.title}, reporting to ${input.managerKey}.`,
        `Produces: ${input.deliverable}`,
        input.toolkit.length ? `Asks for: ${input.toolkit.join(", ")}.` : "Asks for no tools.",
        overlaps.length ? `Overlaps ${overlaps.map((o) => `${o.name} (${Math.round(o.score * 100)}%)`).join(", ")}.` : "No existing agent overlaps it.",
        policy === "AUTO"
          ? "The hiring policy is AUTO, so approving this run would create the agent immediately at autonomy 1 with dry run on."
          : "The hiring policy is ASK, so this would go to the Owner in Slack and nothing would be created yet.",
      ].join(" ");
    },
    run: async (input, ctx) => {
      const { gapId, ...design } = input;
      return proposeHire(
        { ...design, avatar: design.avatar ?? null, prompt: design.prompt as Record<string, string> },
        { proposedByKey: ctx.agentKey ?? "owner", gapId: gapId ?? null, taskId: null },
      );
    },
  },
  {
    key: "agent.closeGap",
    name: "Close a skill gap",
    group: "Operations",
    purpose: "Records that a reported gap is not a new agent — the work belongs to somebody who already exists, or Dakyworld does not do it.",
    scope: "write",
    requires: "database",
    spends: false,
    outward: false,
    input: z.object({
      gapId: z.string().min(1).max(64),
      reason: z.string().min(10).max(1000).describe("Why this is not a hire. Say who should have taken the work, if anybody."),
      belongsTo: z.string().max(64).optional().describe("The existing agent whose job this is. The agent that raised the gap is told, by name."),
    }),
    preview: async (input) => `Close the gap ${input.gapId} without hiring${input.belongsTo ? `, saying it belongs to ${input.belongsTo}` : ""}: ${input.reason.slice(0, 160)}`,
    run: async (input) => {
      const closed = await closeGap(input.gapId, input.reason, input.belongsTo ?? null);
      return closed ? { closed: true, gapId: input.gapId } : { closed: false, note: "That gap is already filled or does not exist." };
    },
  },
];

export const TOOLS_BY_KEY = new Map(TOOLS.map((tool) => [tool.key, tool]));

/** A built-in tool by key. Synchronous, and blind to anything an MCP server adds. */
export function findTool(key: string): ToolDefinition | undefined {
  return TOOLS_BY_KEY.get(key);
}

/**
 * The whole catalogue: what is in this repository, plus whatever the connected
 * MCP servers advertise.
 *
 * Everything that answers "what can be granted" and "what can be called" goes
 * through here rather than through `TOOLS`, so a tool from a server is
 * grantable, callable, auditable and refusable on exactly the same terms as a
 * built-in one. `TOOLS` remains the list of tools whose behaviour lives in a
 * diff, which is a different and still useful question.
 */
export async function listTools(): Promise<ToolDefinition[]> {
  return [...TOOLS, ...(await mcpTools())];
}

/** The same, including servers switched off, so a screen can show what they would add. */
export async function listAllTools(): Promise<ToolDefinition[]> {
  return [...TOOLS, ...(await allMcpTools())];
}

/** By key, across both halves. This is what the invoker resolves against. */
export async function resolveTool(key: string): Promise<ToolDefinition | undefined> {
  const builtin = TOOLS_BY_KEY.get(key);
  if (builtin) return builtin;
  if (!key.startsWith("mcp.")) return undefined;
  return (await allMcpTools()).find((tool) => tool.key === key);
}


// --- Helpers for the phone channels ----------------------------------------

/**
 * The facts a phone-channel draft is written from.
 *
 * The same resolver the email composer uses, so an agent's WhatsApp and a
 * person's email about the same lead argue from one set of facts. A second
 * context builder here would be a second thing to keep in step with the audit,
 * the research and the demo link.
 */
async function resolveMessageContext(input: { leadId?: string; clientId?: string; toPhone?: string; toName?: string }) {
  return resolveContext({
    leadId: input.leadId ?? null,
    clientId: input.clientId ?? null,
    toPhone: input.toPhone ?? null,
    toName: input.toName ?? null,
  });
}

/**
 * The number a tool is actually going to write to, resolved the same way the
 * composer resolves it — from the lead or client when one was named, from the
 * typed number otherwise.
 */
async function resolveTargetNumber(input: { leadId?: string; clientId?: string; to?: string }): Promise<ReturnType<typeof toE164>> {
  const code = await defaultCallingCode();
  if (input.to) return toE164(input.to, code);
  if (input.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, select: { contactPhone: true } });
    return toE164(lead?.contactPhone, code);
  }
  if (input.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: input.clientId },
      select: { phone: true, contacts: { where: { isPrimary: true }, take: 1, select: { phone: true } } },
    });
    return toE164(client?.contacts[0]?.phone ?? client?.phone, code);
  }
  return null;
}

/**
 * What an approval card says about a message before it goes.
 *
 * Answers the three things the Owner needs and cannot get anywhere else: who
 * it is going to, what it will cost, and — the one that is unique to this
 * channel — whether WhatsApp will carry it at all. A preview that says "sends
 * a message" is a preview of nothing.
 */
async function describeSend(
  channel: "WHATSAPP" | "SMS",
  input: { leadId?: string; clientId?: string; to?: string; message?: string; template?: string; variables?: string[] },
): Promise<string> {
  const parsed = await resolveTargetNumber(input);
  if (!parsed) return "There is no phone number on that record, so nothing would be sent.";
  if (!parsed.mobile) return `${parsed.display} looks like a landline, so nothing would arrive.`;

  const suppressed = await prisma.messageSuppression.findUnique({ where: { phone: parsed.e164 } });
  if (suppressed) return `${parsed.display} has asked not to be contacted (${suppressed.reason}), so nothing would be sent.`;

  const preview = (input.template ? `template "${input.template}"` : `"${(input.message ?? "").slice(0, 160)}${(input.message ?? "").length > 160 ? "…" : ""}"`);

  if (channel === "SMS") {
    const cost = smsCost(input.message ?? "");
    return `Text ${parsed.display}: ${preview} — ${cost.segments} segment${cost.segments === 1 ? "" : "s"} in ${cost.encoding}.`;
  }

  const thread = await resolveThread("WHATSAPP", parsed.e164, { leadId: input.leadId ?? null, clientId: input.clientId ?? null });
  const open = windowOpen(thread);
  const left = windowRemainingMinutes(thread);

  if (input.template) return `WhatsApp ${parsed.display} the approved ${preview}${input.variables?.length ? ` with ${input.variables.join(", ")}` : ""}.`;
  if (open) return `WhatsApp ${parsed.display}: ${preview} — their window is open for another ${left} minute${left === 1 ? "" : "s"}.`;
  return `This would be refused: ${parsed.display} has not messaged us in 24 hours, so WhatsApp will only carry an approved template. Name one, or use whatsapp.link.`;
}
