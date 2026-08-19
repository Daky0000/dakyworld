-- Two new kinds of timeline entry, added on their own.
--
-- Deliberately a separate migration from the one that uses them. Postgres
-- refuses to use a new enum value in the same transaction that created it
-- (55P04, "unsafe use of new value"), so a single migration adding these and
-- then writing one would deploy cleanly and fail the first time an agent was
-- interrupted.

ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'INTERRUPTED';
ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'RESUMED';
