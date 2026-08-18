-- CreateEnum
CREATE TYPE "AgentTaskOrigin" AS ENUM ('OWNER', 'SCHEDULE', 'EVENT', 'AGENT');

-- CreateEnum
CREATE TYPE "AgentTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'NEEDS_APPROVAL', 'BLOCKED', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentStepKind" AS ENUM ('STARTED', 'THOUGHT', 'TOOL_CALL', 'PREPARED', 'REFUSED', 'DELEGATED', 'REMEMBERED', 'BLOCKED', 'FINISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentMemoryKind" AS ENUM ('DECISION', 'OUTCOME', 'FACT', 'LESSON', 'PREFERENCE');

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "input" JSONB,
    "origin" "AgentTaskOrigin" NOT NULL DEFAULT 'OWNER',
    "createdById" TEXT,
    "parentId" TEXT,
    "status" "AgentTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "scheduledFor" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "result" JSONB,
    "blockedReason" TEXT,
    "error" TEXT,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "dryRunCalls" INTEGER NOT NULL DEFAULT 0,
    "leadId" TEXT,
    "clientId" TEXT,
    "projectId" TEXT,
    "proposalId" TEXT,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTaskStep" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "AgentStepKind" NOT NULL,
    "message" TEXT NOT NULL,
    "tool" TEXT,
    "toolCallId" TEXT,
    "ok" BOOLEAN,
    "dryRun" BOOLEAN,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTaskStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "kind" "AgentMemoryKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "sourceTaskId" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTask_agentKey_status_idx" ON "AgentTask"("agentKey", "status");

-- CreateIndex
CREATE INDEX "AgentTask_status_priority_scheduledFor_idx" ON "AgentTask"("status", "priority", "scheduledFor");

-- CreateIndex
CREATE INDEX "AgentTask_createdAt_idx" ON "AgentTask"("createdAt");

-- CreateIndex
CREATE INDEX "AgentTask_parentId_idx" ON "AgentTask"("parentId");

-- CreateIndex
CREATE INDEX "AgentTaskStep_taskId_seq_idx" ON "AgentTaskStep"("taskId", "seq");

-- CreateIndex
CREATE INDEX "AgentMemory_agentKey_subject_idx" ON "AgentMemory"("agentKey", "subject");

-- CreateIndex
CREATE INDEX "AgentMemory_agentKey_createdAt_idx" ON "AgentMemory"("agentKey", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_agentKey_fkey" FOREIGN KEY ("agentKey") REFERENCES "Agent"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AgentTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTaskStep" ADD CONSTRAINT "AgentTaskStep_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_agentKey_fkey" FOREIGN KEY ("agentKey") REFERENCES "Agent"("key") ON DELETE CASCADE ON UPDATE CASCADE;

