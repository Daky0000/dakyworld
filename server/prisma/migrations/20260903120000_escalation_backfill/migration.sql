-- Backfill: a task that stopped to ask before `escalationStatus` existed has
-- none, and never will. The column is written inside `transition()`, and a task
-- already sitting in BLOCKED does not transition again until somebody answers
-- it — which writes ANSWERED. So the oldest questions in the system were the
-- only ones the weekly digest could not see, while the Agents screen listed
-- them, because that road reads `status` instead.
--
-- Only BLOCKED rows with nothing recorded. A question already ANSWERED or
-- CLOSED has been dealt with and must not be raised again.
UPDATE "AgentTask"
SET "escalationStatus" = 'PENDING'
WHERE "escalationStatus" IS NULL
  AND "status" = 'BLOCKED';
