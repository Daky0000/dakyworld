-- CreateEnum
CREATE TYPE "AgentTier" AS ENUM ('BOARD', 'EXECUTIVE', 'FUNCTIONAL', 'OPERATIONAL', 'SUB_AGENT');

-- CreateEnum
CREATE TYPE "AgentDepartment" AS ENUM ('EXECUTIVE', 'REVENUE', 'DELIVERY', 'FINANCE', 'MARKETING', 'TECHNOLOGY', 'CLIENT', 'RISK', 'PEOPLE');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'RETIRED');

-- AlterTable
ALTER TABLE "ScraperSource" ADD COLUMN     "adhoc" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tier" "AgentTier" NOT NULL DEFAULT 'OPERATIONAL',
    "department" "AgentDepartment" NOT NULL,
    "managerKey" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'DRAFT',
    "mission" TEXT NOT NULL,
    "responsibilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kpis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autonomyLevel" INTEGER NOT NULL DEFAULT 1,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "toolkit" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "escalationPolicy" TEXT,
    "prompt" JSONB NOT NULL DEFAULT '{}',
    "seedRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_key_key" ON "Agent"("key");

-- CreateIndex
CREATE INDEX "Agent_status_department_idx" ON "Agent"("status", "department");

-- CreateIndex
CREATE INDEX "Agent_tier_idx" ON "Agent"("tier");

