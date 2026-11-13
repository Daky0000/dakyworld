-- A task can wait for other tasks: a sub-task for the earlier ones it builds
-- on, and a parent for the sub-tasks it raised. Additive; every existing row
-- waits for nothing.
ALTER TABLE "AgentTask" ADD COLUMN     "waitsFor" TEXT[] DEFAULT ARRAY[]::TEXT[];
