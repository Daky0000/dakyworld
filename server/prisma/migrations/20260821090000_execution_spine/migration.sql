-- The execution and audit spine.
--
-- Every fact needed to answer "what did this task do, and what did it cost"
-- was already being written down, and none of it joined up:
--
--   * ToolCall had no taskId, although invokeTool has always been handed one
--     and forwarded it only to the approval queue. The doc comment on AgentTask
--     claiming that "every tool call made while working on one is attributed to
--     it" was not true of the table.
--   * LlmCall had only a free-text `purpose`, so spend could be grouped by
--     feature and never traced to the run that caused it.
--   * The token counts behind a run's cost lived on the checkpoint, which is
--     deleted the moment a task reaches DONE — so the only runs whose tokens
--     were knowable were the ones that failed.
--   * Status was written in ten places with no record of the moves.
--
-- traceId is the thread through all of it, and is deliberately not the task's
-- own id: it is stamped on rows in tables that must outlive the task.

-- --- The trace ---------------------------------------------------------------

ALTER TABLE "AgentTask" ADD COLUMN "traceId" TEXT;

-- Existing rows get one so the column can be NOT NULL and the join is total.
-- Any unique value will do; nothing reads the shape of a trace.
UPDATE "AgentTask" SET "traceId" = gen_random_uuid()::text WHERE "traceId" IS NULL;

ALTER TABLE "AgentTask" ALTER COLUMN "traceId" SET NOT NULL;
CREATE UNIQUE INDEX "AgentTask_traceId_key" ON "AgentTask"("traceId");

-- --- Tokens that survive a successful run -------------------------------------

ALTER TABLE "AgentTask" ADD COLUMN "inputTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentTask" ADD COLUMN "outputTokens" INTEGER NOT NULL DEFAULT 0;

-- --- Tool calls join back to their task ---------------------------------------

ALTER TABLE "ToolCall" ADD COLUMN "taskId" TEXT;
ALTER TABLE "ToolCall" ADD COLUMN "traceId" TEXT;
ALTER TABLE "ToolCall" ADD COLUMN "idempotencyKey" TEXT;

CREATE INDEX "ToolCall_taskId_idx" ON "ToolCall"("taskId");
CREATE INDEX "ToolCall_traceId_idx" ON "ToolCall"("traceId");
-- Not unique: a refused or failed call sharing a key with a later successful
-- one is a true history. The guard in invoke.ts looks for a successful,
-- non-dry-run row rather than for any row.
CREATE INDEX "ToolCall_idempotencyKey_idx" ON "ToolCall"("idempotencyKey");

-- --- Model calls join back to their task --------------------------------------

ALTER TABLE "LlmCall" ADD COLUMN "taskId" TEXT;
ALTER TABLE "LlmCall" ADD COLUMN "agentKey" TEXT;
ALTER TABLE "LlmCall" ADD COLUMN "traceId" TEXT;

CREATE INDEX "LlmCall_taskId_idx" ON "LlmCall"("taskId");
CREATE INDEX "LlmCall_traceId_idx" ON "LlmCall"("traceId");
CREATE INDEX "LlmCall_agentKey_createdAt_idx" ON "LlmCall"("agentKey", "createdAt");

-- --- The status history -------------------------------------------------------

CREATE TABLE "AgentTaskTransition" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "traceId" TEXT,
    "from" "AgentTaskStatus",
    "to" "AgentTaskStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTaskTransition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentTaskTransition_taskId_at_idx" ON "AgentTaskTransition"("taskId", "at");
CREATE INDEX "AgentTaskTransition_traceId_idx" ON "AgentTaskTransition"("traceId");
CREATE INDEX "AgentTaskTransition_to_at_idx" ON "AgentTaskTransition"("to", "at");

ALTER TABLE "AgentTaskTransition" ADD CONSTRAINT "AgentTaskTransition_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Row-level security -------------------------------------------------------
--
-- 20260819180100_row_level_security set the house rule: every table denies
-- every role but the owner the application connects as. Seven tables added
-- since then were never enrolled, so the posture SECURITY.md describes did not
-- actually hold for the prepared payload of every outward action
-- (ActionRequest) or for every WhatsApp and SMS conversation with a real
-- person. Enrolling them here, along with the new table.

ALTER TABLE "AgentTaskTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActionRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContextNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageSuppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsAppTemplate" ENABLE ROW LEVEL SECURITY;
