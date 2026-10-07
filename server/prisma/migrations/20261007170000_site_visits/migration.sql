-- Visits to hosted websites, counted on the server: no cookie, no IP kept.
CREATE TABLE "SiteVisitDay" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "path" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "phone" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SiteVisitDay_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SiteReferrerDay" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SiteReferrerDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteVisitDay_siteId_day_path_key" ON "SiteVisitDay"("siteId", "day", "path");
CREATE UNIQUE INDEX "SiteReferrerDay_siteId_day_source_key" ON "SiteReferrerDay"("siteId", "day", "source");

ALTER TABLE "SiteVisitDay" ADD CONSTRAINT "SiteVisitDay_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteReferrerDay" ADD CONSTRAINT "SiteReferrerDay_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SiteVisitDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteReferrerDay" ENABLE ROW LEVEL SECURITY;
