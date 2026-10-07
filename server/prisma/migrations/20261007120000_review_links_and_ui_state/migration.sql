-- CreateEnum
CREATE TYPE "ReviewLinkStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "uiState" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "ReviewLink" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ReviewLinkStatus" NOT NULL DEFAULT 'PENDING',
    "draftSnapshot" JSONB NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "reviewerName" TEXT,
    "reviewerEmail" TEXT,
    "feedback" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewComment" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "xPercent" DOUBLE PRECISION,
    "yPercent" DOUBLE PRECISION,
    "anchorLabel" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewLink_tokenHash_key" ON "ReviewLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ReviewLink_pageId_createdAt_idx" ON "ReviewLink"("pageId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewComment_linkId_createdAt_idx" ON "ReviewComment"("linkId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReviewLink" ADD CONSTRAINT "ReviewLink_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewLink" ADD CONSTRAINT "ReviewLink_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "SitePage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewLink" ADD CONSTRAINT "ReviewLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "ReviewLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, as on the tables of the 19 Aug 2026 hardening: the app
-- owns these and is unaffected; any other database role reads nothing.
ALTER TABLE "ReviewLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewComment" ENABLE ROW LEVEL SECURITY;
