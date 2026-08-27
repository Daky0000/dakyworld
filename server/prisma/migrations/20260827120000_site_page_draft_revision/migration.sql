-- Optimistic concurrency for website drafts.
-- Existing rows start at 0; the first save after this bumps them to 1, which is
-- correct — no editor is currently holding a revision number at all.
ALTER TABLE "SitePage" ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0;
