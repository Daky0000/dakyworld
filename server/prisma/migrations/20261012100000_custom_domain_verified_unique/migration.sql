-- A custom domain is unique only among websites that have proved they own it.
--
-- "Site_customDomain_key" made the column unique among *claims*, and a claim is
-- stored before anything is proved. Anybody could type another business's domain
-- into the Hosting panel and the real owner could then never add it: the claim
-- sat there unverified, refusing them, for ever. Now any number of websites may
-- claim a domain; verifyCustomDomain lets the first one to publish the TXT
-- record win it and clears the others, and this index stops two proofs racing
-- each other to both win.
--
-- Prisma cannot express a partial index, so schema.prisma declares only the
-- plain @@index([customDomain]) below and this one lives here alone.
-- `prisma migrate diff` against a database carrying it reports no difference
-- today; if a later Prisma ever offers to drop it, take that line out of the
-- generated script, or the domain-squatting hole reopens as a race.
CREATE UNIQUE INDEX "Site_customDomain_verified_key" ON "Site"("customDomain") WHERE "customDomainVerifiedAt" IS NOT NULL;

-- Lookups by domain (serving, claiming, verifying) still want an index.
CREATE INDEX "Site_customDomain_idx" ON "Site"("customDomain");

DROP INDEX "Site_customDomain_key";
