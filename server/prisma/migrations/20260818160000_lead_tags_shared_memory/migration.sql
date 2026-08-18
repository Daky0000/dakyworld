-- CreateEnum
CREATE TYPE "AgentMemoryScope" AS ENUM ('AGENT', 'SHARED');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "promptEditedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AgentMemory" ADD COLUMN     "authorKey" TEXT,
ADD COLUMN     "scope" "AgentMemoryScope" NOT NULL DEFAULT 'AGENT',
ALTER COLUMN "agentKey" DROP NOT NULL;

-- AlterTable
ALTER TABLE "LeadGroup" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "LeadTag" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "colour" TEXT,
    "description" TEXT,
    "autoCreated" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadTag_slug_key" ON "LeadTag"("slug");

-- CreateIndex
CREATE INDEX "LeadTag_autoCreated_idx" ON "LeadTag"("autoCreated");

-- CreateIndex
CREATE INDEX "AgentMemory_scope_subject_idx" ON "AgentMemory"("scope", "subject");

