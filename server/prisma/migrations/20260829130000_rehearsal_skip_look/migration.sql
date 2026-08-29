-- A rehearsal reusing a lead that already has research on file skips
-- site.look and reports that research instead of scraping the site again.
ALTER TABLE "AgentTask" ADD COLUMN "skipLook" BOOLEAN NOT NULL DEFAULT false;
