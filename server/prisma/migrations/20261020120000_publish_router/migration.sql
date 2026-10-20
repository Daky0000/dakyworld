-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "deployHookSecret" TEXT,
ADD COLUMN     "deployProfile" JSONB,
ADD COLUMN     "githubPagesInstallationId" TEXT;

-- AlterTable
ALTER TABLE "PublishJob" ADD COLUMN     "fallbackFrom" TEXT,
ADD COLUMN     "hostMessage" TEXT,
ADD COLUMN     "route" TEXT,
ADD COLUMN     "routeLog" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "stage" TEXT,
ADD COLUMN     "stageTimes" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "SiteHostConnection" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalSiteId" TEXT,
    "externalName" TEXT,
    "teamId" TEXT,
    "configurationId" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "pausedAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "manifest" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteHostConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeBridge" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending-dns',
    "cloudflareHostnameId" TEXT,
    "sslStatus" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EdgeBridge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeBridgeEntry" (
    "id" TEXT NOT NULL,
    "bridgeId" TEXT NOT NULL,
    "publishJobId" TEXT,
    "path" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "renewUntil" TIMESTAMP(3) NOT NULL,
    "alertedAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EdgeBridgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteHostConnection_siteId_provider_key" ON "SiteHostConnection"("siteId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeBridge_siteId_key" ON "EdgeBridge"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeBridge_hostname_key" ON "EdgeBridge"("hostname");

-- CreateIndex
CREATE INDEX "EdgeBridgeEntry_bridgeId_path_idx" ON "EdgeBridgeEntry"("bridgeId", "path");

-- CreateIndex
CREATE INDEX "EdgeBridgeEntry_clearedAt_expiresAt_idx" ON "EdgeBridgeEntry"("clearedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "SiteHostConnection" ADD CONSTRAINT "SiteHostConnection_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EdgeBridge" ADD CONSTRAINT "EdgeBridge_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EdgeBridgeEntry" ADD CONSTRAINT "EdgeBridgeEntry_bridgeId_fkey" FOREIGN KEY ("bridgeId") REFERENCES "EdgeBridge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

