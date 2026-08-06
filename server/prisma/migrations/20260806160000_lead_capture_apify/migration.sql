-- CreateEnum
CREATE TYPE "ScraperPreset" AS ENUM ('AUTO', 'GOOGLE_MAPS', 'GENERIC_CONTACT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ScraperRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "ScraperRunTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- The four new "LeadSource" values this migration relies on were added by
-- 20260806155900_lead_source_machine_values, which has to commit first.

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "address" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "enrichment" JSONB,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "rating" DECIMAL(3,2),
ADD COLUMN     "region" TEXT,
ADD COLUMN     "reviewsCount" INTEGER,
ADD COLUMN     "scraperRunId" TEXT,
ADD COLUMN     "scraperSourceId" TEXT,
ADD COLUMN     "socialLinks" JSONB,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "website" TEXT;

-- CreateTable
CREATE TABLE "LeadGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "autoCreated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScraperSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "description" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "fieldMap" JSONB,
    "preset" "ScraperPreset" NOT NULL DEFAULT 'AUTO',
    "leadSource" "LeadSource" NOT NULL DEFAULT 'GOOGLE_MAPS',
    "groupName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maxItems" INTEGER NOT NULL DEFAULT 100,
    "minScore" INTEGER NOT NULL DEFAULT 0,
    "autoQualify" BOOLEAN NOT NULL DEFAULT true,
    "qualifyScore" INTEGER NOT NULL DEFAULT 60,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scheduleTimes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScraperSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScraperRun" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "apifyRunId" TEXT,
    "datasetId" TEXT,
    "status" "ScraperRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "ScraperRunTrigger" NOT NULL DEFAULT 'MANUAL',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "itemsFetched" INTEGER NOT NULL DEFAULT 0,
    "leadsCreated" INTEGER NOT NULL DEFAULT 0,
    "leadsUpdated" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "filtered" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "input" JSONB,

    CONSTRAINT "ScraperRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadGroup_slug_key" ON "LeadGroup"("slug");

-- CreateIndex
CREATE INDEX "ScraperSource_enabled_scheduleEnabled_idx" ON "ScraperSource"("enabled", "scheduleEnabled");

-- CreateIndex
CREATE INDEX "ScraperRun_sourceId_startedAt_idx" ON "ScraperRun"("sourceId", "startedAt");

-- CreateIndex
CREATE INDEX "ScraperRun_status_idx" ON "ScraperRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_dedupeKey_key" ON "Lead"("dedupeKey");

-- CreateIndex
CREATE INDEX "Lead_groupId_idx" ON "Lead"("groupId");

-- CreateIndex
CREATE INDEX "Lead_scraperRunId_idx" ON "Lead"("scraperRunId");

-- CreateIndex
CREATE INDEX "Lead_source_createdAt_idx" ON "Lead"("source", "createdAt");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LeadGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_scraperSourceId_fkey" FOREIGN KEY ("scraperSourceId") REFERENCES "ScraperSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_scraperRunId_fkey" FOREIGN KEY ("scraperRunId") REFERENCES "ScraperRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScraperRun" ADD CONSTRAINT "ScraperRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ScraperSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

