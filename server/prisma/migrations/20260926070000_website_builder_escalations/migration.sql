-- CreateTable
CREATE TABLE "WebsiteEscalation" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "pageId" TEXT,
    "pageTitle" TEXT,
    "userPrompt" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "agentNotes" TEXT NOT NULL,
    "userEmail" TEXT,
    "userName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "ownerNotes" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebsiteEscalation_siteId_status_idx" ON "WebsiteEscalation"("siteId", "status");

-- CreateIndex
CREATE INDEX "WebsiteEscalation_status_createdAt_idx" ON "WebsiteEscalation"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "WebsiteEscalation" ADD CONSTRAINT "WebsiteEscalation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
