-- The rehearsal room: one workflow, one real website, nothing able to leave
-- the building.
--
-- Two boolean flags and one table. The flags are the safety; the table is only
-- bookkeeping, so that a run can be found again, totalled, and torn down.

-- CreateEnum
CREATE TYPE "RehearsalStatus" AS ENUM ('RUNNING', 'SETTLED', 'STOPPED');

-- AlterTable
--
-- Read in exactly one place: the runner's tool wrapper passes it to
-- invokeTool as `dryRun`, so every outward or spending call in a rehearsal
-- stops at a preview regardless of the agent's autonomy. Inherited by every
-- task `delegate` and `handOff` create, which is what makes it hold across a
-- run that fans out to nine agents.
ALTER TABLE "AgentTask" ADD COLUMN "rehearsal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
--
-- The scratch lead a rehearsal works on. Real, because the workflow under test
-- takes a lead id and a fake one would be testing something else; marked,
-- because it is not in the pipeline and must never reach a sequence.
ALTER TABLE "Lead" ADD COLUMN "rehearsal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Rehearsal" (
    "id" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "businessName" TEXT,
    "scenario" TEXT NOT NULL,
    "note" TEXT,
    "status" "RehearsalStatus" NOT NULL DEFAULT 'RUNNING',
    "leadId" TEXT,
    "rootTaskId" TEXT,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "taskCount" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "preparedCalls" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rehearsal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Rehearsal_leadId_key" ON "Rehearsal"("leadId");

-- CreateIndex
CREATE INDEX "Rehearsal_status_startedAt_idx" ON "Rehearsal"("status", "startedAt");

-- CreateIndex
CREATE INDEX "Rehearsal_createdAt_idx" ON "Rehearsal"("createdAt");

-- AddForeignKey
ALTER TABLE "Rehearsal" ADD CONSTRAINT "Rehearsal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rehearsal" ADD CONSTRAINT "Rehearsal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security, per the house rule set in 20260819180100_row_level_security:
-- every table denies every role but the one the application connects as.
--
-- The three mail tables are enrolled here too. They arrived in
-- 20260821140000_mail_room and were never added, which left every message
-- anybody has ever sent this company readable by any other role that reached
-- the database — the exact hole that migration's predecessor was written to
-- close.
ALTER TABLE "Rehearsal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MailThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MailMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MailSyncState" ENABLE ROW LEVEL SECURITY;
