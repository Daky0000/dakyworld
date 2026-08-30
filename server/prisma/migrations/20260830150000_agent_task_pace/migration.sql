-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "maxTasksPerDay" INTEGER,
ADD COLUMN     "maxTasksPerMonth" INTEGER,
ADD COLUMN     "maxTasksPerWeek" INTEGER;

-- CreateIndex
CREATE INDEX "AgentTask_agentKey_startedAt_idx" ON "AgentTask"("agentKey", "startedAt");

