-- CreateEnum
CREATE TYPE "SlackDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'DELIVERED', 'RETRYING', 'FAILED', 'SUPERSEDED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "SlackDeliveryKind" AS ENUM ('POST', 'UPDATE', 'SETTLE');

-- CreateTable
CREATE TABLE "SlackDelivery" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "orderKey" TEXT,
    "coalesceKey" TEXT,
    "seq" INTEGER NOT NULL,
    "kind" "SlackDeliveryKind" NOT NULL,
    "status" "SlackDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "channel" TEXT,
    "ts" TEXT,
    "text" TEXT NOT NULL,
    "blocks" JSONB,
    "threadTs" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "permanent" BOOLEAN NOT NULL DEFAULT false,
    "retriedById" TEXT,
    "retriedAt" TIMESTAMP(3),
    "subjectType" TEXT,
    "subjectId" TEXT,
    "firstTriedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlackDelivery_idempotencyKey_key" ON "SlackDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SlackDelivery_status_nextAttemptAt_idx" ON "SlackDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SlackDelivery_orderKey_seq_idx" ON "SlackDelivery"("orderKey", "seq");

-- CreateIndex
CREATE INDEX "SlackDelivery_subjectType_subjectId_idx" ON "SlackDelivery"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "SlackDelivery_status_createdAt_idx" ON "SlackDelivery"("status", "createdAt");
