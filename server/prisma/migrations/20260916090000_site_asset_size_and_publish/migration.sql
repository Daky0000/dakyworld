-- An uploaded image stops being a permanent row in the primary database.
--
-- Three columns, one decision behind all of them. `SiteAsset.content` held the
-- bytes of every image any customer had ever uploaded, for ever, in the Postgres
-- that also gets backed up and restored — while the public page was being served
-- the copy in the customer's repository. The database copy is only needed
-- between the upload and the publish that carries it.
--
--   size        so a listing can say how big a file is without reading it, and
--               so it can still say it after the bytes are gone. StoredFile has
--               carried one from the start for exactly this reason; this table
--               never learned it.
--   publishedAt written when a publish is *verified live*, never when it is
--               committed. This is the column a sweep is allowed to read.
--   content     nullable, because a swept asset keeps its row, its address, its
--               size and its description, and loses only the duplicate bytes.
--
-- Nothing sweeps yet. These columns exist so the code that does can be added
-- without a second migration, and so that `size` is populated for every row
-- that already exists before anything depends on it.

ALTER TABLE "SiteAsset" ADD COLUMN "size" INTEGER;
ALTER TABLE "SiteAsset" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "SiteAsset" ALTER COLUMN "content" DROP NOT NULL;

-- Backfill before the NOT NULL, from the bytes themselves. Every existing row
-- still has its content — nothing has ever removed any — so this is exact
-- rather than a guess, and it is the only moment at which it can be taken
-- cheaply for the whole table.
UPDATE "SiteAsset" SET "size" = octet_length("content") WHERE "size" IS NULL;

ALTER TABLE "SiteAsset" ALTER COLUMN "size" SET NOT NULL;

CREATE INDEX "SiteAsset_publishedAt_idx" ON "SiteAsset"("publishedAt");
