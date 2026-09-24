-- The earlier market-readiness pass gave WebsitePurchase its own standard
-- price, its own cancellation dates and its own failed-payment counter. The
-- Paystack safety pass that followed does all three properly — the price is
-- changed on the plan at the processor and recorded only once accepted, the
-- cancellation claims a billing state before calling out and parks the row when
-- the call fails, and the state of a subscription comes from Paystack rather
-- than from a number we increment. Two sources of truth about what somebody is
-- charged is worse than either one of them, so the superseded columns go.
--
-- Safe to drop: they were added earlier today, the Website Builder has no paying
-- customers yet, and the seeded test accounts are not created on a deployment.
ALTER TABLE "WebsitePurchase" DROP COLUMN IF EXISTS "standardMonthlyPrice";
ALTER TABLE "WebsitePurchase" DROP COLUMN IF EXISTS "standardPriceAppliedAt";
ALTER TABLE "WebsitePurchase" DROP COLUMN IF EXISTS "cancelRequestedAt";
ALTER TABLE "WebsitePurchase" DROP COLUMN IF EXISTS "cancelReason";
ALTER TABLE "WebsitePurchase" DROP COLUMN IF EXISTS "endsAt";
ALTER TABLE "WebsitePurchase" DROP COLUMN IF EXISTS "failedPaymentCount";
ALTER TABLE "WebsitePurchase" DROP COLUMN IF EXISTS "lastPaymentFailedAt";
