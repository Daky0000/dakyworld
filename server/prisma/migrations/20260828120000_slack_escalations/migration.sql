-- A rehearsal's prepared actions are specimens, not proposals. They stay
-- readable on the rehearsal screen and are kept out of the approval queue.
ALTER TABLE "ActionRequest" ADD COLUMN "rehearsal" BOOLEAN NOT NULL DEFAULT false;

-- Where a task's escalation card was posted, so answering it anywhere rewrites
-- the message instead of leaving a live question in the channel.
ALTER TABLE "AgentTask" ADD COLUMN "slackChannel" TEXT;
ALTER TABLE "AgentTask" ADD COLUMN "slackTs" TEXT;

-- The approval queue reads PENDING rows constantly and must now exclude
-- rehearsed ones.
CREATE INDEX "ActionRequest_rehearsal_status_idx" ON "ActionRequest"("rehearsal", "status");
