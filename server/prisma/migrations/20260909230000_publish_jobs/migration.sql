CREATE TYPE "PublishJobState" AS ENUM ('QUEUED', 'VALIDATING', 'COMMITTING', 'COMMITTED', 'DEPLOYING', 'VERIFYING', 'COMPLETED', 'CONFLICT', 'COMMIT_FAILED', 'DEPLOY_FAILED', 'VERIFY_FAILED', 'RECONCILIATION_REQUIRED');

CREATE TABLE "PublishJob" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "pageId" TEXT,
  "sharedElementId" TEXT,
  "kind" TEXT NOT NULL,
  "state" "PublishJobState" NOT NULL DEFAULT 'QUEUED',
  "detail" JSONB NOT NULL DEFAULT '{}',
  "commitSha" TEXT,
  "commitUrl" TEXT,
  "verifyUrl" TEXT,
  "verifyText" TEXT,
  "expectedHash" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextCheckAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "startedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "PublishJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PublishJob_siteId_createdAt_idx" ON "PublishJob"("siteId", "createdAt");
CREATE INDEX "PublishJob_state_nextCheckAt_idx" ON "PublishJob"("state", "nextCheckAt");

ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "SitePage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
