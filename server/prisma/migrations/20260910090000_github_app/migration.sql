ALTER TABLE "Site" ADD COLUMN "githubInstallationId" TEXT;
ALTER TABLE "Site" ADD COLUMN "githubRepositoryId" TEXT;
ALTER TABLE "Site" ADD COLUMN "githubAccessLostAt" TIMESTAMP(3);
