-- CreateEnum
CREATE TYPE "ConceptStage" AS ENUM ('QUALIFIED', 'AUDIT_COMPLETE', 'BUILDING', 'NEEDS_REVIEW', 'PREVIEW_CHECKED', 'PROPOSAL_READY', 'EMAIL_READY', 'APPROVED', 'SENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "ConceptKind" AS ENUM ('NEW_SITE', 'REDESIGN');

-- CreateTable
CREATE TABLE "LeadConcept" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "stage" "ConceptStage" NOT NULL DEFAULT 'QUALIFIED',
    "kind" "ConceptKind" NOT NULL DEFAULT 'NEW_SITE',
    "reason" TEXT,
    "auditId" TEXT,
    "redesignCall" TEXT,
    "redesignScore" INTEGER,
    "demoId" TEXT,
    "demoVersion" INTEGER,
    "checks" JSONB,
    "checkAttempts" INTEGER NOT NULL DEFAULT 0,
    "firstPassOk" BOOLEAN,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "proposalId" TEXT,
    "emailMessageId" TEXT,
    "approvalFingerprint" TEXT,
    "approvalSubject" JSONB,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "buildMs" INTEGER,
    "buildCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "rebuilds" INTEGER NOT NULL DEFAULT 0,
    "initialSendClaimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sendUncertain" BOOLEAN NOT NULL DEFAULT false,
    "repliedAt" TIMESTAMP(3),
    "meetingAt" TIMESTAMP(3),
    "proposalAcceptedAt" TIMESTAMP(3),
    "revenueUsd" DECIMAL(12,2),
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadConcept_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadConcept_leadId_key" ON "LeadConcept"("leadId");

-- CreateIndex
CREATE INDEX "LeadConcept_stage_idx" ON "LeadConcept"("stage");

-- AddForeignKey
ALTER TABLE "LeadConcept" ADD CONSTRAINT "LeadConcept_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
