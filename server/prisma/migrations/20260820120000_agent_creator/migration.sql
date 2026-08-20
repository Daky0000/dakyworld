-- The workforce grows itself.
--
-- Two tables and two enums, and the split between them is the safety story.
-- `AgentGap` is demand: an agent saying it has hit work no craft on the roster
-- covers. `AgentHireRequest` is a design waiting on a decision. Nothing here
-- writes to "Agent" — what turns a request into a member of staff is a person
-- clicking Approve, or the standing hiring policy when it is set to AUTO, and
-- both of those happen in application code that no model can reach.

CREATE TYPE "AgentGapStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'FILLED', 'DECLINED');
CREATE TYPE "HireRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');

CREATE TABLE "AgentGap" (
    "id" TEXT NOT NULL,
    "requestedByKey" TEXT NOT NULL,
    "taskId" TEXT,
    "skillNeeded" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "timesRequested" INTEGER NOT NULL DEFAULT 1,
    "requestedByKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AgentGapStatus" NOT NULL DEFAULT 'OPEN',
    "filledByKey" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentGap_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentGap_status_createdAt_idx" ON "AgentGap"("status", "createdAt");
CREATE INDEX "AgentGap_skillNeeded_idx" ON "AgentGap"("skillNeeded");

CREATE TABLE "AgentHireRequest" (
    "id" TEXT NOT NULL,
    "gapId" TEXT,
    "proposedByKey" TEXT NOT NULL,
    "taskId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" "AgentDepartment" NOT NULL,
    "managerKey" TEXT NOT NULL,
    "mission" TEXT NOT NULL,
    "deliverable" TEXT NOT NULL,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kpis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "toolkit" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "escalationPolicy" TEXT NOT NULL,
    "avatar" TEXT,
    "prompt" JSONB NOT NULL DEFAULT '{}',
    "rationale" TEXT NOT NULL,
    "overlaps" JSONB NOT NULL DEFAULT '[]',
    "status" "HireRequestStatus" NOT NULL DEFAULT 'PENDING',
    "policy" TEXT NOT NULL DEFAULT 'ASK',
    "decidedById" TEXT,
    "decidedBySlackUser" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAgentKey" TEXT,
    "slackChannel" TEXT,
    "slackTs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentHireRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentHireRequest_status_createdAt_idx" ON "AgentHireRequest"("status", "createdAt");
CREATE INDEX "AgentHireRequest_gapId_idx" ON "AgentHireRequest"("gapId");

-- Same deny-by-default posture as every other table. See the row_level_security
-- migration for why this is enabled without a policy.
ALTER TABLE "AgentGap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentHireRequest" ENABLE ROW LEVEL SECURITY;
