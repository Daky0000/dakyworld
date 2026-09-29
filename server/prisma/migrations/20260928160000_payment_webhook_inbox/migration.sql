CREATE TABLE "PaymentWebhookEvent" (
  "id" TEXT PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "handledAt" TIMESTAMP(3),
  "nextTryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PaymentWebhookEvent_handledAt_nextTryAt_idx" ON "PaymentWebhookEvent" ("handledAt", "nextTryAt");
