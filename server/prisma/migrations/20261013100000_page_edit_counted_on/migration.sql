-- The day a page spent a plan edit, kept where only the edit writes it.
--
-- An edit is one page changed on one UTC day, and the day used to be read from
-- "updatedAt". Every write to the row moves that column — a rename, discarding
-- a draft, a restore, a publish — so any of them, done to a page at the edit
-- limit, made the next save look like "already counted today" and let it
-- through free for the rest of the day. "editCountedOn" is written by
-- writePageEdit and nothing else.
--
-- The backfill copies only today's rows (UTC, as the counting is). Under the old
-- rule a page whose "updatedAt" fell today had already been settled for today —
-- charged, or excused by the write that moved it — and a customer who edited it
-- this morning was told any further change today was free; leaving it NULL
-- would charge them again after the deploy. That claim expires at midnight UTC.
-- An earlier "updatedAt" says nothing about an edit (it may be a rename from
-- March) and would change no count, so those rows stay NULL rather than record
-- a charge nobody can show happened.
ALTER TABLE "SitePage" ADD COLUMN "editCountedOn" DATE;

UPDATE "SitePage"
SET "editCountedOn" = "updatedAt"::date
WHERE "updatedAt" >= date_trunc('day', now() AT TIME ZONE 'UTC');

-- Whose plan an AI run is counted against. A colleague's run on a Business
-- website is the website owner's, so the job's own "userId" (who asked, which is
-- what its access is re-checked as) is no longer the answer. Every job before
-- this was counted against its "userId", daily and monthly, so that is exactly
-- what the backfill records; the refund on a failure goes back to the same row.
ALTER TABLE "WebsiteWorkJob" ADD COLUMN "chargedUserId" TEXT;

UPDATE "WebsiteWorkJob" SET "chargedUserId" = "userId";

CREATE INDEX "WebsiteWorkJob_chargedUserId_createdAt_idx" ON "WebsiteWorkJob"("chargedUserId", "createdAt");
