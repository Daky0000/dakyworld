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

### 2. Paystack must be able to take both currencies

Ghana is billed in GHS, everywhere else in USD. A Paystack account that is not
enabled for USD will fail at checkout for every customer outside Ghana, and the
failure will look like a bug in the product. Confirm with Paystack support
before advertising outside Ghana, or restrict sales to GHS until they do.

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

## Decisions taken that you may want to change

**The dollar prices are a placeholder.** The tiers were written as $3/$10/$25
while the site advertised GHS 300 — about $25 — for the same product, so
everybody outside Ghana would have paid roughly an eighth of the Ghanaian
price. The dollar column is now set near parity (\$25/\$75/\$195 promotional).
Whether that is what this is worth in Lagos or London is a commercial judgement
that has not been made; `src/services/websitePricing.ts` is the one file to
change.

**Three declined payments pause editing, and never take a site offline.** A
published website keeps being served whatever happens to the card. What a
customer loses is the ability to change it. Taking a business's website off the
internet over an expired card is the most expensive mistake available here.

**Cancelling serves out the paid period.** The processor is told immediately so
no further charge is raised, and `endsAt` keeps the entitlement alive until the
period the customer paid for runs out.

## Deliberately not built

**Media is still stored in Postgres.** Images are bytes in the database, served
with an ETag. At 500 MB per Pro customer and 5 GB per Business, this will become
the largest line on the database bill and the slowest path in the product. The
fix is an object-storage adapter (R2/S3/Cloudinary) with a CDN in front, and it
was left out of this pass by choice. It is the next piece of infrastructure
work, before volume rather than after it.

**No error reporting.** Render crashes now show a message and a reference
rather than a white screen, and that reference is in the server log, but nothing
alerts anybody. Wiring `@sentry/node` behind an env var is an hour's work when
you want it.

**Custom domain certificates are manual** — see above.

## Where things are

| Concern | File |
| --- | --- |
| Who is entitled to what | `src/services/websiteEntitlement.ts` |
| Prices, both currencies | `src/services/websitePricing.ts` |
| Tier features and quotas | `src/services/websiteTierPlans.ts` |
| Buying, cancelling, dunning counters | `src/services/websiteCommerce.ts` |
| Declined payments and what they do | `src/services/websiteDunning.ts` |
| Passwords, verification, first login | `src/services/accountAccess.ts` |
| Serving hosted sites, custom domains | `src/services/websiteHosting.ts` |
| Export and erase | `src/services/websiteSubscriberSelfService.ts` |
| The rules, asserted | `checks/websiteEntitlement.ts` |
