# Launching the Website Builder

What is built, what still needs your hands, and what was deliberately left out.
Written 24 September 2026, alongside the market-readiness work.

## What needs doing outside the code

These cannot be done from here. Nothing below is optional if you intend to sell
the product to strangers.

### 1. The hosting domain (blocks hosted publishing)

Hosted sites are served at `<hostedSlug>.<WEBSITE_HOST_DOMAIN>`. Until that
variable is set, a site with no repository still publishes — the HTML is stored
and the editor works — but there is no address to give the customer.

1. Pick the domain, e.g. `sites.dakyworld.com`.
2. In Cloudflare (or whoever runs DNS for dakyworld.com), add a **wildcard**
   record: `*.sites` → the Railway service. Railway needs the wildcard added as
   a custom domain on the service so it will answer for it, and it issues the
   certificate.
3. Set `WEBSITE_HOST_DOMAIN=sites.dakyworld.com` in the Railway service
   variables.

A customer's own domain then needs, on their side: a `TXT` at
`_dakyworld.<their domain>` carrying the token the panel shows, and a `CNAME`
pointing their domain at `<hostedSlug>.sites.dakyworld.com`. The editor's
Hosting panel prints both, and the Verify button reads the TXT record.

**Certificates for customer domains.** Railway issues a certificate for each
custom domain you add to the service. Adding it is currently manual: when a
customer verifies a domain, add it in the Railway dashboard. Automating that
needs the Railway API and is not built.

### 2. Set the merchant exchange rate

Everything is charged in cedis. The catalogue holds dollar prices and
`PAYSTACK_USD_GHS_RATE` converts them at checkout — it defaults to 12, and it
is the number the customer is billed on, so set it deliberately on the Railway
service rather than leaving it to a default.

One settlement currency is not a limitation here, it is what makes the billing
safe: `paystackEvents.ts` compares the amount Paystack reports against the
amount it expects before it accepts a subscription state, and that comparison
is impossible across two currencies. A customer's accepted GHS prices are
fixed on their purchase, so a later rate change never re-prices somebody who
has already bought.

An earlier pass billed Ghana in cedis and everyone else in dollars. That was
reversed on 24 September 2026 in favour of the above.
### 3. Email must be configured

Every self-serve flow — the first password after a purchase, a forgotten
password, an address confirmation, a declined-payment notice — sends mail
through the SMTP credentials under Settings. With none configured, the links
are written to the server log instead and nothing reaches the customer. On a
deployment that means a customer pays and never receives a way in.

### 4. Point an uptime monitor at `/api/ready`

`/api/health` answers while the process is alive, which is exactly the state an
outage with a dead database also has. `/api/ready` asks the database a question
and answers 503 when it cannot. Any free monitor (UptimeRobot, Better Stack)
watching that URL will tell you before a customer does.
Railway's deployment health check also uses `/api/ready`. Configure an
independent monitor and an alert recipient; the Railway check alone cannot
notify the team about every later outage.

### 5. Prove database backup and restore

Enable scheduled, encrypted Postgres backups with retention outside the live
database. Restore a backup into an isolated database, run migrations and a
read-only smoke test, and record the restore time. Repeat this before launch
and after schema changes. Website pages, version history, media and billing
state all live in Postgres; a successful backup job without a restore drill is
not sufficient evidence that customer sites can be recovered.

### 6. Watch application errors

Route server logs and browser errors to an alerting service, with secrets and
customer page contents redacted. Test an alert end to end. The current browser
error boundary shows a failure to the user but does not notify the team.

## Decisions taken that you may want to change

**The prices are $25 / $75 / $195 promotional, $40 / $120 / $320 standard**,
held in dollars in the catalogue and charged in cedis at the merchant rate —
GHS 300, 900 and 2,340 at a rate of 12, which keeps the GHS 300 the site has
always advertised. They were briefly $3 / $10 / $25, which at the same rate
would have been GHS 36 for a product advertised at GHS 300.

**Watch the pair.** The promotional price comes from the catalogue and the
standard price from the tier table. When those two moved currency separately,
the standard charge came out below the promotional one — a customer's bill
would have *fallen* after their introductory period. `checks/products.ts`
asserts the relationship now.

**Two weeks past due pauses editing, and never takes a site offline.** A
published website keeps being served whatever happens to the card. What a
customer loses is the ability to change it. Taking a business's website off the
internet over an expired card is the most expensive mistake available here.

**Cancelling serves out the paid period.** The processor is told immediately so
no further charge is raised, and `nextBillingAt` keeps the entitlement alive
until the period the customer paid for runs out.

## Deliberately not built

**Media is still stored in Postgres.** Images are bytes in the database, served
with an ETag. At 500 MB per Pro customer and 5 GB per Business, this will become
the largest line on the database bill and the slowest path in the product. The
fix is an object-storage adapter (R2/S3/Cloudinary) with a CDN in front, and it
was left out of this pass by choice. It is the next piece of infrastructure
work, before volume rather than after it.

**No error alerting service.** Render crashes show a message and a reference
rather than a white screen, but nothing automatically alerts anybody yet.

**Custom domain certificates are manual** — see above.

## Where things are

| Concern | File |
| --- | --- |
| Who is entitled to what | `src/services/websiteEntitlement.ts` |
| Prices for the screens | `src/services/websitePricing.ts` |
| The price a customer is actually charged | `src/services/paymentQuote.ts` |
| Billing state, reconciliation, price rises | `src/services/paystackEvents.ts` |
| Tier features and quotas | `src/services/websiteTierPlans.ts` |
| Buying, cancelling, dunning counters | `src/services/websiteCommerce.ts` |
| Declined payments and what they do | `src/services/websiteDunning.ts` |
| Passwords, verification, first login | `src/services/accountAccess.ts` |
| Serving hosted sites, custom domains | `src/services/websiteHosting.ts` |
| Export and erase | `src/services/websiteSubscriberSelfService.ts` |
| The rules, asserted | `checks/websiteEntitlement.ts` |
