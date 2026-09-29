ALTER TABLE "DemoVisit"
  ADD COLUMN "region" TEXT,
  ADD COLUMN "countrySource" TEXT,
  ADD COLUMN "citySource" TEXT,
  ADD COLUMN "locationStatus" TEXT,
  ADD COLUMN "accuracyRadiusKm" DOUBLE PRECISION,
  ADD COLUMN "geoDatabaseVersion" TEXT,
  ADD COLUMN "locationResolvedAt" TIMESTAMP(3),
  ADD COLUMN "locationResolverVersion" TEXT;
-- Null provenance is serialized as legacy without rewriting historical locations.
