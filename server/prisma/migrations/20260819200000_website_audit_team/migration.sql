-- One run of the website audit team over one site.
--
-- Audits accumulate rather than replace: reviewing the same site again in
-- three months writes a second row, and the pair is the only evidence there is
-- that the work actually changed something. That is why there is no unique
-- index on leadId — the ordered pair (leadId, ranAt) is what gets read.
--
-- The PDF, the Markdown and the screenshots are StoredFile rows referenced
-- from here, and both file references are ON DELETE SET NULL rather than
-- CASCADE: deleting a file should cost the report its attachment, never the
-- findings.

-- CreateTable
CREATE TABLE "WebsiteAudit" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "businessName" TEXT NOT NULL,
    "website" TEXT,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overallScore" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "markdown" TEXT NOT NULL,
    "pdfFileId" TEXT,
    "markdownFileId" TEXT,
    "screenshots" JSONB,
    "costUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebsiteAudit_leadId_ranAt_idx" ON "WebsiteAudit"("leadId", "ranAt");

-- CreateIndex
CREATE INDEX "WebsiteAudit_ranAt_idx" ON "WebsiteAudit"("ranAt");

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_pdfFileId_fkey" FOREIGN KEY ("pdfFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_markdownFileId_fkey" FOREIGN KEY ("markdownFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security, on the same terms as every other table: deny by default
-- for every role except the one the application connects as, which owns the
-- table and is therefore exempt unless FORCE is set. See the comment in
-- 20260819180100_row_level_security. A new table without this line is a hole
-- in that policy, and the hole is silent.
ALTER TABLE "WebsiteAudit" ENABLE ROW LEVEL SECURITY;
