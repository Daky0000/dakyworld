import { Prisma, type CarePlan, type CarePlanCycle } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { safeZone, zonedDateParts, zonedTimeToUtc } from "../lib/timezone.js";
import { createNumberedInvoice } from "./invoiceNumber.js";

/**
 * Care plan billing — the retainer engine behind the MRR figure.
 *
 * **In advance, in arrears.** A retainer is invoiced at the start of the month
 * it covers, because that is what a retainer is. Hours can't work that way:
 * how many were used is only known once the month has ended. So each invoice
 * carries the coming month's fee *and* the closing month's overage, and every
 * cycle is settled one cycle late. `CarePlanCycle.settledAt` is what marks the
 * difference between "not counted yet" and "counted, and it was zero".
 *
 * **Billing twice is the failure that matters.** Not billing is visible — the
 * client says so. Billing twice is a refund and an apology. Three things stop
 * it: `nextBillingAt` is advanced before any invoice is written, the period is
 * derived from the calendar rather than from when the job happened to run, and
 * `@@unique([carePlanId, periodStart])` makes a duplicate a database error
 * rather than a duplicate.
 *
 * **Nothing is sent automatically.** Invoices are raised as DRAFT. There is no
 * email provider wired into this app, so "sent" would be a status flip with no
 * email behind it — the invoice still has to be delivered by hand, and a
 * status that lies about that is worse than one that waits.
 */

/** Local time of day the scheduler bills at: before the working day starts. */
const BILL_HOUR = 6;
/** A restart after a long outage bills at most this many missed months. */
const MAX_CATCHUP_PERIODS = 3;

export const TIER_LABEL: Record<CarePlan["tier"], string> = {
  SME_ESSENTIALS: "SME Essentials",
  GROWTH: "Growth",
  ENTERPRISE_CONCIERGE: "Enterprise Concierge",
};

type SchedulableCarePlan = Pick<CarePlan, "billingDay" | "timezone" | "status">;

/** 1–28: every month has a 28th, so no plan ever skips February. */
export function normaliseBillingDay(day: number): number {
  return Math.min(28, Math.max(1, Math.round(day)));
}

/** Local midnight on `day` of the month `offset` months from the one holding `at`. */
function monthAnchor(at: Date, zone: string, day: number, offset = 0): Date {
  const [year, month] = zonedDateParts(at, zone);
  // Date.UTC overflows both ways, so month 13 is next January and month 0 is
  // last December — which is the whole of the calendar arithmetic here.
  return zonedTimeToUtc(year, month + offset, day, 0, 0, zone);
}

/** The start of the period that contains `at` — this month's billing day, or last month's. */
export function currentPeriodStart(at: Date, zone: string, billingDay: number): Date {
  const day = normaliseBillingDay(billingDay);
  const [, , dayOfMonth] = zonedDateParts(at, zone);
  return monthAnchor(at, zone, day, dayOfMonth >= day ? 0 : -1);
}

/** The period that follows the one starting at `periodStart`. */
export function nextPeriodStart(periodStart: Date, zone: string, billingDay: number): Date {
  return monthAnchor(periodStart, zone, normaliseBillingDay(billingDay), 1);
}

/**
 * When this plan next raises an invoice, strictly after `from`. Null when the
 * plan is paused or churned — a paused plan keeps its history and stops
 * costing the client money, which is the only reason to pause one.
 */
export function computeNextBillingAt(plan: SchedulableCarePlan, from = new Date()): Date | null {
  if (plan.status !== "ACTIVE") return null;
  const zone = safeZone(plan.timezone);
  const day = normaliseBillingDay(plan.billingDay);

  // This month's billing day, else next month's — the second is only needed
  // because the first has usually already passed.
  for (const offset of [0, 1]) {
    const [year, month] = zonedDateParts(from, zone);
    const candidate = zonedTimeToUtc(year, month + offset, day, BILL_HOUR, 0, zone);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

/** The next review date, `reviewEveryMonths` on from `from`. Null turns reviews off. */
export function computeNextReviewAt(plan: Pick<CarePlan, "reviewEveryMonths" | "timezone" | "status">, from = new Date()): Date | null {
  if (plan.status === "CHURNED" || plan.reviewEveryMonths <= 0) return null;
  const zone = safeZone(plan.timezone);
  const [year, month, day] = zonedDateParts(from, zone);
  return zonedTimeToUtc(year, month + plan.reviewEveryMonths, day, 9, 0, zone);
}

/**
 * Recomputes and persists both schedules. Call after any change that moves
 * them — the billing day, the timezone, pausing, resuming.
 *
 * The review date is left alone once set: it is moved by holding the review,
 * not by editing the plan's price.
 */
export async function syncCarePlanSchedule(planId: string, from = new Date()): Promise<CarePlan | null> {
  const plan = await prisma.carePlan.findUnique({ where: { id: planId } });
  if (!plan) return null;

  const reviewsOff = plan.status === "CHURNED" || plan.reviewEveryMonths <= 0;
  return prisma.carePlan.update({
    where: { id: planId },
    data: {
      nextBillingAt: plan.autoInvoice ? computeNextBillingAt(plan, from) : null,
      nextReviewAt: reviewsOff ? null : (plan.nextReviewAt ?? computeNextReviewAt(plan, plan.lastReviewAt ?? plan.startedAt)),
    },
  });
}

// --- Hours -----------------------------------------------------------------

/**
 * Billable hours logged against the plan's project inside a window. A plan
 * with no project has no hours to count — there is nowhere to log them — and
 * returns zero rather than pretending the question is unanswerable.
 */
export async function hoursIn(plan: Pick<CarePlan, "projectId">, from: Date, to: Date): Promise<number> {
  if (!plan.projectId) return 0;
  const total = await prisma.timeEntry.aggregate({
    where: { projectId: plan.projectId, billable: true, date: { gte: from, lt: to } },
    _sum: { hours: true },
  });
  return Number(total._sum.hours ?? 0);
}

function overageFor(hoursUsed: number, includedHours: Prisma.Decimal | null, rate: Prisma.Decimal | null) {
  const included = includedHours === null ? null : Number(includedHours);
  const hours = included === null ? 0 : Math.max(0, Math.round((hoursUsed - included) * 100) / 100);
  const amount = rate === null ? 0 : Math.round(hours * Number(rate) * 100) / 100;
  return { overageHours: hours, overageAmount: amount };
}

// --- Billing ---------------------------------------------------------------

export type BillOutcome =
  | { billed: true; invoiceId: string; invoiceNumber: string; periodStart: Date; amountTotal: number }
  | { billed: false; reason: "already-billed" | "not-active" | "not-due"; periodStart?: Date };

function monthLabel(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, month: "long", year: "numeric" }).format(at);
}

/**
 * Raises one invoice for one period, and settles the period before it.
 * Idempotent by construction: a cycle already recorded for `periodStart` means
 * this month is paid for, whatever made us ask again.
 */
export async function billPeriod(planId: string, periodStart: Date): Promise<BillOutcome> {
  const plan = await prisma.carePlan.findUnique({ where: { id: planId }, include: { client: true } });
  if (!plan) throw new Error("Care plan not found");
  if (plan.status !== "ACTIVE") return { billed: false, reason: "not-active" };

  const zone = safeZone(plan.timezone);
  const periodEnd = nextPeriodStart(periodStart, zone, plan.billingDay);

  const existing = await prisma.carePlanCycle.findUnique({
    where: { carePlanId_periodStart: { carePlanId: plan.id, periodStart } },
  });
  if (existing) return { billed: false, reason: "already-billed", periodStart };

  // The cycle that just closed, if any, is settled onto this invoice.
  const previous = await prisma.carePlanCycle.findFirst({
    where: { carePlanId: plan.id, periodStart: { lt: periodStart }, settledAt: null },
    orderBy: { periodStart: "desc" },
  });

  let settlement: { cycle: CarePlanCycle; hoursUsed: number; overageHours: number; overageAmount: number } | null = null;
  if (previous) {
    const hoursUsed = await hoursIn(plan, previous.periodStart, previous.periodEnd);
    const { overageHours, overageAmount } = overageFor(hoursUsed, previous.includedHours, plan.overageHourlyRate);
    settlement = { cycle: previous, hoursUsed, overageHours, overageAmount };
  }

  const lineItems = [
    {
      description: `${TIER_LABEL[plan.tier]} care plan — ${monthLabel(periodStart, zone)}`,
      quantity: new Prisma.Decimal(1),
      unitPrice: plan.monthlyFee,
      amount: plan.monthlyFee,
    },
  ];
  if (settlement && settlement.overageAmount > 0) {
    const included = Number(settlement.cycle.includedHours ?? 0);
    lineItems.push({
      description:
        `Additional hours — ${monthLabel(settlement.cycle.periodStart, zone)} ` +
        `(${settlement.hoursUsed} used, ${included} included)`,
      quantity: new Prisma.Decimal(settlement.overageHours),
      unitPrice: plan.overageHourlyRate ?? new Prisma.Decimal(0),
      amount: new Prisma.Decimal(settlement.overageAmount),
    });
  }
  const amountTotal = lineItems.reduce((sum, item) => sum + Number(item.amount), 0);

  const issueDate = new Date();
  const dueDate = new Date(issueDate.getTime() + plan.dueDays * 24 * 60 * 60_000);

  const invoice = await createNumberedInvoice(
    (invoiceNumber) =>
      prisma.$transaction(async (tx) => {
        const created = await tx.invoice.create({
          data: {
            clientId: plan.clientId,
            projectId: plan.projectId,
            carePlanId: plan.id,
            invoiceNumber,
            currency: plan.currency,
            amountTotal,
            issueDate,
            dueDate,
            lineItems: { create: lineItems },
          },
        });

        await tx.carePlanCycle.create({
          data: {
            carePlanId: plan.id,
            periodStart,
            periodEnd,
            monthlyFee: plan.monthlyFee,
            includedHours: plan.includedHours,
            invoiceId: created.id,
          },
        });

        if (settlement) {
          await tx.carePlanCycle.update({
            where: { id: settlement.cycle.id },
            data: {
              hoursUsed: new Prisma.Decimal(settlement.hoursUsed),
              overageHours: new Prisma.Decimal(settlement.overageHours),
              overageAmount: new Prisma.Decimal(settlement.overageAmount),
              settledAt: issueDate,
            },
          });
        }

        await tx.carePlan.update({ where: { id: plan.id }, data: { lastBilledAt: issueDate } });
        return created;
      }),
    issueDate,
  );

  return { billed: true, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, periodStart, amountTotal };
}

/**
 * The periods this plan owes an invoice for, oldest first. Normally one — the
 * month starting today. More only after an outage long enough to miss a
 * billing day, which is exactly when nobody should have to notice by hand.
 */
export async function unbilledPeriods(plan: CarePlan, now = new Date()): Promise<Date[]> {
  const zone = safeZone(plan.timezone);
  const day = normaliseBillingDay(plan.billingDay);
  const current = currentPeriodStart(now, zone, day);

  const last = await prisma.carePlanCycle.findFirst({
    where: { carePlanId: plan.id },
    orderBy: { periodStart: "desc" },
  });

  let period: Date;
  if (last) {
    period = nextPeriodStart(last.periodStart, zone, day);
  } else {
    // Never charge for time before the plan existed. A plan signed on the 20th
    // with a billing day of the 15th is not back-charged for the month that
    // began on the 15th — it starts paying on the next one.
    const containing = currentPeriodStart(plan.startedAt, zone, day);
    const startedOnBillingDay = zonedDateParts(plan.startedAt, zone)[2] === day;
    period = startedOnBillingDay ? containing : nextPeriodStart(containing, zone, day);
  }

  const periods: Date[] = [];
  while (period.getTime() <= current.getTime() && periods.length < MAX_CATCHUP_PERIODS) {
    periods.push(period);
    period = nextPeriodStart(period, zone, day);
  }
  return periods;
}

/** Bills whatever this plan owes right now, on demand. Used by the "Bill now" button. */
export async function billPlanNow(planId: string, now = new Date()): Promise<BillOutcome[]> {
  const plan = await prisma.carePlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("Care plan not found");
  if (plan.status !== "ACTIVE") return [{ billed: false, reason: "not-active" }];

  const periods = await unbilledPeriods(plan, now);
  if (periods.length === 0) {
    // "Nothing owed" has two quite different meanings, and the page says which.
    const zone = safeZone(plan.timezone);
    const billed = await prisma.carePlanCycle.findUnique({
      where: { carePlanId_periodStart: { carePlanId: plan.id, periodStart: currentPeriodStart(now, zone, plan.billingDay) } },
    });
    return [{ billed: false, reason: billed ? "already-billed" : "not-due" }];
  }

  const outcomes: BillOutcome[] = [];
  for (const period of periods) outcomes.push(await billPeriod(plan.id, period));

  // A manual bill spends the scheduled slot too, or the plan bills again hours later.
  await prisma.carePlan.update({
    where: { id: plan.id },
    data: { nextBillingAt: plan.autoInvoice ? computeNextBillingAt(plan, now) : null },
  });
  return outcomes;
}

/**
 * The scheduler's half. Runs every minute; does nothing on all but one morning
 * a month per plan.
 *
 * Unlike lead capture, a missed slot is *not* skipped. A scrape missed by six
 * hours is stale and worth dropping; an invoice missed by six hours is money,
 * and the period it belongs to is fixed by the calendar rather than by when
 * the process happened to be alive.
 */
export async function billDuePlans(now = new Date()): Promise<void> {
  // Plans saved before this feature existed, or while the server was down.
  const unscheduled = await prisma.carePlan.findMany({
    where: { status: "ACTIVE", autoInvoice: true, nextBillingAt: null },
  });
  for (const plan of unscheduled) {
    await prisma.carePlan.update({
      where: { id: plan.id },
      data: { nextBillingAt: computeNextBillingAt(plan, now), nextReviewAt: plan.nextReviewAt ?? computeNextReviewAt(plan, plan.startedAt) },
    });
  }

  const due = await prisma.carePlan.findMany({
    where: { status: "ACTIVE", autoInvoice: true, nextBillingAt: { lte: now } },
  });

  for (const plan of due) {
    // Spend the slot before doing the work: whatever happens below, this
    // morning's billing run must not be attempted twice.
    await prisma.carePlan.update({ where: { id: plan.id }, data: { nextBillingAt: computeNextBillingAt(plan, now) } });

    try {
      const periods = await unbilledPeriods(plan, now);
      for (const period of periods) {
        const outcome = await billPeriod(plan.id, period);
        if (outcome.billed) {
          console.log(`[billing] ${outcome.invoiceNumber} raised for care plan ${plan.id} (${outcome.amountTotal})`);
        }
      }
    } catch (err) {
      // The slot is spent, but the period is not billed and `unbilledPeriods`
      // will find it again next month — or sooner, via "Bill now".
      console.error(`[billing] Could not bill care plan ${plan.id}:`, (err as Error).message);
    }
  }
}
