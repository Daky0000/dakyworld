-- Second factor on a user account. See server/src/lib/totp.ts.
--
-- Purely additive: every column is nullable or defaulted, so existing rows
-- become "two-factor not set up" and nobody is locked out by the deploy.
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpConfirmedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "totpRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN "totpLastStep" INTEGER;
