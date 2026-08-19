-- Checkpoints: an interrupted agent run continues instead of starting again.
--
-- A task is a conversation of up to sixteen model turns, each of which may
-- have called a tool that cost money or left the building. Until now a deploy
-- landing mid-task discarded every one of them and began again from the brief.
-- These four columns and this table are what let the next runner rejoin the
-- conversation: the heartbeat says whether a RUNNING row is alive, the owner
-- says whose it is, the interrupt flag is how a person asks it to stop at a
-- safe point, and the checkpoint is the conversation itself.

ALTER TABLE "AgentTask" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
ALTER TABLE "AgentTask" ADD COLUMN "runOwner" TEXT;
ALTER TABLE "AgentTask" ADD COLUMN "interruptRequested" BOOLEAN NOT NULL DEFAULT false;

-- The reaper's query: RUNNING rows whose heartbeat has gone quiet.
CREATE INDEX "AgentTask_status_heartbeatAt_idx" ON "AgentTask"("status", "heartbeatAt");

CREATE TABLE "AgentTaskCheckpoint" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "messages" JSONB NOT NULL,
    "narration" JSONB NOT NULL,
    "pendingAssistant" JSONB,
    "pendingResults" JSONB,
    "counters" JSONB NOT NULL,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTaskCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentTaskCheckpoint_taskId_key" ON "AgentTaskCheckpoint"("taskId");

ALTER TABLE "AgentTaskCheckpoint" ADD CONSTRAINT "AgentTaskCheckpoint_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same deny-by-default posture as every other table. See the row_level_security
-- migration for why this is enabled without a policy.
ALTER TABLE "AgentTaskCheckpoint" ENABLE ROW LEVEL SECURITY;
