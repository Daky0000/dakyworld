-- Three new kinds of step: an agent asking a colleague, handing work sideways,
-- and saying that nobody on the roster can do something.
--
-- Its own migration, ahead of the tables that use it, because Postgres refuses
-- to add an enum value and use it inside the same transaction (55P04) and
-- Prisma wraps each migration in one. Nothing here writes a row; the values are
-- used at runtime by services/agents/runner.ts.

ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'CONSULTED';
ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'HANDED_OFF';
ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'GAP_RAISED';
