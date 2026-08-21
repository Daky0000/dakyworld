-- CreateEnum
CREATE TYPE "BudgetScope" AS ENUM ('GLOBAL', 'AGENT', 'TOOL');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('DAY', 'MONTH');

-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "budgetUsd" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "scopeType" "BudgetScope" NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '',
    "period" "BudgetPeriod" NOT NULL,
    "softLimitUsd" DECIMAL(10,2),
    "hardLimitUsd" DECIMAL(10,2),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_enabled_idx" ON "Budget"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_scopeType_scopeId_period_key" ON "Budget"("scopeType", "scopeId", "period");

