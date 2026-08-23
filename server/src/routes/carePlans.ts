import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isValidTimezone, safeZone } from "../lib/timezone.js";
import {
  billPlanNow,
  computeNextBillingAt,
  computeNextReviewAt,
  currentPeriodStart,
  hoursIn,
  nextPeriodStart,
  normaliseBillingDay,
  syncCarePlanSchedule,
} from "../services/carePlanBilling.js";
import { gateBy } from "../middleware/permissionGate.js";

export const carePlansRouter = Router();

carePlansRouter.use(
  gateBy({
    view: "retainers.view",
    create: "retainers.create",
    edit: "retainers.edit",
    remove: "retainers.delete",
    routes: [
      { path: /^\/[^/]+\/bill-now$/, permission: "retainers.bill" },
      { path: /^\/[^/]+\/(churn|pause|resume|reviewed)$/, permission: "retainers.edit" },
    ],
  }),
);

/**
 * Care plans are the recurring half of the business, and every route here
 * either moves money or decides when money moves. Finance and the Owner only.
 */

const planInput = z.object({
  clientId: z.string().cuid(),
  projectId: z.string().cuid().nullish(),
  tier: z.enum(["SME_ESSENTIALS", "GROWTH", "ENTERPRISE_CONCIERGE"]),
  monthlyFee: z.number().nonnegative(),
  currency: z.string().min(1).default("GHS"),
  billingDay: z.number().int().min(1).max(28).default(1),
  timezone: z.string().refine(isValidTimezone, { message: "Unknown timezone" }).default("Africa/Accra"),
  autoInvoice: z.boolean().default(true),
  dueDays: z.number().int().min(0).max(90).default(14),
  includedHours: z.number().nonnegative().nullish(),
  overageHourlyRate: z.number().nonnegative().nullish(),
  reviewEveryMonths: z.number().int().min(0).max(24).default(3),
  startedAt: z.coerce.date().optional(),
  notes: z.string().max(2000).nullish(),
});

/** Everything a care plan needs on screen, and nothing that needs a second query. */
const planInclude = {
  client: { select: { id: true, name: true, company: true, email: true } },
  project: { select: { id: true, name: true, status: true } },
  _count: { select: { invoices: true, cycles: true } },
} as const;

/**
 * Hours used so far in the period running right now — the number that answers
 * "are we over?" while there is still time to do something about it. It is
 * computed rather than stored: a counter that has to be reset every month is a
 * counter that is eventually wrong.
 */
async function currentUsage(plan: Awaited<ReturnType<typeof prisma.carePlan.findFirst>> & object) {
  const zone = safeZone(plan.timezone);
  const periodStart = currentPeriodStart(new Date(), zone, plan.billingDay);
  const periodEnd = nextPeriodStart(periodStart, zone, plan.billingDay);
  const hoursUsed = await hoursIn(plan, periodStart, periodEnd);
  const included = plan.includedHours === null ? null : Number(plan.includedHours);
  return {
    periodStart,
    periodEnd,
    hoursUsed,
    includedHours: included,
    hoursRemaining: included === null ? null : Math.round((included - hoursUsed) * 100) / 100,
  };
}

carePlansRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const plans = await prisma.carePlan.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: [{ status: "asc" }, { nextBillingAt: "asc" }],
      include: planInclude,
    });
    // One usage read per plan. A handful of retainers, one aggregate each —
    // cheaper than the join it would take to avoid it.
    const usage = await Promise.all(plans.map((plan) => currentUsage(plan)));
    res.json(plans.map((plan, index) => ({ ...plan, usage: usage[index] })));
  } catch (err) {
    next(err);
  }
});

carePlansRouter.get("/:id", async (req, res, next) => {
  try {
    const plan = await prisma.carePlan.findUnique({
      where: { id: req.params.id },
      include: {
        ...planInclude,
        cycles: {
          orderBy: { periodStart: "desc" },
          take: 24,
          include: { invoice: { select: { id: true, invoiceNumber: true, status: true, amountTotal: true, currency: true, pdfUrl: true } } },
        },
      },
    });
    if (!plan) return res.status(404).json({ error: "Care plan not found" });
    res.json({ ...plan, usage: await currentUsage(plan) });
  } catch (err) {
    next(err);
  }
});

carePlansRouter.post("/", async (req, res, next) => {
  try {
    const data = planInput.parse(req.body);
    const startedAt = data.startedAt ?? new Date();

    const plan = await prisma.carePlan.create({
      data: {
        clientId: data.clientId,
        projectId: data.projectId ?? null,
        tier: data.tier,
        monthlyFee: data.monthlyFee,
        currency: data.currency,
        billingDay: normaliseBillingDay(data.billingDay),
        timezone: data.timezone,
        autoInvoice: data.autoInvoice,
        dueDays: data.dueDays,
        includedHours: data.includedHours ?? null,
        overageHourlyRate: data.overageHourlyRate ?? null,
        reviewEveryMonths: data.reviewEveryMonths,
        notes: data.notes ?? null,
        startedAt,
        // The first invoice lands on the first billing day *after* the plan
        // starts, so a plan signed on the 20th isn't back-charged for the 1st.
        nextBillingAt: data.autoInvoice ? computeNextBillingAt({ ...data, status: "ACTIVE" }, startedAt) : null,
        nextReviewAt: computeNextReviewAt({ ...data, status: "ACTIVE" }, startedAt),
      },
      include: planInclude,
    });
    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
});

carePlansRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = planInput.partial().omit({ clientId: true }).parse(req.body);
    const existing = await prisma.carePlan.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Care plan not found" });

    await prisma.carePlan.update({
      where: { id: existing.id },
      data: {
        ...data,
        billingDay: data.billingDay === undefined ? undefined : normaliseBillingDay(data.billingDay),
        projectId: data.projectId === undefined ? undefined : (data.projectId ?? null),
        includedHours: data.includedHours === undefined ? undefined : (data.includedHours ?? null),
        overageHourlyRate: data.overageHourlyRate === undefined ? undefined : (data.overageHourlyRate ?? null),
        notes: data.notes === undefined ? undefined : (data.notes ?? null),
      },
    });

    // The billing day, the timezone or auto-invoicing may just have moved.
    await syncCarePlanSchedule(existing.id);
    res.json(await prisma.carePlan.findUnique({ where: { id: existing.id }, include: planInclude }));
  } catch (err) {
    next(err);
  }
});

/**
 * Pause stops the billing without ending the relationship — the cycles, the
 * hours and the invoice history all stay. Resume picks the schedule back up
 * from today rather than back-billing the gap, which is the point of pausing.
 */
carePlansRouter.post("/:id/pause", async (req, res, next) => {
  try {
    await prisma.carePlan.update({
      where: { id: req.params.id },
      data: { status: "PAUSED", pausedAt: new Date(), nextBillingAt: null },
    });
    res.json(await prisma.carePlan.findUnique({ where: { id: req.params.id }, include: planInclude }));
  } catch (err) {
    next(err);
  }
});

carePlansRouter.post("/:id/resume", async (req, res, next) => {
  try {
    await prisma.carePlan.update({
      where: { id: req.params.id },
      data: { status: "ACTIVE", pausedAt: null, churnedAt: null, churnReason: null },
    });
    await syncCarePlanSchedule(req.params.id);
    res.json(await prisma.carePlan.findUnique({ where: { id: req.params.id }, include: planInclude }));
  } catch (err) {
    next(err);
  }
});

carePlansRouter.post("/:id/churn", async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    await prisma.carePlan.update({
      where: { id: req.params.id },
      data: {
        status: "CHURNED",
        churnedAt: new Date(),
        churnReason: reason ?? null,
        nextBillingAt: null,
        nextReviewAt: null,
      },
    });
    res.json(await prisma.carePlan.findUnique({ where: { id: req.params.id }, include: planInclude }));
  } catch (err) {
    next(err);
  }
});

/** Records that the periodic review happened, and books the next one. */
carePlansRouter.post("/:id/reviewed", async (req, res, next) => {
  try {
    const plan = await prisma.carePlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Care plan not found" });
    const now = new Date();
    await prisma.carePlan.update({
      where: { id: plan.id },
      data: { lastReviewAt: now, nextReviewAt: computeNextReviewAt(plan, now) },
    });
    res.json(await prisma.carePlan.findUnique({ where: { id: plan.id }, include: planInclude }));
  } catch (err) {
    next(err);
  }
});

/**
 * Raises the invoice now instead of waiting for the billing day. Returns what
 * it did rather than a bare 200 — "already billed" is a normal answer here,
 * not an error, and the page says so.
 */
carePlansRouter.post("/:id/bill-now", async (req, res, next) => {
  try {
    const outcomes = await billPlanNow(req.params.id);
    res.json({ outcomes, plan: await prisma.carePlan.findUnique({ where: { id: req.params.id }, include: planInclude }) });
  } catch (err) {
    next(err);
  }
});
