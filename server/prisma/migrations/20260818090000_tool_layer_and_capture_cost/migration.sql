-- Capture runs now record what they cost and why rows were dropped.
ALTER TABLE "ScraperRun" ADD COLUMN     "costUsd" DOUBLE PRECISION,
                         ADD COLUMN     "estimateUsd" DOUBLE PRECISION,
                         ADD COLUMN     "diagnostics" JSONB;

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "agentKey" TEXT,
    "userId" TEXT,
    "input" JSONB,
    "output" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "refusedReason" TEXT,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolCall_createdAt_idx" ON "ToolCall"("createdAt");

-- CreateIndex
CREATE INDEX "ToolCall_tool_createdAt_idx" ON "ToolCall"("tool", "createdAt");

-- CreateIndex
CREATE INDEX "ToolCall_agentKey_createdAt_idx" ON "ToolCall"("agentKey", "createdAt");

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "event" TEXT,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "handledAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_source_createdAt_idx" ON "WebhookEvent"("source", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_handledAt_idx" ON "WebhookEvent"("handledAt");
