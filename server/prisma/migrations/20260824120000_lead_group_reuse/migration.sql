-- One list per capture source, reused run after run.
--
-- Every shipped template ended its group name in `{{date}}`, so a source that
-- ran daily opened a new list daily. `ScraperSource.leadGroupId` pins the list
-- a source fills; `services/scraperRunner.ts` adopts an existing list by name
-- before creating one, then writes the id back here.
ALTER TABLE "ScraperSource" ADD COLUMN "leadGroupId" TEXT;

CREATE INDEX "ScraperSource_leadGroupId_idx" ON "ScraperSource"("leadGroupId");

ALTER TABLE "ScraperSource"
  ADD CONSTRAINT "ScraperSource_leadGroupId_fkey"
  FOREIGN KEY ("leadGroupId") REFERENCES "LeadGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing sources adopt the list they last filled, so upgrading doesn't start
-- a fresh list for a source that already has one. Most recent wins: a source
-- whose name changed has been landing in the newer list.
UPDATE "ScraperSource" s
SET "leadGroupId" = (
  SELECT l."groupId"
  FROM "Lead" l
  WHERE l."scraperSourceId" = s."id" AND l."groupId" IS NOT NULL
  ORDER BY l."createdAt" DESC
  LIMIT 1
)
WHERE s."adhoc" = false;
