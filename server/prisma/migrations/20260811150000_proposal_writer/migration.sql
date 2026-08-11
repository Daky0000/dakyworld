-- The argued proposal document, the evidence it rests on, and who wrote it.
-- All nullable: proposals written by hand keep working and render from
-- scopeSummary alone.
ALTER TABLE "Proposal" ADD COLUMN "body" JSONB;
ALTER TABLE "Proposal" ADD COLUMN "audit" JSONB;
ALTER TABLE "Proposal" ADD COLUMN "generatedBy" TEXT;
ALTER TABLE "Proposal" ADD COLUMN "confidence" DOUBLE PRECISION;
