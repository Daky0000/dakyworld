CREATE TYPE "SharedInstanceState" AS ENUM ('LINKED', 'DETACHED');

CREATE TABLE "SharedElement" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tag" TEXT NOT NULL DEFAULT 'div',
  "origin" TEXT NOT NULL DEFAULT 'manual',
  "slots" JSONB NOT NULL DEFAULT '[]',
  "draft" JSONB,
  "draftRevision" INTEGER NOT NULL DEFAULT 0,
  "draftSavedAt" TIMESTAMP(3),
  "draftSavedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SharedElement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SharedElementInstance" (
  "id" TEXT NOT NULL,
  "sharedElementId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "state" "SharedInstanceState" NOT NULL DEFAULT 'LINKED',
  "detachedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SharedElementInstance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SharedElement_siteId_key_key" ON "SharedElement"("siteId", "key");
CREATE INDEX "SharedElement_siteId_idx" ON "SharedElement"("siteId");
CREATE UNIQUE INDEX "SharedElementInstance_sharedElementId_pageId_key" ON "SharedElementInstance"("sharedElementId", "pageId");
CREATE INDEX "SharedElementInstance_pageId_idx" ON "SharedElementInstance"("pageId");

ALTER TABLE "SharedElement" ADD CONSTRAINT "SharedElement_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SharedElement" ADD CONSTRAINT "SharedElement_draftSavedById_fkey" FOREIGN KEY ("draftSavedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SharedElementInstance" ADD CONSTRAINT "SharedElementInstance_sharedElementId_fkey" FOREIGN KEY ("sharedElementId") REFERENCES "SharedElement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SharedElementInstance" ADD CONSTRAINT "SharedElementInstance_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "SitePage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
