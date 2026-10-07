-- CreateEnum
CREATE TYPE "ScheduledPublishStatus" AS ENUM ('PENDING', 'RUNNING', 'ACTIVE_TEMPORARY', 'REVERTING', 'COMPLETED', 'REVERTED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ScheduledPublish" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "status" "ScheduledPublishStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "revertAt" TIMESTAMP(3),
    "draftRevision" INTEGER NOT NULL,
    "revertToVersionId" TEXT,
    "publishedVersionId" TEXT,
    "notes" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "executedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledPublish_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledPublish_status_scheduledAt_idx" ON "ScheduledPublish"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledPublish_pageId_createdAt_idx" ON "ScheduledPublish"("pageId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScheduledPublish" ADD CONSTRAINT "ScheduledPublish_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPublish" ADD CONSTRAINT "ScheduledPublish_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "SitePage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPublish" ADD CONSTRAINT "ScheduledPublish_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row-level security, as on the tables of the 19 Aug 2026 hardening.
ALTER TABLE "ScheduledPublish" ENABLE ROW LEVEL SECURITY;
