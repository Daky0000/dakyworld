ALTER TABLE "Session" ADD COLUMN "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "SitePage" ADD COLUMN "publishedEtag" TEXT;
UPDATE "SitePage" SET "publishedEtag" = 'W/"' || md5("publishedHtml") || '"' WHERE "publishedHtml" IS NOT NULL;

CREATE TABLE "CacheInvalidation" (
  "id" SERIAL PRIMARY KEY, "scope" TEXT NOT NULL, "resource" TEXT NOT NULL,
  "siteId" TEXT, "urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastError" TEXT,
  "observedBy" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
);
CREATE INDEX "CacheInvalidation_deliveredAt_nextAttemptAt_idx" ON "CacheInvalidation"("deliveredAt", "nextAttemptAt");
CREATE INDEX "CacheInvalidation_siteId_createdAt_idx" ON "CacheInvalidation"("siteId", "createdAt");
CREATE TABLE "ServiceLease" ("key" TEXT PRIMARY KEY, "owner" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL);
CREATE TABLE "WebsiteWorkJob" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "siteId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "inputHash" TEXT NOT NULL, "input" JSONB NOT NULL,
  "result" JSONB, "state" TEXT NOT NULL DEFAULT 'QUEUED', "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3), "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "WebsiteWorkJob_userId_idempotencyKey_key" ON "WebsiteWorkJob"("userId", "idempotencyKey");
CREATE INDEX "WebsiteWorkJob_state_nextAttemptAt_createdAt_idx" ON "WebsiteWorkJob"("state", "nextAttemptAt", "createdAt");
CREATE INDEX "WebsiteWorkJob_userId_createdAt_idx" ON "WebsiteWorkJob"("userId", "createdAt");
CREATE INDEX "WebsiteWorkJob_siteId_state_idx" ON "WebsiteWorkJob"("siteId", "state");

-- Triggers cover writes from routes, background jobs, imports, and admin scripts.
-- Invalidation cannot commit unless the associated data change commits.
CREATE FUNCTION dw_cache_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; old_data jsonb; sid text; previous_url text; next_url text;
BEGIN
  IF TG_OP <> 'DELETE' THEN row_data := to_jsonb(NEW); ELSE row_data := to_jsonb(OLD); END IF;
  IF TG_OP <> 'INSERT' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME IN ('Invoice','CarePlan','Proposal','Lead') THEN
    INSERT INTO "CacheInvalidation" ("scope","resource") VALUES ('internal','dashboard');
  ELSIF TG_TABLE_NAME = 'AppSetting' THEN
    INSERT INTO "CacheInvalidation" ("scope","resource") VALUES ('internal','settings');
  ELSE
    sid := CASE WHEN TG_TABLE_NAME = 'Site' THEN row_data->>'id' ELSE row_data->>'siteId' END;
    INSERT INTO "CacheInvalidation" ("scope","resource","siteId") VALUES ('site:' || sid,'metadata',sid);
    IF TG_TABLE_NAME = 'Site' THEN
      previous_url := old_data->>'publicUrl'; next_url := row_data->>'publicUrl';
      INSERT INTO "CacheInvalidation" ("scope","resource","siteId","urls")
        VALUES ('public','hosts',sid, array_remove(ARRAY[previous_url,next_url],NULL));
      INSERT INTO "CacheInvalidation" ("scope","resource","siteId","urls")
        VALUES ('public','pages',sid, array_remove(ARRAY[previous_url,next_url,
          CASE WHEN old_data->>'customDomain' IS NOT NULL THEN 'https://' || (old_data->>'customDomain') END,
          CASE WHEN row_data->>'customDomain' IS NOT NULL THEN 'https://' || (row_data->>'customDomain') END],NULL));
    ELSIF TG_TABLE_NAME = 'SitePage' AND (TG_OP <> 'UPDATE' OR
      old_data->'publishedHtml' IS DISTINCT FROM row_data->'publishedHtml' OR
      old_data->'status' IS DISTINCT FROM row_data->'status' OR
      old_data->'path' IS DISTINCT FROM row_data->'path') THEN
      INSERT INTO "CacheInvalidation" ("scope","resource","siteId","urls")
        SELECT 'public','pages',sid,array_remove(ARRAY[
          rtrim(s."publicUrl",'/') || '/' || ltrim(old_data->>'path','/'),
          rtrim(s."publicUrl",'/') || '/' || ltrim(row_data->>'path','/')],NULL)
        FROM "Site" s WHERE s.id = sid;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION dw_published_etag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."publishedEtag" := CASE WHEN NEW."publishedHtml" IS NULL THEN NULL ELSE 'W/"' || md5(NEW."publishedHtml") || '"' END;
  RETURN NEW;
END $$;
CREATE TRIGGER dw_published_etag BEFORE INSERT OR UPDATE OF "publishedHtml" ON "SitePage" FOR EACH ROW EXECUTE FUNCTION dw_published_etag();
CREATE TRIGGER dw_cache_site AFTER INSERT OR UPDATE OR DELETE ON "Site" FOR EACH ROW EXECUTE FUNCTION dw_cache_invalidate();
CREATE TRIGGER dw_cache_page AFTER INSERT OR UPDATE OR DELETE ON "SitePage" FOR EACH ROW EXECUTE FUNCTION dw_cache_invalidate();
CREATE TRIGGER dw_cache_invoice AFTER INSERT OR UPDATE OR DELETE ON "Invoice" FOR EACH STATEMENT EXECUTE FUNCTION dw_cache_invalidate();
CREATE TRIGGER dw_cache_careplan AFTER INSERT OR UPDATE OR DELETE ON "CarePlan" FOR EACH STATEMENT EXECUTE FUNCTION dw_cache_invalidate();
CREATE TRIGGER dw_cache_proposal AFTER INSERT OR UPDATE OR DELETE ON "Proposal" FOR EACH STATEMENT EXECUTE FUNCTION dw_cache_invalidate();
CREATE TRIGGER dw_cache_lead AFTER INSERT OR UPDATE OR DELETE ON "Lead" FOR EACH STATEMENT EXECUTE FUNCTION dw_cache_invalidate();
CREATE TRIGGER dw_cache_setting AFTER INSERT OR UPDATE OR DELETE ON "AppSetting" FOR EACH STATEMENT EXECUTE FUNCTION dw_cache_invalidate();
