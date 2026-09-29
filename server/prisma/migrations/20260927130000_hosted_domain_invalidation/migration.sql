ALTER TABLE "CacheInvalidation" ADD COLUMN "hostedSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Keep the previous hosted hostname available after reassignment or deletion.
CREATE FUNCTION dw_cache_hosted_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO "CacheInvalidation" ("scope", "resource", "siteId", "hostedSlugs")
      VALUES ('public', 'pages', OLD.id, array_remove(ARRAY[OLD."hostedSlug"], NULL));
  ELSIF OLD."hostedSlug" IS DISTINCT FROM NEW."hostedSlug" THEN
    INSERT INTO "CacheInvalidation" ("scope", "resource", "siteId", "hostedSlugs")
      VALUES ('public', 'pages', NEW.id, array_remove(ARRAY[OLD."hostedSlug", NEW."hostedSlug"], NULL));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER dw_cache_hosted_domain AFTER UPDATE OR DELETE ON "Site"
  FOR EACH ROW EXECUTE FUNCTION dw_cache_hosted_domain();
