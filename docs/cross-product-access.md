# Cross-product access: DakyXTech OS × Marketing SaaS

**Status:** built, 16 Oct 2026, in both repositories. Sections 1–8 are the
design as it was argued; **§0 is what shipped, how to switch it on, and where
it differs from the design.** Supersedes the ChatGPT draft ("Dakyworld ×
Marketing SaaS Integration Plan").

**The promise being enforced:** a client on a retainer gets every DakyX product.
Somebody who bought only the Website Builder gets the Website Builder. Somebody
who bought only the Marketing SaaS gets the Marketing SaaS.

| | DakyXTech OS (this repo) | Marketing SaaS (`Daky0000/Saas`) |
|---|---|---|
| Host | `os.dakyx.com`, `editor.dakyx.com` (Railway) | `marketing.dakyx.com` (Railway, Docker) |
| Users | Prisma `User`, email + password + TOTP | `users` table, email/password + social login |
| Session | DB row, hashed token, `__Host-` cookie | 7-day JWT in `localStorage` (`auth_token`) |
| What they paid for | `CarePlan` (retainers), `WebsitePurchase` (builder seats), `Product` | `subscriptions` → `pricing_plans`, credits |
| Plan → limits | `Entitlement.tier` (EDITOR / CARE / MANAGED) | `getUserPlanName()` → `resolvePlanQuotaLimits()` |

---

## 0. As built

### Where it lives

| | OS (this repo, `server/`) | Marketing SaaS (`Daky0000/Saas`, `packages/`) |
|---|---|---|
| The decision | `src/services/entitlements.ts` (`decideEntitlements`, `entitlementsFor`, `RETAINER_TIERS`) | `user-auth.ts` `getEffectivePlan()`; `middleware/planQuotaMiddleware.ts` tier keys |
| Sign-in | `src/routes/partner.ts` + `src/services/oauth.ts`; `/sso/continue` in `client/src/main.tsx` | `api/src/server/dakyxRoutes.ts`; "Continue with DakyX" in `web/src/pages/Auth.tsx` |
| Change events | `EntitlementEvent` outbox, `src/services/entitlementEvents.ts`, delivered every 15 s by `backgroundRuntime.ts` | `POST /api/internal/dakyx/events`, hourly `reconcileDakyxGrants()` |
| Screens | "People with access" on the client page (`components/ClientPeople.tsx`); Marketing link in the nav; "included with your DakyX retainer" on the plan panel | Billing banner; plan name and source in the sidebar |
| Proof | `checks/entitlements.ts` (37), `checks/oauth.ts` (35); `tmp/crossProductE2E.ts` drives both real servers | `test/dakyx.test.ts` (runs on CI's Postgres) |

### Switching it on

Nothing happens until these are set. Without them the Marketing link still
shows in the OS nav but the SaaS hides "Continue with DakyX", and no events are
queued.

Generate two long random values: **CLIENT_SECRET** and **PARTNER_KEY**.

**OS service (Railway, `server`):**

```
OAUTH_ISSUER=https://os.dakyx.com
OAUTH_CLIENT_MARKETING_SECRET=<CLIENT_SECRET>
OAUTH_CLIENT_MARKETING_REDIRECTS=https://marketing.dakyx.com/api/auth/dakyx/callback
PARTNER_MARKETING_API_KEY=<PARTNER_KEY>
PARTNER_MARKETING_EVENTS_URL=https://marketing.dakyx.com/api/internal/dakyx/events
MARKETING_APP_URL=https://marketing.dakyx.com
```

**SaaS service:**

```
DAKYX_BASE_URL=https://os.dakyx.com      # the host customers sign in at; app.dakyx.com works too
DAKYX_ISSUER=https://os.dakyx.com        # must equal the OS's OAUTH_ISSUER
DAKYX_CLIENT_SECRET=<CLIENT_SECRET>
DAKYX_PARTNER_KEY=<PARTNER_KEY>
# optional: DAKYX_CLIENT_ID (default "marketing"), DAKYX_REDIRECT_URI
```

Then, on each retainer client's page in the OS, add the people under
**People with access**. The migration already added everyone who paid for a
builder seat to that seat's client.

### Decisions taken (§7), as proposed

- **D1:** only `CarePlan.status = ACTIVE` counts. Paused and churned give nothing.
- **D2:** every retainer → builder MANAGED. Marketing: Foundation → growth,
  Growth → pro, Transformation → agency. Change it in `RETAINER_TIERS`; a
  check fails if it names a tier a product does not have.
- **D3:** any active OS account may use "Continue with DakyX". With no grant it
  lands on the SaaS's own Free plan.
- **D4:** billing stays where it is. A grant only ever raises a plan.
- **D5:** per person. Every member of a retainer client gets their own SaaS
  account.

### Where it differs from the design below

- **Codes are their own table (`OAuthCode`), not a new `AuthToken` kind.**
  They carry the client, the redirect and the PKCE challenge, which
  `AuthToken` has no columns for. This also avoids the two-migration enum dance.
- **The SaaS reuses its own `social_login_identities` table** (provider
  `dakyx`, subject = OS `User.id`) instead of a new `external_identities`. A
  partial unique index keeps it to one DakyX account per SaaS user.
- **An existing SaaS account with the same email is linked when the OS says the
  address is verified.** This is the rule the SaaS's Google and GitHub sign-in
  already used. An OS address is verified only after its owner followed an
  emailed link. An unverified match is still never merged: the person signs in
  with their password and the link completes then (§4.3 case 4).
- **The SaaS callback always lands on `/login#auth_token=…`**, which its SPA
  already handles. The `next` parameter is accepted and ignored.
- **The SaaS's DakyX routes are mounted before its social-auth router.** That
  router's `/api/auth/:provider/start` took "dakyx" for an unknown provider and
  answered 404. Only the two-server run caught it. `test/dakyx.test.ts` now
  asserts the order.
- **Two SaaS defects fixed on the way:** Pro allowed 8 social accounts (now
  50), and the SPA never copied `planName` from `/auth/me`, so every paying
  customer's sidebar said "Free".
- **No `Product` row for `marketing-suite`.** `publicCatalogue()` maps every
  product to a builder tier, so a Marketing row would have shown on dakyx.com
  priced as the Starter editor. The product keys live in `PRODUCT_KEYS` instead.

---

## 1. What the ChatGPT plan got wrong

The draft is a sound **single sign-on** plan. But SSO wasn't what was asked
for. The ask was **entitlements**: who is on a retainer, and so who gets
what. The draft puts that last (§10, "do not combine subscription records…
before defining a separate entitlement contract") and never defines the
contract. Built in its order, the result is a login button that drops a
retainer client into the SaaS on the Free plan.

Four things it could not see without reading both codebases:

1. **The rule already exists here, and nothing enforces it at sign-in.**
   `Product`'s schema comment says *"a client on an active retainer gets every
   product at no charge"*, and `productAccess()` in `services/products.ts` is
   meant to be the one place that decides it. Only the onboarding screen calls
   it. The function that decides what a signed-in person may do,
   `loadEntitlement()` in `services/websiteEntitlement.ts`, looks at
   `WebsitePurchase` and the `website.manage` permission only. `sitePayer()`
   even says so: *"Null when there is none — … a client on a retainer rather
   than a subscription"*. **Today a retainer client who signs in to the builder
   gets Starter.** This has to be fixed before another product can depend on
   it.

2. **A `User` is not linked to a `Client`, and a retainer belongs to a
   `Client`.** `CarePlan.clientId` names a business, but nothing says which
   people belong to that business. The only links are indirect:
   `WebsitePurchase.userId` and `Site.clientId`. So "is this person on a
   retainer" cannot be answered for anyone yet. This missing table is the real
   foundation of the integration, and the draft never mentions it.

3. **The SaaS decides limits by substring-matching the plan's name.**
   `resolvePlanQuotaLimits("Business Growth")` returns `growth` because the
   name contains "business". `"Pro"` matches any name containing "pro". And
   the `pro` tier allows **8** social accounts where `starter` allows **10**.
   A grant from the OS must name an explicit tier key, never a display name
   that this function will guess at.

4. **Both sides already have half the plumbing.** The OS has hashed,
   single-use, expiring tokens (`AuthToken`) and HMAC-signed outbound webhooks
   with a delivery id (`lib/webhooks.ts`). The SaaS has a state table for its
   own social login (`login_oauth_states`) and an SPA that already accepts a
   token handed back in the URL fragment (`#auth_token=` in `pages/Auth.tsx`).
   The draft's "choose and configure an OIDC library" step is a week of work
   that these pieces mostly make unnecessary for two first-party apps.

Things the draft gets right, which this plan keeps: separate databases,
separate deploys, the OS as identity provider, the authorization-code flow
with a back-channel exchange, never matching accounts on email alone, never
widening the OS cookie to `.dakyx.com`, and no `VITE_*` secrets.

---

## 2. The design in one paragraph

**The OS is the system of record for *who has paid for what*,** because it
already holds the retainers, the invoices and the builder seats. It answers one
question over an authenticated API: *"what is this person entitled to,
product by product?"* Each product keeps its own login, its own data and its
own billing for people who buy it directly. It then takes **the higher of**
its own local plan and the grant from the OS. Single sign-on comes second. It
is how a person proves to the SaaS which OS account they are. No database is
shared, and neither app reads the other's tables.

```
                     ┌──────────────────────────── DakyXTech OS ─────────────────────────────┐
  CarePlan (ACTIVE) ─┤                                                                        │
  WebsitePurchase   ─┼─► entitlementsFor(userId) ──► GET  /api/partner/v1/entitlements/:sub   │◄── SaaS pulls (sign-in, hourly)
  ClientMember      ─┤          (one function)   ──► POST signed "entitlements.changed"       │──► SaaS webhook (on change)
                     │                              /oauth/authorize, /oauth/token            │◄── SSO (proves who :sub is)
                     └────────────────────────────────────────────────────────────────────────┘
                                                           │
                     ┌──────────────────────── Marketing SaaS ───────────────────────────────┐
                     │ external_identities (issuer, subject) → users.id                       │
                     │ plan_grants (user_id, source='dakyx', tier, valid_until, version)      │
                     │ effectivePlan(user) = max(local subscriptions row, live plan_grant)    │
                     └────────────────────────────────────────────────────────────────────────┘
```

---

## 3. The OS side

### 3.1 Link people to clients: `ClientMember`

```prisma
/// Who belongs to a client business. A retainer is the client's, so this is
/// what makes "is this person on a retainer" answerable.
model ClientMember {
  id        String           @id @default(cuid())
  clientId  String
  client    Client           @relation(fields: [clientId], references: [id], onDelete: Cascade)
  userId    String
  user      User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// OWNER can add and remove members. MEMBER inherits the client's products.
  role      ClientMemberRole @default(MEMBER)
  addedById String?
  createdAt DateTime         @default(now())

  @@unique([clientId, userId])
  @@index([userId])
}
```

It is set by staff on the client page ("People with access"), or by a client
OWNER inviting a colleague through the same invite path `accountAccess.ts`
already uses. It is **never inferred from an email domain**: `@gmail.com`
retainer contacts are the normal case in this market. Backfill once from
`WebsitePurchase.userId → clientId`, which is the one existing link that a
person proved by paying.

### 3.2 One function decides: `entitlementsFor(userId)`

`services/entitlements.ts`. Pure decision + one query, in the shape of
`decideAccess` / `stillEntitled`, so `checks/` can test it without HTTP.

```ts
type ProductKey = "website-builder" | "marketing-suite";   // Product.key
type Grant = {
  product: ProductKey;
  tier: string;              // explicit key in that product's vocabulary
  source: "retainer" | "subscription" | "staff" | "comp";
  clientId: string | null;
  validUntil: string | null; // ISO; null = open-ended while the source stands
};
type Entitlements = { subject: string; version: number; grants: Grant[] };
```

Rules, in order:

1. Inactive user, or `deletionScheduledFor` set → **no grants**.
2. Any `ClientMember` whose client has a `CarePlan` with `status: ACTIVE` →
   every active `Product`, at the tier `RETAINER_TIERS` maps that retainer to
   (decision D2). `PAUSED` grants nothing new. A paused retainer pays nothing,
   so it includes nothing.
3. Their own `WebsitePurchase` that `stillEntitled()` accepts → that tier, for
   the builder only. A retainer and a seat together → the higher one.
4. `website.manage` staff → as today, builder only. Staff do **not** get
   Marketing SaaS grants from a permission. A comp is an explicit row (5).
5. A `ProductGrant` row (`userId`, `productKey`, `tier`, `validUntil`,
   `reason`, `grantedById`) for comps, trials, partners. Without it, every
   exception becomes a fake CarePlan.

`version` is a counter bumped on every change to anything above, so a
receiver can drop an out-of-order event.

**Then `loadEntitlement()` calls it.** The builder becomes the first consumer
of its own rule, and the "retainer gets Starter" defect closes on the same
change. `productAccess()` should be rewritten on top of it, or deleted, so
there are not two answers.

### 3.3 Identity provider (minimal authorization-code flow, not full OIDC)

There is one client, it is ours, and it is confidential (it has a backend).
That needs four properties, not a provider framework:

| Endpoint | Does |
|---|---|
| `GET /oauth/authorize?client_id&redirect_uri&state&code_challenge` | Requires the OS session (sends to `/login?next=` if none). Checks `client_id` and the **exact** `redirect_uri` against `PARTNER_CLIENTS`. Checks the user holds a grant for that client's product, or that the client allows sign-in without one (D3). Issues a code: an `AuthToken` row of a new kind `SSO_CODE`, 60 s, hashed, bound to client + redirect + PKCE challenge. 302s back with `code` and the caller's `state`. |
| `POST /oauth/token` | Basic auth with client id + secret (`timingSafeEqual`). Redeems the code in one `updateMany … where usedAt: null` (affected rows = 1, or refuse). Verifies the PKCE verifier and the redirect. Returns `{ sub, email, email_verified, name, entitlements }`. **No OS access token is issued.** The SaaS doesn't need to call the OS as the user, so nothing long-lived leaves. |

- `sub` is the OS `User.id` (a cuid; never reassigned). The issuer is
  `https://os.dakyx.com`. The pair `(issuer, sub)` is the identity; email is
  only an attribute.
- Codes are never logged. Add `code`, `code_verifier` and `client_secret` to
  the redaction in `instrument.ts` (Sentry) and `middleware/errorHandler.ts`.
- `SSO_CODE` is a new `AuthTokenKind` value, so it needs a migration of its
  own before the one that uses it (Postgres `55P04`, see CLAUDE.md).
- `PARTNER_CLIENTS` lives in env (`PARTNER_CLIENT_MARKETING_SECRET`,
  `PARTNER_CLIENT_MARKETING_REDIRECTS`), comma-separated, exact match.
- The token route takes `application/x-www-form-urlencoded`, as OAuth
  clients send it, so it needs its own `urlencoded` parser.
- `/oauth/authorize` on `editor.dakyx.com` must 404: `appSurface.ts` decides
  which host may serve what.

If a third product ever arrives, *that* is the point to put `oidc-provider`
behind the same two URLs. The SaaS side would not change.

### 3.4 Partner API and change events

- `GET /api/partner/v1/entitlements/:sub` takes a bearer **service key**
  (separate from the SSO client secret, hashed at rest, scoped to read
  entitlements). It returns the `Entitlements` above. It is rate-limited and
  every call is audited. The SaaS calls it at every sign-in and in an hourly
  reconcile.
- When anything in §3.2 changes for someone, the OS enqueues
  `entitlements.changed { sub, version }` to the SaaS's webhook URL. It uses
  the existing signed delivery in `lib/webhooks.ts` (HMAC, timestamp,
  delivery id, retries). That covers a `CarePlan` status change, a
  `ClientMember` added or removed, a builder subscription state change, and a
  `ProductGrant` expiring. **The event carries no tiers.** The receiver
  fetches them. A forged or replayed event then costs one extra GET and
  grants nothing.
- Add a `marketing-suite` `Product` row so the public price block and
  `publicCatalogue()` can list it, and so the retainer rule picks it up
  automatically.

---

## 4. The SaaS side

All of it is additive. Password login, social login and its own Stripe /
Paystack / Hubtel billing keep working for people who never touch the OS.

### 4.1 Tables (in `db-migrations.ts`, its convention)

```sql
CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (issuer, subject),
  UNIQUE (user_id, issuer)
);

CREATE TABLE IF NOT EXISTS plan_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,              -- 'dakyx'
  tier TEXT NOT NULL,                -- a PLAN_QUOTA_BY_TIER key, never a display name
  reason TEXT NOT NULL,              -- 'retainer' | 'comp' | …
  valid_until TIMESTAMPTZ,
  version BIGINT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source)
);
```

`subscriptions` has `UNIQUE(user_id)` and belongs to the SaaS's own billing.
A grant must not be written into it. If it were, the first time the person
bought something locally one row would overwrite the other.

### 4.2 Effective plan

`getUserPlanName()` becomes `getEffectivePlan(userId)` → `{ tier, source }`:
the higher of the local subscription's tier and a `plan_grants` row whose
`valid_until` is null or in the future. Tier order is `free < starter < growth
< pro < agency`. **Fix `pro.social_accounts` (8 → more than growth's 25)
first,** or "higher" is not higher. `checkPlanQuota` takes the tier key
directly. The name-guessing in `resolvePlanQuotaLimits` stays only for local
plans, until `pricing_plans` gets a real `tier` column.

Billing UI: when `source = 'dakyx'`, show "Included with your DakyX
retainer". Hide upgrade prompts below that tier. Don't offer checkout for a
plan they already have.

### 4.3 SSO routes (`server/ssoRoutes.ts`)

- `GET /api/auth/dakyx/start?next=/path`: creates `state` + PKCE verifier in
  `login_oauth_states` (provider `dakyx`, 10 min) and redirects to the OS.
  `next` must be a same-origin path starting with `/` and not `//`.
- `GET /api/auth/dakyx/callback`: consumes `state` with the existing
  `DELETE … RETURNING`, posts the code to `/oauth/token` from the server, then:
  1. `(issuer, sub)` found in `external_identities` → that user.
  2. Not found, and the browser already carries a valid SaaS session →
     **link** to that user (the person has proved both identities). This is
     how existing customers connect.
  3. Not found, no session, and no SaaS user has this email → **create** the
     user (random unusable password, `email_verified` from the claim) and the
     mapping.
  4. Not found, no session, but a SaaS user **does** have this email →
     **do not merge**. Send them to "Sign in to your Marketing account once to
     connect it", and on success run case 2.
  5. Upsert `plan_grants` from the `entitlements` in the token response.
  6. Issue the normal SaaS JWT and redirect to `/${next}#auth_token=…`. The
     fragment is not sent to servers or logged, and `Auth.tsx` already reads
     it.
- `POST /api/internal/dakyx/events`: verifies the signature and timestamp
  (5-minute window), dedupes the delivery id, ignores a `version` ≤ the stored
  one, then GETs `/api/partner/v1/entitlements/:sub` and upserts
  `plan_grants`. An unknown `sub` is a no-op.
- An hourly job re-fetches every linked identity, which covers a missed event.
  **If the OS is unreachable, keep the last grant until `synced_at` + 72 h,
  then fall back to the local plan.** A retainer client shouldn't lose access
  because os.dakyx.com redeployed. A churned one shouldn't keep it for a month
  either.

### 4.4 Revocation and logout

The SaaS JWT lives 7 days and is checked against `token_version`. When a
grant **drops** (churn, removed from a client, account deleted), the event
handler bumps `token_version` only if the user has no local paid plan, which
signs them out everywhere. Otherwise their next request simply runs on the
lower tier. Logout stays local in both apps for v1. The OS "Sign out" doesn't
sign anyone out of marketing.dakyx.com, and that is stated on the sign-out
screen.

---

## 5. The navigation people actually see

- In the OS/editor shell: a **Marketing** item. It goes to
  `marketing.dakyx.com/api/auth/dakyx/start?next=/dashboard`. It is shown
  when the user holds a `marketing-suite` grant, and shown as an upsell when
  they don't.
- On the SaaS login page: **Continue with DakyX** beside the social buttons.
- In the SaaS: the footer link `os.dakyx.com` (already there) becomes
  "Website Builder". It is visible when the grant list includes
  `website-builder`.

---

## 6. Order of work

Each phase ships on its own and is useful on its own.

| # | Where | What | Done when |
|---|---|---|---|
| 1 | OS | `ClientMember` + backfill + "People with access" on the client page; `entitlementsFor()`; `loadEntitlement()` uses it | A retainer client signed in to the editor gets the retainer tier. `checks/entitlements.ts` covers active / paused / churned retainer, seat + retainer, deleted user, comp expiry |
| 2 | SaaS | `plan_grants`, `getEffectivePlan()`, `pro` limit fix, billing banner; grants written by hand with a seed script | A hand-inserted grant changes quotas and the billing page; removing it reverts them |
| 3 | OS | `/oauth/authorize`, `/oauth/token`, `SSO_CODE` token kind, partner key, `/api/partner/v1/entitlements`, `entitlements.changed` events | Check: a code redeems once, expires in 60 s, refuses a wrong redirect / client / verifier, and a user with no grant is refused when D3 says so |
| 4 | SaaS | SSO routes, `external_identities`, event receiver, hourly reconcile | End-to-end on staging: OS-only customer, SaaS-only customer linking, email collision, churn → downgrade within one event |
| 5 | both | Nav links, "Continue with DakyX", feature flag `DAKYX_SSO_ENABLED` removed | — |

Phases 1 and 2 need no cross-app traffic at all. Phase 1 fixes a promise
that is broken today on the builder alone.

---

## 7. Decisions only you can make

- **D1. Who is "on a retainer"?** Proposed: a `CarePlan` with
  `status = ACTIVE`. `PAUSED` grants nothing. An invoice overdue on an ACTIVE
  plan still grants (dunning stays a billing matter, as with the builder).
- **D2. What tier does each retainer give?** Proposed:

  | Retainer | Website Builder | Marketing SaaS |
  |---|---|---|
  | Foundation | MANAGED | growth |
  | Growth | MANAGED | pro |
  | Transformation | MANAGED | agency |

  `publicCatalogue()` already tells the public "Included at no extra cost
  with every DakyXTech retainer" across all three builder tiers. That reads as
  MANAGED for everyone. Confirm it.
- **D3. May an OS user with no Marketing grant use "Continue with DakyX"?**
  Proposed: yes. They land on the SaaS Free plan and can buy there. The
  alternative turns SSO into a paywall for an account they already have.
- **D4. Does Marketing SaaS ever bill through the OS** (one invoice for
  both)? Proposed: not now. Local billing stays, and the OS grant only ever
  raises a plan. Revisit if a "builder + marketing" bundle is sold without a
  retainer. That would be a `Product` + `WebsitePurchase`-style row on the OS,
  and nothing on the SaaS would change.
- **D5. Per person or per business on the SaaS?** Proposed v1: per person.
  Every `ClientMember` of a retainer client gets their own SaaS account at the
  granted tier. Mapping a `Client` to a SaaS org (`orgRoutes.ts`) so a team
  shares one workspace is the natural v2.

---

## 8. What not to do

- **Don't share a database or a `DATABASE_URL`**, even read-only. The SaaS
  creates its schema at boot with `CREATE TABLE IF NOT EXISTS` and
  `ALTER … ADD COLUMN IF NOT EXISTS`. Pointed at the OS's database, it would
  write its tables into it.
- **Don't widen the OS cookie to `.dakyx.com`.** `lib/session.ts` uses the
  `__Host-` prefix precisely so nothing on a sibling subdomain can plant or
  read a session.
- **Don't send tiers in the webhook, and don't trust a plan name from a
  browser or a JWT claim.** Grants arrive only over the authenticated GET or
  the token response.
- **Don't link accounts on matching email.** It is case 4 above, and it is
  the account-takeover path.
- **Don't let a Dakyworld/OS role become a SaaS admin.** `role` on the SaaS
  `users` row is set only by the SaaS.
