-- Developer requests keep the number they were given. Until now the number was
-- recomputed from row positions on every read, so the list and the chat could
-- quote different numbers for the same request.
ALTER TABLE "WebsiteEscalation" ADD COLUMN "reportNumber" TEXT,
ADD COLUMN "userId" TEXT;

-- Existing rows are numbered per calendar year in the order they were filed.
UPDATE "WebsiteEscalation" AS e
SET "reportNumber" = 'ESC-' || numbered.year || '-' || lpad(numbered.n::text, 3, '0')
FROM (
  SELECT "id",
         extract(year FROM "createdAt")::int AS year,
         row_number() OVER (PARTITION BY extract(year FROM "createdAt") ORDER BY "createdAt", "id") AS n
  FROM "WebsiteEscalation"
) AS numbered
WHERE e."id" = numbered."id";

ALTER TABLE "WebsiteEscalation" ALTER COLUMN "reportNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteEscalation_reportNumber_key" ON "WebsiteEscalation"("reportNumber");

-- CreateIndex
CREATE INDEX "WebsiteEscalation_userId_idx" ON "WebsiteEscalation"("userId");
