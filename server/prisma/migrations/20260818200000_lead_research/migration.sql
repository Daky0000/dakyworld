-- CreateTable
CREATE TABLE "LeadResearch" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filled" JSONB,
    "research" JSONB,
    "audit" JSONB,
    "shot" JSONB,
    "look" JSONB,
    "facts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "costUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadResearch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadResearch_leadId_key" ON "LeadResearch"("leadId");

-- CreateIndex
CREATE INDEX "LeadResearch_ranAt_idx" ON "LeadResearch"("ranAt");

-- AddForeignKey
ALTER TABLE "LeadResearch" ADD CONSTRAINT "LeadResearch_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
