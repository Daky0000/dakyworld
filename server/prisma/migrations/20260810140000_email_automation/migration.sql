-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmailKind" AS ENUM ('MANUAL', 'TEMPLATE', 'AI_DRAFT', 'SEQUENCE', 'AUTOMATION');

-- CreateEnum
CREATE TYPE "EmailPurpose" AS ENUM ('COLD_OUTREACH', 'FOLLOW_UP', 'MEETING_REQUEST', 'PROPOSAL_COVER', 'DELIVERABLE_HANDOVER', 'PROJECT_UPDATE', 'INVOICE_DELIVERY', 'INVOICE_REMINDER', 'CARE_PLAN_REVIEW', 'ONBOARDING', 'REACTIVATION', 'THANK_YOU', 'ANNOUNCEMENT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SequenceTrigger" AS ENUM ('MANUAL', 'LEAD_CREATED', 'LEAD_STATUS_CHANGED', 'PROPOSAL_SENT', 'PROJECT_COMPLETED', 'INVOICE_OVERDUE', 'CARE_PLAN_REVIEW_DUE');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'STOPPED');

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bcc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "replyTo" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'DRAFT',
    "kind" "EmailKind" NOT NULL DEFAULT 'MANUAL',
    "purpose" "EmailPurpose" NOT NULL DEFAULT 'CUSTOM',
    "scheduledFor" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "leadId" TEXT,
    "clientId" TEXT,
    "projectId" TEXT,
    "proposalId" TEXT,
    "invoiceId" TEXT,
    "carePlanId" TEXT,
    "templateId" TEXT,
    "stepId" TEXT,
    "enrollmentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "purpose" "EmailPurpose" NOT NULL DEFAULT 'CUSTOM',
    "description" TEXT,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "aiBrief" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSequence" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "SequenceTrigger" NOT NULL DEFAULT 'MANUAL',
    "triggerFilter" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "sendWindowStart" INTEGER NOT NULL DEFAULT 8,
    "sendWindowEnd" INTEGER NOT NULL DEFAULT 18,
    "weekdaysOnly" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSequenceStep" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "delayDays" INTEGER NOT NULL DEFAULT 3,
    "templateId" TEXT,
    "subject" TEXT,
    "bodyHtml" TEXT,
    "useAi" BOOLEAN NOT NULL DEFAULT false,
    "aiBrief" TEXT,
    "purpose" "EmailPurpose" NOT NULL DEFAULT 'FOLLOW_UP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailEnrollment" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "leadId" TEXT,
    "clientId" TEXT,
    "toEmail" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextPosition" INTEGER NOT NULL DEFAULT 0,
    "nextSendAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EmailEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailMessage_status_scheduledFor_idx" ON "EmailMessage"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "EmailMessage_leadId_idx" ON "EmailMessage"("leadId");

-- CreateIndex
CREATE INDEX "EmailMessage_clientId_idx" ON "EmailMessage"("clientId");

-- CreateIndex
CREATE INDEX "EmailMessage_toEmail_idx" ON "EmailMessage"("toEmail");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_slug_key" ON "EmailTemplate"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSequenceStep_sequenceId_position_key" ON "EmailSequenceStep"("sequenceId", "position");

-- CreateIndex
CREATE INDEX "EmailEnrollment_status_nextSendAt_idx" ON "EmailEnrollment"("status", "nextSendAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEnrollment_sequenceId_leadId_key" ON "EmailEnrollment"("sequenceId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEnrollment_sequenceId_clientId_key" ON "EmailEnrollment"("sequenceId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_carePlanId_fkey" FOREIGN KEY ("carePlanId") REFERENCES "CarePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "EmailSequenceStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "EmailEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSequenceStep" ADD CONSTRAINT "EmailSequenceStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "EmailSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSequenceStep" ADD CONSTRAINT "EmailSequenceStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEnrollment" ADD CONSTRAINT "EmailEnrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "EmailSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEnrollment" ADD CONSTRAINT "EmailEnrollment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEnrollment" ADD CONSTRAINT "EmailEnrollment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

