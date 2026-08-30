-- Which model is doing the work, and every handover between them.
--
-- The model layer wrote its decisions to the server console and nowhere else,
-- so a run climbing three free models and then two paid ones showed on the
-- screen as a task sitting still, and the first thing anybody read about a
-- vendor was the error at the end.
ALTER TYPE "AgentStepKind" ADD VALUE IF NOT EXISTS 'SERVING';
