CREATE TABLE "SiteAsset" (
  "id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL REFERENCES "Site"("id") ON DELETE CASCADE,
  "filename" TEXT NOT NULL, "repoPath" TEXT NOT NULL, "contentType" TEXT NOT NULL, "content" BYTEA NOT NULL,
  "alt" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SiteAsset_siteId_repoPath_key" ON "SiteAsset"("siteId", "repoPath");
CREATE TABLE "SiteAuditEvent" (
  "id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL REFERENCES "Site"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL, "summary" TEXT NOT NULL, "actorName" TEXT NOT NULL, "actorId" TEXT,
  "detail" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SiteAuditEvent_siteId_createdAt_idx" ON "SiteAuditEvent"("siteId", "createdAt");
