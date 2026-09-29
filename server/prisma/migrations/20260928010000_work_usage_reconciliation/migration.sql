ALTER TABLE "WebsiteWorkJob"
  ADD COLUMN "usagePeriod" TEXT,
  ADD COLUMN "usageState" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "externalStartedAt" TIMESTAMP(3),
  ADD COLUMN "actualCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0;
-- Existing accepted AI work keeps its allowance reserved during rollout.
UPDATE "WebsiteWorkJob" SET "usagePeriod" = to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM'),
  "usageState" = CASE WHEN state = 'COMPLETED' THEN 'ACCOUNTED' ELSE 'RESERVED' END
  WHERE kind IN ('ASSISTANT', 'BUILDER_PLAN');
-- Older workers did not persist an external-attempt marker; treat their in-flight work conservatively.
UPDATE "WebsiteWorkJob" SET "externalStartedAt" = COALESCE("startedAt", "createdAt") WHERE state = 'RUNNING';
