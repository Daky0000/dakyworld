-- Context, approvals, standing work, and the two Ghanaian payment rails.
--
-- ContextNote   — the part of a company's history that no other table holds.
--                 The dossier itself is assembled at read time from the audit,
--                 email, proposal and invoice rows that already exist, so there
--                 is no backfill here and nothing to keep in step.
-- ActionRequest — an outward action an agent prepared and could not carry out.
--                 It holds the *validated* input, so approving re-invokes what
--                 was proposed rather than asking a model for it a second time.
-- AgentSchedule — a recurring brief. AgentTaskOrigin.SCHEDULE has existed since
--                 the runtime shipped and nothing has ever written it.
-- Invoice        — paymentProvider/Ref/Url/paidVia. An invoice used to print
--                 with no way to pay it.

-- CreateEnum
CREATE TYPE "ContextNoteKind" AS ENUM ('NOTE', 'CALL', 'MEETING', 'REPLY', 'DECISION', 'OUTCOME', 'RISK');

-- CreateEnum
CREATE TYPE "ActionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTED', 'FAILED', 'DECLINED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "promptText" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "paidVia" TEXT,
ADD COLUMN     "paymentProvider" TEXT,
ADD COLUMN     "paymentRef" TEXT,
ADD COLUMN     "paymentUrl" TEXT;

-- CreateTable
CREATE TABLE "ContextNote" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "kind" "ContextNoteKind" NOT NULL DEFAULT 'NOTE',
    "summary" TEXT NOT NULL,
    "body" TEXT,
    "authorKey" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSchedule" (
    "id" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "runTimes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
    "weekdaysOnly" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxOpenTasks" INTEGER NOT NULL DEFAULT 1,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionRequest" (
    "id" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "taskId" TEXT,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "wouldDo" TEXT NOT NULL,
    "heldBecause" TEXT,
    "why" TEXT NOT NULL,
    "gain" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "status" "ActionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedBySlackUser" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "result" JSONB,
    "error" TEXT,
    "costUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "slackChannel" TEXT,
    "slackTs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContextNote_subject_occurredAt_idx" ON "ContextNote"("subject", "occurredAt");

-- CreateIndex
CREATE INDEX "ContextNote_subject_pinned_idx" ON "ContextNote"("subject", "pinned");

-- CreateIndex
CREATE INDEX "AgentSchedule_enabled_nextRunAt_idx" ON "AgentSchedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "AgentSchedule_agentKey_idx" ON "AgentSchedule"("agentKey");

-- CreateIndex
CREATE INDEX "ActionRequest_status_createdAt_idx" ON "ActionRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ActionRequest_agentKey_status_idx" ON "ActionRequest"("agentKey", "status");

-- CreateIndex
CREATE INDEX "ActionRequest_taskId_idx" ON "ActionRequest"("taskId");

-- CreateIndex
CREATE INDEX "Invoice_paymentRef_idx" ON "Invoice"("paymentRef");

-- AddForeignKey
ALTER TABLE "AgentSchedule" ADD CONSTRAINT "AgentSchedule_agentKey_fkey" FOREIGN KEY ("agentKey") REFERENCES "Agent"("key") ON DELETE CASCADE ON UPDATE CASCADE;

