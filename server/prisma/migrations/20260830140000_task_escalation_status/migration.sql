-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('PENDING', 'ANSWERED', 'CLOSED');

-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "escalationStatus" "EscalationStatus";

-- CreateIndex
CREATE INDEX "AgentTask_escalationStatus_finishedAt_idx" ON "AgentTask"("escalationStatus", "finishedAt");

