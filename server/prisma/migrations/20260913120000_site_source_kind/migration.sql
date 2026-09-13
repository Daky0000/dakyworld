-- The framework a site's pages are written in, or NULL for plain HTML.
ALTER TABLE "Site" ADD COLUMN "sourceKind" TEXT;
