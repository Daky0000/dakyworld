-- How demanding a task was judged to be, and why, written on its timeline
-- before the run starts. Added on its own so nothing uses the value in the same
-- transaction that creates it.
ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'ROUTED';
