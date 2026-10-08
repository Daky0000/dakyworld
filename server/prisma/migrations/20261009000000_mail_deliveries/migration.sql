-- Every email the server tried to send, and whether the mail server took it.
CREATE TABLE "MailDelivery" (
    "id" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" TEXT,
    "transport" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "error" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MailDelivery_createdAt_idx" ON "MailDelivery"("createdAt");
CREATE INDEX "MailDelivery_status_createdAt_idx" ON "MailDelivery"("status", "createdAt");

ALTER TABLE "MailDelivery" ENABLE ROW LEVEL SECURITY;
