# Paystack payments

## Commercial configuration

This integration is configured for a Ghana merchant account. Website prices may
remain in USD; checkout converts them to GHS at the merchant-approved rate of
**GHS 12 per USD**. `PAYSTACK_USD_GHS_RATE` overrides that default. The customer sees
the exact GHS amount, renewal schedule and standard renewal price before accepting
recurring billing. Existing purchases retain their accepted GHS prices when the
rate changes. This is a merchant rate, not a live foreign-exchange feed.

At the current catalogue prices, Starter is GHS 36/month initially and GHS 60/month
after the three-month introductory period. Pro is GHS 120 then GHS 192. Business
is GHS 300 then GHS 540. The existing annual offer charges ten introductory monthly
prices for the first year; subsequent years charge ten standard monthly prices.
Annual purchases are never placed on monthly plans.

One-time invoices must already be denominated in GHS. Their Paystack checkout
uses the payment channels enabled on the merchant account. Subscription checkout
requires a card; mobile money and bank transfers are not treated as reusable card
authorizations. Dakyworld never receives a card number, CVV or OTP.

## Deployment

1. Back up the database, then apply `npx prisma migrate deploy` from `server/`.
   Migration `20260924150000_paystack_payment_safety` adds checkout records, a
   durable webhook queue, recurring receipts and billing/consent fields.
2. Build and deploy the server, admin client and public website together. The new
   public purchase API requires a quote ID, checkout UUID and explicit consent;
   old cached checkout JavaScript will not satisfy those requirements.
3. Configure `PAYSTACK_SECRET_KEY` through the existing secure Settings > Payments
   flow or deployment environment. Use test keys for acceptance testing and live
   keys only when ready to accept real payments. Do not put secret keys in public
   website assets. Keep `APP_SECRET` stable and back it up securely; it encrypts
   stored reusable authorizations. Set `APP_URL` to the HTTPS admin app origin.
4. Set the Paystack webhook URL to
   `https://os.dakyworld.com/api/webhooks/paystack` in the matching test/live mode.
   The callback URL is a return page, not proof of payment.
5. Ensure the scheduler runs. It drains accepted webhook events, retries failed
   verification, checks pending checkouts and updates promotional subscription
   plans before Paystack prepares their first standard-price invoice.
6. Enable **Accept international payments** in the Paystack dashboard and obtain
   Paystack approval. Ghana merchants charge GHS; the card issuer converts foreign
   currency and may charge conversion fees. Foreign-card acceptance depends on
   Paystack, merchant permissions and the issuer; code cannot guarantee approval.

## Operations and recovery

- Invoices now default to Paystack. Use **Create Paystack checkout**, **Open
  payment**, and **Check payment** in Invoices. Repeated checkout requests reuse
  the same recorded payment link. Server verification checks reference, amount,
  currency, provider, customer and test/live mode before granting value.
- Website setup payments move to `SETUP_PAID` after verification. Set a purchase
  to `READY` or `ACTIVE` in Website sales & bookings when setup is ready to start
  recurring billing. This requires recorded consent and an encrypted reusable card
  authorization. A prepaid first month/year is not charged again immediately.
- **Manage card / cancel billing** opens Paystack's hosted subscription management
  page. Treat its URL as sensitive. Customers can also use Paystack's subscription
  emails. Setting a purchase to `CANCELLED` disables provider renewal first; a
  provider failure does not silently mark cancellation complete locally.
- An ambiguous subscription POST becomes `UNCERTAIN`; it is never blindly retried.
  A verified `subscription.create` event can recover it. If that event is missing,
  locate the subscription in Paystack, then POST its `subscriptionCode` to
  `/api/products/website-commerce/purchases/:id/reconcile-billing` with an authorized
  admin session. The server checks the plan and billing customer before binding it.
- If checkout initialization times out, do not issue a different reference. Use
  **Check payment** and inspect the existing reference in Paystack. A hosted link
  might still be payable even if the customer closed the browser. A pending attempt
  without a saved URL requires operator reconciliation; this deliberately avoids
  issuing a second live checkout after an ambiguous provider response.
- Failed recurring charges set billing to `PAST_DUE`. Paystack does not retry a
  failed subscription installment automatically. Use hosted card management and
  agree any recovery charge with the customer; this integration does not silently
  replay a charge or create a replacement subscription.
- Refunds, disputes and expiring-card events appear as review alerts in Website
  sales & bookings. Review the original event in Paystack. This integration does
  not automatically refund money, decide disputes, or reverse accounting for a
  partial refund. Financial reconciliation remains an explicit operator action.
- Queue failures stay visible and retry with backoff. Events are acknowledged only
  after durable insertion; if storage fails, HTTP 503 lets Paystack retry. Payloads
  retain routing identifiers only, not raw card data, authorizations or email tokens.
- Provider and manual invoice settlement share an atomic conditional transaction:
  invoice status, setup activation and lifetime value commit together exactly once.
  Recurring receipts use a unique reference and an atomic lifetime-value update.
- Existing purchases without recorded consent or encrypted reusable authorizations
  cannot start new subscriptions automatically. Do not infer consent or migrate an
  old annual purchase to monthly billing; reconcile legacy records individually.

## Validation

Offline safety checks: `npx tsx checks/paystackSafety.ts`.
Product regression checks: `npx tsx checks/products.ts`.
Server types: `npx tsc --noEmit -p tsconfig.json`.
Client: `npm --prefix client run build`.
Public checkout browser check: `node checks/browser/paystack-checkout.mjs`, with
Playwright installed or `PLAYWRIGHT_URL` pointing to its installed module.

Before enabling real sales, test the migration against a staging PostgreSQL
database and use Paystack test mode to exercise successful and declined cards,
abandoned checkout, repeated webhooks, delayed verification, annual renewals,
failed renewals, cancellation and international-card eligibility. Offline mocks
and browser checks do not establish that the merchant account is live-ready.

## Provider references

- https://paystack.com/docs/payments/verify-payments/
- https://paystack.com/docs/payments/webhooks/
- https://paystack.com/docs/payments/subscriptions/
- https://paystack.com/docs/api/subscription/
- https://support.paystack.com/en/articles/2130690
