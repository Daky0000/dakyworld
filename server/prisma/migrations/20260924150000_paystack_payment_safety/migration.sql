-- AlterTable
ALTER TABLE "WebsitePurchase" ADD COLUMN     "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "billingPriceUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "billingState" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "checkoutFingerprint" TEXT,
ADD COLUMN     "checkoutKey" TEXT,
ADD COLUMN     "promoEndsAt" TIMESTAMP(3),
ADD COLUMN     "recurringConsentAt" TIMESTAMP(3),
ADD COLUMN     "standardRecurringPrice" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "email" TEXT,
    "url" TEXT,
    "state" TEXT NOT NULL DEFAULT 'INITIALIZING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaystackEvent" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "handledAt" TIMESTAMP(3),
    "nextTryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaystackEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReceipt" (
    "reference" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("reference")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_invoiceId_key" ON "PaymentAttempt"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_reference_key" ON "PaymentAttempt"("reference");

-- CreateIndex
CREATE INDEX "PaystackEvent_handledAt_nextTryAt_idx" ON "PaystackEvent"("handledAt", "nextTryAt");

-- CreateIndex
CREATE INDEX "PaymentReceipt_purchaseId_idx" ON "PaymentReceipt"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "WebsitePurchase_checkoutKey_key" ON "WebsitePurchase"("checkoutKey");
