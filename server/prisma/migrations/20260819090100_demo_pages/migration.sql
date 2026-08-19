-- CreateEnum
CREATE TYPE "DemoStatus" AS ENUM ('DRAFT', 'READY', 'SENT', 'ACCEPTED', 'DECLINED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Demo" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "leadId" TEXT,
    "title" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "status" "DemoStatus" NOT NULL DEFAULT 'DRAFT',
    "html" TEXT NOT NULL,
    "brief" JSONB,
    "references" JSONB,
    "builtBy" TEXT,
    "buildCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "views" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Demo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Demo_slug_key" ON "Demo"("slug");

-- CreateIndex
CREATE INDEX "Demo_status_idx" ON "Demo"("status");

-- CreateIndex
CREATE INDEX "Demo_leadId_idx" ON "Demo"("leadId");

-- AddForeignKey
ALTER TABLE "Demo" ADD CONSTRAINT "Demo_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
