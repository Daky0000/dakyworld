-- One new kind of step: an agent adding to a company's history.
--
-- Kept apart from REMEMBERED on purpose. A memory is what one agent concluded
-- and is read back to it as its own opinion; a note is what happened, and every
-- agent that opens that company afterwards reads it as evidence. A timeline
-- that called both "remembered" would make the two indistinguishable at exactly
-- the point somebody is trying to work out where a claim came from.
--
-- Its own migration, ahead of the tables that use it, because Postgres refuses
-- to add an enum value and use it inside the same transaction (55P04) and
-- Prisma wraps each migration in one. Nothing here writes a row; the value is
-- used at runtime by services/agents/runner.ts.

ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'NOTED';
