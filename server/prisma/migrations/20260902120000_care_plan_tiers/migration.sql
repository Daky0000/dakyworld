-- The care plan tiers become the ones dakyworld.com sells.
--
-- The enum still said SME_ESSENTIALS / GROWTH / ENTERPRISE_CONCIERGE months
-- after the site had renamed the plans to Foundation / Growth / Transformation
-- and repriced them, so an invoice named a product the pricing page no longer
-- had. `ALTER TYPE ... RENAME VALUE` keeps every existing row: a plan on
-- SME_ESSENTIALS is on FOUNDATION afterwards, which is the same plan under the
-- name its client already reads on the website. No row is rewritten and no
-- price moves here — repricing an existing plan is a decision, not a migration.
ALTER TYPE "CarePlanTier" RENAME VALUE 'SME_ESSENTIALS' TO 'FOUNDATION';
ALTER TYPE "CarePlanTier" RENAME VALUE 'ENTERPRISE_CONCIERGE' TO 'TRANSFORMATION';

-- The Founding Partner rate: a lower monthly for an agreed number of months,
-- then the standard rate. Both nullable and both null on every existing row —
-- no plan sold before today was sold on a promotional rate, and inventing a
-- standard fee for one would be inventing a price rise.
ALTER TABLE "CarePlan" ADD COLUMN     "standardMonthlyFee" DECIMAL(12,2),
ADD COLUMN     "foundingRateUntil" TIMESTAMP(3);
