-- Machine-sourced lead origins, added ahead of the tables that reference them.
--
-- PostgreSQL refuses to use a new enum value in the same transaction that adds
-- it ("unsafe use of new value ... must be committed before they can be used"),
-- and ScraperSource.leadSource defaults to GOOGLE_MAPS — so these four values
-- have to land in their own migration.
ALTER TYPE "LeadSource" ADD VALUE 'GOOGLE_MAPS';
ALTER TYPE "LeadSource" ADD VALUE 'WEB_SCRAPE';
ALTER TYPE "LeadSource" ADD VALUE 'DIRECTORY';
ALTER TYPE "LeadSource" ADD VALUE 'SOCIAL';
