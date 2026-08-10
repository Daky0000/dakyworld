-- Care plan billing: schedules, review cadence, and the cycle ledger.

-- AlterTable
ALTER TABLE "CarePlan"
    DROP COLUMN "hoursUsedThisCycle",
    ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
    ADD COLUMN     "autoInvoice" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN     "dueDays" INTEGER NOT NULL DEFAULT 14,
    ADD COLUMN     "nextBillingAt" TIMESTAMP(3),
    ADD COLUMN     "lastBilledAt" TIMESTAMP(3),
    ADD COLUMN     "overageHourlyRate" DECIMAL(12,2),
    ADD COLUMN     "reviewEveryMonths" INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN     "nextReviewAt" TIMESTAMP(3),
    ADD COLUMN     "lastReviewAt" TIMESTAMP(3),
    ADD COLUMN     "pausedAt" TIMESTAMP(3),
    ADD COLUMN     "churnReason" TEXT,
    ADD COLUMN     "notes" TEXT;

-- CreateTable
CREATE TABLE "CarePlanCycle" (
    "id" TEXT NOT NULL,
    "carePlanId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "monthlyFee" DECIMAL(12,2) NOT NULL,
    "includedHours" DECIMAL(6,2),
    "hoursUsed" DECIMAL(6,2),
    "overageHours" DECIMAL(6,2),
    "overageAmount" DECIMAL(12,2),
    "settledAt" TIMESTAMP(3),
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarePlanCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CarePlanCycle_invoiceId_key" ON "CarePlanCycle"("invoiceId");

-- CreateIndex: the guard against billing the same month twice.
CREATE UNIQUE INDEX "CarePlanCycle_carePlanId_periodStart_key" ON "CarePlanCycle"("carePlanId", "periodStart");

-- AddForeignKey
ALTER TABLE "CarePlanCycle" ADD CONSTRAINT "CarePlanCycle_carePlanId_fkey" FOREIGN KEY ("carePlanId") REFERENCES "CarePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarePlanCycle" ADD CONSTRAINT "CarePlanCycle_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
