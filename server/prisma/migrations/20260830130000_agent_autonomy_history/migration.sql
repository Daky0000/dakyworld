-- CreateTable
CREATE TABLE "AgentAutonomyChange" (
    "id" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "fromLevel" INTEGER,
    "toLevel" INTEGER,
    "fromDryRun" BOOLEAN,
    "toDryRun" BOOLEAN,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAutonomyChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAutonomyChange_agentKey_at_idx" ON "AgentAutonomyChange"("agentKey", "at");

