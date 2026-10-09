-- Checkout looks an account up by the email the buyer typed, so a purchase can
-- point at somebody else's existing account. The payment-return page may hand a
-- set-password token to the browser only when the purchase created the account
-- itself, and this is how it knows. Existing purchases default to false: their
-- buyers use the emailed link, which proves they own the inbox.
ALTER TABLE "WebsitePurchase" ADD COLUMN "accountCreated" BOOLEAN NOT NULL DEFAULT false;

-- A token shown to a browser proves somebody paid, not that they own the
-- address, so redeeming one must not mark the email verified.
ALTER TABLE "AuthToken" ADD COLUMN "viaBrowser" BOOLEAN NOT NULL DEFAULT false;
