-- CreateEnum
CREATE TYPE "ClientMemberRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateTable
CREATE TABLE "ClientMember" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ClientMemberRole" NOT NULL DEFAULT 'MEMBER',
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "EntitlementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientMember_userId_idx" ON "ClientMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMember_clientId_userId_key" ON "ClientMember"("clientId", "userId");

-- CreateIndex
CREATE INDEX "ProductGrant_userId_idx" ON "ProductGrant"("userId");

-- CreateIndex
CREATE INDEX "EntitlementEvent_deliveredAt_nextAttemptAt_idx" ON "EntitlementEvent"("deliveredAt", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCode_codeHash_key" ON "OAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "OAuthCode_expiresAt_idx" ON "OAuthCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "ClientMember" ADD CONSTRAINT "ClientMember_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMember" ADD CONSTRAINT "ClientMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGrant" ADD CONSTRAINT "ProductGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthCode" ADD CONSTRAINT "OAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: the one existing link between a person and a client that the
-- person proved by paying. A purchase whose buyer is the account it names.
INSERT INTO "ClientMember" ("id", "clientId", "userId", "role", "createdAt")
SELECT 'cm_' || md5(p."clientId" || ':' || p."userId"), p."clientId", p."userId", 'OWNER', MIN(p."createdAt")
FROM "WebsitePurchase" p
WHERE p."userId" IS NOT NULL AND p."setupPaidAt" IS NOT NULL
GROUP BY p."clientId", p."userId"
ON CONFLICT ("clientId", "userId") DO NOTHING;
