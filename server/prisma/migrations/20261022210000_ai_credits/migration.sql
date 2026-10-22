-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aiCreditsBought" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WebsiteWorkJob" ADD COLUMN     "creditsBought" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditsPlan" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditLimit" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AiCreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCreditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCreditEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "planDelta" INTEGER NOT NULL DEFAULT 0,
    "boughtDelta" INTEGER NOT NULL DEFAULT 0,
    "siteId" TEXT,
    "jobId" TEXT,
    "invoiceId" TEXT,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCreditPurchase_invoiceId_key" ON "AiCreditPurchase"("invoiceId");

-- CreateIndex
CREATE INDEX "AiCreditPurchase_userId_createdAt_idx" ON "AiCreditPurchase"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCreditEntry_userId_createdAt_idx" ON "AiCreditEntry"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiCreditPurchase" ADD CONSTRAINT "AiCreditPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCreditEntry" ADD CONSTRAINT "AiCreditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
