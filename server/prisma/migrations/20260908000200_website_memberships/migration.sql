CREATE TYPE "SiteMemberRole" AS ENUM ('VIEWER', 'EDITOR', 'REVIEWER', 'PUBLISHER', 'MANAGER', 'DEVELOPER');

CREATE TABLE "SiteMember" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "SiteMemberRole" NOT NULL DEFAULT 'VIEWER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SiteMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteMember_siteId_userId_key" ON "SiteMember"("siteId", "userId");
CREATE INDEX "SiteMember_userId_idx" ON "SiteMember"("userId");
ALTER TABLE "SiteMember" ADD CONSTRAINT "SiteMember_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteMember" ADD CONSTRAINT "SiteMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
