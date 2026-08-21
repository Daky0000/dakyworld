-- CreateEnum
CREATE TYPE "MailFolder" AS ENUM ('INBOX', 'SENT');

-- CreateEnum
CREATE TYPE "MailIntent" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'QUESTION', 'MEETING_REQUEST', 'PROPOSAL_FEEDBACK', 'SUPPORT_ISSUE', 'INVOICE_QUERY', 'PAYMENT_NOTICE', 'NEW_ENQUIRY', 'SUPPLIER', 'UNSUBSCRIBE', 'AUTO_REPLY', 'BOUNCE', 'SPAM', 'PERSONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "MailTriageStatus" AS ENUM ('NEW', 'TRIAGED', 'ROUTED', 'HANDLED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "MailThread" (
    "id" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "counterpartEmail" TEXT NOT NULL,
    "counterpartName" TEXT,
    "participants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "leadId" TEXT,
    "clientId" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "lastSnippet" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailMessage" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "messageId" TEXT,
    "folder" "MailFolder" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "uid" BIGINT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "snippet" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "triage" "MailTriageStatus" NOT NULL DEFAULT 'NEW',
    "intent" "MailIntent",
    "summary" TEXT,
    "urgency" INTEGER,
    "needsReply" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "triagedAt" TIMESTAMP(3),
    "triageError" TEXT,
    "routedAgentKey" TEXT,
    "taskId" TEXT,
    "routedAt" TIMESTAMP(3),
    "replyToEmailId" TEXT,
    "leadId" TEXT,
    "clientId" TEXT,
    "threadId" TEXT NOT NULL,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,
    "handledNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailSyncState" (
    "id" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "folder" "MailFolder" NOT NULL,
    "uidValidity" BIGINT,
    "lastUid" BIGINT NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "messagesSeen" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailThread_threadKey_key" ON "MailThread"("threadKey");

-- CreateIndex
CREATE INDEX "MailThread_lastMessageAt_idx" ON "MailThread"("lastMessageAt");

-- CreateIndex
CREATE INDEX "MailThread_lastInboundAt_idx" ON "MailThread"("lastInboundAt");

-- CreateIndex
CREATE INDEX "MailThread_leadId_idx" ON "MailThread"("leadId");

-- CreateIndex
CREATE INDEX "MailThread_clientId_idx" ON "MailThread"("clientId");

-- CreateIndex
CREATE INDEX "MailThread_counterpartEmail_idx" ON "MailThread"("counterpartEmail");

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_dedupeKey_key" ON "MailMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "MailMessage_threadId_sentAt_idx" ON "MailMessage"("threadId", "sentAt");

-- CreateIndex
CREATE INDEX "MailMessage_triage_receivedAt_idx" ON "MailMessage"("triage", "receivedAt");

-- CreateIndex
CREATE INDEX "MailMessage_direction_receivedAt_idx" ON "MailMessage"("direction", "receivedAt");

-- CreateIndex
CREATE INDEX "MailMessage_fromEmail_idx" ON "MailMessage"("fromEmail");

-- CreateIndex
CREATE INDEX "MailMessage_leadId_idx" ON "MailMessage"("leadId");

-- CreateIndex
CREATE INDEX "MailMessage_clientId_idx" ON "MailMessage"("clientId");

-- CreateIndex
CREATE INDEX "MailMessage_messageId_idx" ON "MailMessage"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MailSyncState_mailbox_folder_key" ON "MailSyncState"("mailbox", "folder");

-- AddForeignKey
ALTER TABLE "MailThread" ADD CONSTRAINT "MailThread_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailThread" ADD CONSTRAINT "MailThread_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_replyToEmailId_fkey" FOREIGN KEY ("replyToEmailId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

