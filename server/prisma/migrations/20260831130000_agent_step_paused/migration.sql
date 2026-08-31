-- The run was put down because a model provider was unavailable, and picked
-- up again a few minutes later. Added on its own so nothing uses the value in
-- the same transaction that creates it.
ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'PAUSED';
