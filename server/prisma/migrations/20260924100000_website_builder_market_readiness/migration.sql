CREATE TYPE "AuthTokenKind" AS ENUM ('PASSWORD_RESET', 'EMAIL_VERIFICATION', 'SET_PASSWORD');
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Site" ADD COLUMN "hostedEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Site" ADD COLUMN "hostedSlug" TEXT;
ALTER TABLE "Site" ADD COLUMN "customDomain" TEXT;
ALTER TABLE "Site" ADD COLUMN "customDomainToken" TEXT;
ALTER TABLE "Site" ADD COLUMN "customDomainVerifiedAt" TIMESTAMP(3);
ALTER TABLE "SitePage" ADD COLUMN "publishedHtml" TEXT;
ALTER TABLE "WebsitePurchase" ADD COLUMN "userId" TEXT;
ALTER TABLE "WebsitePurchase" ADD COLUMN "standardMonthlyPrice" DECIMAL(12,2);
ALTER TABLE "WebsitePurchase" ADD COLUMN "standardPriceAppliedAt" TIMESTAMP(3);
ALTER TABLE "WebsitePurchase" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
ALTER TABLE "WebsitePurchase" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "WebsitePurchase" ADD COLUMN "endsAt" TIMESTAMP(3);
ALTER TABLE "WebsitePurchase" ADD COLUMN "failedPaymentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebsitePurchase" ADD COLUMN "lastPaymentFailedAt" TIMESTAMP(3);
CREATE TABLE "AuthToken" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "kind" "AuthTokenKind" NOT NULL, "tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id"));
CREATE TABLE "WebsiteUsage" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "period" TEXT NOT NULL, "imports" INTEGER NOT NULL DEFAULT 0, "edits" INTEGER NOT NULL DEFAULT 0, "aiPrompts" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "WebsiteUsage_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Site_hostedSlug_key" ON "Site"("hostedSlug");
CREATE UNIQUE INDEX "Site_customDomain_key" ON "Site"("customDomain");
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");
CREATE INDEX "AuthToken_userId_kind_idx" ON "AuthToken"("userId", "kind");
CREATE INDEX "AuthToken_expiresAt_idx" ON "AuthToken"("expiresAt");
CREATE UNIQUE INDEX "WebsiteUsage_userId_period_key" ON "WebsiteUsage"("userId", "period");
CREATE INDEX "WebsitePurchase_userId_status_idx" ON "WebsitePurchase"("userId", "status");
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebsiteUsage" ADD CONSTRAINT "WebsiteUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebsitePurchase" ADD CONSTRAINT "WebsitePurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Existing subscribers keep serving: the standard price they revert to is the
-- one their tier was sold at, and a site that already has no repository is the
-- case hosting exists for, so it is switched on rather than left unpublishable.
UPDATE "WebsitePurchase" SET "standardMonthlyPrice" = CASE "tier" WHEN 'EDITOR' THEN 5.00 WHEN 'CARE' THEN 16.00 ELSE 45.00 END WHERE "standardMonthlyPrice" IS NULL AND "currency" = 'USD';
UPDATE "WebsitePurchase" SET "standardMonthlyPrice" = CASE "tier" WHEN 'EDITOR' THEN 500.00 WHEN 'CARE' THEN 1500.00 ELSE 4000.00 END WHERE "standardMonthlyPrice" IS NULL;
UPDATE "Site" SET "hostedSlug" = "slug", "hostedEnabled" = true WHERE "repoName" IS NULL AND "hostedSlug" IS NULL;
