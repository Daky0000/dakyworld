-- When a subscription went past due. With no paid-up date, the fortnight before
-- editing pauses ran from "updatedAt", and every Paystack event rewrites the
-- row, so each further declined charge started the fortnight again and the
-- notice it sent always read as the first one.
ALTER TABLE "WebsitePurchase" ADD COLUMN "pastDueSince" TIMESTAMP(3);

-- Rows already past due: nothing recorded when they went past due, so they
-- start from their last write. That write is no earlier than the one that
-- marked them past due, so the date is late rather than early, and it is
-- exactly the date the lock and the notices were counted from the moment before
-- this ran: nobody's editing pauses sooner because of it, and only the next
-- event stops resetting it. The log of past-due notices was not used; it cannot
-- tell this spell from an earlier one, and an early date would pause somebody's
-- editing the moment this deployed.
UPDATE "WebsitePurchase" SET "pastDueSince" = "updatedAt" WHERE "billingState" = 'PAST_DUE';
