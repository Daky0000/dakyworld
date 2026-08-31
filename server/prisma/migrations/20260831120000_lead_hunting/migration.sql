-- CreateEnum
CREATE TYPE "LeadHuntStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadVerdictKind" AS ENUM ('QUALIFIED', 'REJECTED', 'UNDECIDED');

-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retryReason" TEXT;

-- CreateTable
CREATE TABLE "LeadThesis" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "offer" TEXT NOT NULL,
    "qualifiers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disqualifiers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minScore" INTEGER NOT NULL DEFAULT 55,
    "leadsPerRun" INTEGER NOT NULL DEFAULT 5,
    "runTimes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
    "sourceId" TEXT,
    "routePriority" INTEGER NOT NULL DEFAULT 2,
    "routeAgentKey" TEXT,
    "deleteRejected" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "seedRevision" INTEGER NOT NULL DEFAULT 1,
    "editedAt" TIMESTAMP(3),
    "custom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadThesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadHunt" (
    "id" TEXT NOT NULL,
    "thesisId" TEXT NOT NULL,
    "status" "LeadHuntStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "ScraperRunTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "scraperRunId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "captured" INTEGER NOT NULL DEFAULT 0,
    "audited" INTEGER NOT NULL DEFAULT 0,
    "qualified" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "routed" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "summary" TEXT,
    "error" TEXT,

    CONSTRAINT "LeadHunt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadVerdict" (
    "id" TEXT NOT NULL,
    "thesisId" TEXT NOT NULL,
    "huntId" TEXT,
    "leadId" TEXT,
    "companyName" TEXT,
    "website" TEXT,
    "city" TEXT,
    "dedupeKey" TEXT,
    "verdict" "LeadVerdictKind" NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "signals" JSONB,
    "reason" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadThesis_key_key" ON "LeadThesis"("key");

-- CreateIndex
CREATE INDEX "LeadThesis_enabled_nextRunAt_idx" ON "LeadThesis"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "LeadHunt_thesisId_startedAt_idx" ON "LeadHunt"("thesisId", "startedAt");

-- CreateIndex
CREATE INDEX "LeadHunt_status_idx" ON "LeadHunt"("status");

-- CreateIndex
CREATE INDEX "LeadVerdict_dedupeKey_idx" ON "LeadVerdict"("dedupeKey");

-- CreateIndex
CREATE INDEX "LeadVerdict_verdict_createdAt_idx" ON "LeadVerdict"("verdict", "createdAt");

-- CreateIndex
CREATE INDEX "LeadVerdict_leadId_idx" ON "LeadVerdict"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadVerdict_thesisId_dedupeKey_key" ON "LeadVerdict"("thesisId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "LeadThesis" ADD CONSTRAINT "LeadThesis_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ScraperSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadHunt" ADD CONSTRAINT "LeadHunt_thesisId_fkey" FOREIGN KEY ("thesisId") REFERENCES "LeadThesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadVerdict" ADD CONSTRAINT "LeadVerdict_thesisId_fkey" FOREIGN KEY ("thesisId") REFERENCES "LeadThesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadVerdict" ADD CONSTRAINT "LeadVerdict_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "LeadHunt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadVerdict" ADD CONSTRAINT "LeadVerdict_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

