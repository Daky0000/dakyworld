ALTER TABLE "SiteAsset" DROP CONSTRAINT "SiteAsset_siteId_fkey";
ALTER TABLE "SiteAuditEvent" DROP CONSTRAINT "SiteAuditEvent_siteId_fkey";
ALTER TABLE "SiteAsset" ADD CONSTRAINT "SiteAsset_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteAuditEvent" ADD CONSTRAINT "SiteAuditEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
