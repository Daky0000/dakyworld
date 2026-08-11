-- How each lead got into the system, so the Leads page can tag and filter by it.
CREATE TYPE "LeadCaptureMethod" AS ENUM ('MANUAL', 'APIFY', 'EXCEL', 'CSV', 'GOOGLE_SHEET', 'PDF', 'DOCUMENT', 'API', 'OTHER');

ALTER TABLE "Lead" ADD COLUMN "captureMethod" "LeadCaptureMethod" NOT NULL DEFAULT 'MANUAL';

-- Backfill from the trail each route already leaves, so existing leads are
-- tagged the same way new ones will be rather than all reading as MANUAL.

-- A scrape is the one route that links straight from the lead.
UPDATE "Lead"
SET "captureMethod" = 'APIFY'
WHERE "scraperSourceId" IS NOT NULL OR "scraperRunId" IS NOT NULL;

-- An import links through the batch it created. The file name decides between
-- Excel and CSV; a native Google Sheet has no file name at all.
UPDATE "Lead" AS l
SET "captureMethod" = CASE
  WHEN i."source" = 'GOOGLE_SHEET' THEN 'GOOGLE_SHEET'::"LeadCaptureMethod"
  WHEN lower(coalesce(i."fileName", '')) LIKE '%.csv' THEN 'CSV'::"LeadCaptureMethod"
  WHEN lower(coalesce(i."fileName", '')) LIKE '%.tsv' THEN 'CSV'::"LeadCaptureMethod"
  ELSE 'EXCEL'::"LeadCaptureMethod"
END
FROM "LeadGroup" AS g
JOIN "LeadImport" AS i ON i."id" = g."leadImportId"
WHERE l."groupId" = g."id"
  AND l."scraperSourceId" IS NULL
  AND l."scraperRunId" IS NULL;

CREATE INDEX "Lead_captureMethod_idx" ON "Lead"("captureMethod");
