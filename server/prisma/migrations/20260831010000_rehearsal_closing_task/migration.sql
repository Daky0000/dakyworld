-- The last task of a rehearsal: the agent it started with, given back what its
-- directors actually reported.
--
-- Hand-offs are fire-and-forget and a rehearsal runs one task at a time, so the
-- agent at the top always finished first and always finished uninformed — the
-- run's headline answer was its least informed one. This is how the run knows
-- it has already asked for the real one, and knows not to ask twice.
ALTER TABLE "Rehearsal" ADD COLUMN "closingTaskId" TEXT;
