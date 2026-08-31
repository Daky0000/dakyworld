-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "escalationResolvedAt" TIMESTAMP(3),
ADD COLUMN     "escalationNote" TEXT;

-- Backfill: every escalation that is already ANSWERED or CLOSED was resolved
-- at some point in the past and nothing recorded when. `finishedAt` is the
-- closest honest stamp available for a task that stopped and was dealt with —
-- it is when the run that asked ended. Rows with no `finishedAt` are left null
-- rather than given "now", which would report a months-old question as
-- resolved this minute.
UPDATE "AgentTask"
SET "escalationResolvedAt" = "finishedAt"
WHERE "escalationStatus" IN ('ANSWERED', 'CLOSED')
  AND "finishedAt" IS NOT NULL;
