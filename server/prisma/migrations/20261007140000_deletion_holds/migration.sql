-- A deleted website or customer account is held for 30 days before it is
-- erased: offline and switched off at once, recoverable until then.
ALTER TABLE "Site" ADD COLUMN "deletionScheduledFor" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deletionScheduledFor" TIMESTAMP(3);
CREATE INDEX "Site_deletionScheduledFor_idx" ON "Site"("deletionScheduledFor");
