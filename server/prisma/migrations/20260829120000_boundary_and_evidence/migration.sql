-- Boundary enforcement, and the four places a rehearsal's output is kept.
--
-- `schema.prisma` gained all of this in "Rehearsal Workflow v2" and no
-- migration came with it, so `prisma migrate deploy` had nothing to apply on
-- the next deploy while the generated client selected columns the live
-- database did not have. That build failed on TypeScript before it got that
-- far; this is the second half of the same commit.

-- What an agent is *not* for, and how many times it has reached for it anyway.
-- Both default so that every existing agent row starts with no boundaries and
-- a clean count, which is the behaviour before this migration.
ALTER TABLE "Agent" ADD COLUMN "boundaryViolations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Agent" ADD COLUMN "not_responsible" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Evidence bundles: what was actually observed about a lead, and where it came
-- from. `source` is indexed because the question asked of this table is nearly
-- always "the screenshots" or "the performance run", not one row by id.
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "filepath" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PdfReport" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "filepath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "PdfReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailDraft" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "draftedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "EmailDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoutingObject" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "object" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingObject_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Evidence_leadId_idx" ON "Evidence"("leadId");
CREATE INDEX "Evidence_source_idx" ON "Evidence"("source");
CREATE INDEX "PdfReport_leadId_idx" ON "PdfReport"("leadId");
CREATE INDEX "EmailDraft_leadId_idx" ON "EmailDraft"("leadId");
CREATE INDEX "RoutingObject_leadId_idx" ON "RoutingObject"("leadId");

-- All four cascade: they are about one lead and are meaningless without it,
-- and a deleted lead must not leave a screenshot or a drafted letter behind.
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PdfReport" ADD CONSTRAINT "PdfReport_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailDraft" ADD CONSTRAINT "EmailDraft_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutingObject" ADD CONSTRAINT "RoutingObject_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
