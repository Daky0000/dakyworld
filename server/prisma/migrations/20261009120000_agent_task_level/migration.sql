-- How demanding an agent task is, and so which of a paid vendor's three models
-- runs it. Judged when a run starts (services/agents/complexity.ts), reused
-- when it resumes, and overridable by the Owner per task.
CREATE TYPE "TaskLevel" AS ENUM ('SIMPLE', 'STANDARD', 'COMPLEX');

ALTER TABLE "AgentTask"
  ADD COLUMN "level" "TaskLevel",
  ADD COLUMN "levelOverride" "TaskLevel",
  ADD COLUMN "levelReason" TEXT,
  ADD COLUMN "levelSource" TEXT;
