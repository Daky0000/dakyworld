-- CreateEnum
CREATE TYPE "SitePageStatus" AS ENUM ('LIVE', 'HIDDEN');

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "repoOwner" TEXT,
    "repoName" TEXT,
    "repoBranch" TEXT NOT NULL DEFAULT 'main',
    "repoPath" TEXT NOT NULL DEFAULT '',
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SitePage" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "status" "SitePageStatus" NOT NULL DEFAULT 'LIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB,
    "draftSavedAt" TIMESTAMP(3),
    "draftSavedById" TEXT,
    "lastPublishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SitePage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SitePageVersion" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "html" TEXT NOT NULL,
    "values" JSONB,
    "commitSha" TEXT,
    "commitUrl" TEXT,
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SitePageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Site_slug_key" ON "Site"("slug");

-- CreateIndex
CREATE INDEX "SitePage_siteId_sortOrder_idx" ON "SitePage"("siteId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SitePage_siteId_path_key" ON "SitePage"("siteId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "SitePage_siteId_filePath_key" ON "SitePage"("siteId", "filePath");

-- CreateIndex
CREATE INDEX "SitePageVersion_pageId_createdAt_idx" ON "SitePageVersion"("pageId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SitePageVersion_pageId_number_key" ON "SitePageVersion"("pageId", "number");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePage" ADD CONSTRAINT "SitePage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePage" ADD CONSTRAINT "SitePage_draftSavedById_fkey" FOREIGN KEY ("draftSavedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePageVersion" ADD CONSTRAINT "SitePageVersion_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "SitePage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePageVersion" ADD CONSTRAINT "SitePageVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

