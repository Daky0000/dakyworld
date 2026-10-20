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

-- CreateIndex
CREATE UNIQUE INDEX "SiteHostConnection_siteId_provider_key" ON "SiteHostConnection"("siteId", "provider");

-- AddForeignKey
ALTER TABLE "SiteHostConnection" ADD CONSTRAINT "SiteHostConnection_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

