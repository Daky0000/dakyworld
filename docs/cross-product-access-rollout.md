# Rollout: switch on cross-product access (OS × Marketing SaaS)

**For: Claude Code in VS Code, on the Owner's machine, with Railway access.**
Written 17 Oct 2026 by the cloud session that built the feature. Read this file
completely before running anything. Background and design:
[cross-product-access.md](cross-product-access.md) (§0 is the as-built summary).

## What is already done

- **The code is merged and pushed.** The OS is on `Daky0000/dakyworld` `main`
  (commit `d27bd9d`); Railway deploys the `server/` service from it. The SaaS
  is on `Daky0000/Saas` `master` (commit `d26a319`).
- **Both apps are tested.** OS checks `entitlements.ts` (37) and `oauth.ts`
  (37) pass, as does the SaaS `test/dakyx.test.ts`. A run of both real servers
  side by side passed: a retainer client signed in to the SaaS on Pro, and
  churning the retainer signed them out 6 s later. So did a real-browser
  sign-in hop.
- **Everything is dormant until the environment variables below are set.**
  With them unset, the OS queues no events and shows no Marketing link, and
  the SaaS hides "Continue with DakyX".
- **One part is already live as soon as the OS deploys.** Retainer clients
  listed under a client's **People with access** get the Business builder
  tier. The migration `20261016120000_cross_product_access` creates the
  tables and adds everyone who paid for a builder seat to that seat's client.

## What you need to do

Work through the steps in order. Stop and tell the Owner if any check does not
come out as written. Never paste a secret into a chat, a commit, a doc or a
log.

### 1. Confirm both deploys succeeded

```bash
railway status            # see which project/service you are linked to
railway logs --service <os-service>      # look for "All migrations have been successfully applied" or the migration name
railway logs --service <saas-service>    # look for api_listening, no boot errors
curl -s https://os.dakyx.com/api/health
curl -s https://marketing.dakyx.com/api/health
curl -s https://marketing.dakyx.com/api/auth/dakyx/config   # expect {"success":true,"enabled":false} for now
```

If the OS deploy failed on the migration, **do not hand-edit the database**.
Read the error and report it. The migration is additive: four new tables, one
enum and an `INSERT … ON CONFLICT DO NOTHING` backfill.

Confirm the SaaS is really served at `https://marketing.dakyx.com`; its code
defaults to that host. If it lives elsewhere, use the real host everywhere
`marketing.dakyx.com` appears below.

### 2. Generate two secrets, locally

```bash
openssl rand -hex 32   # → CLIENT_SECRET
openssl rand -hex 32   # → PARTNER_KEY
```

Keep them in shell variables only. They must differ: `CLIENT_SECRET` signs in
the SaaS as an OAuth client; `PARTNER_KEY` lets it read grants and signs the
OS's change events. `checks/oauth.ts` asserts one does not work as the other.

### 3. Set the OS variables (the `server` service)

```bash
railway variables --service <os-service> \
  --set "OAUTH_ISSUER=https://os.dakyx.com" \
  --set "OAUTH_CLIENT_MARKETING_SECRET=$CLIENT_SECRET" \
  --set "OAUTH_CLIENT_MARKETING_REDIRECTS=https://marketing.dakyx.com/api/auth/dakyx/callback" \
  --set "PARTNER_MARKETING_API_KEY=$PARTNER_KEY" \
  --set "PARTNER_MARKETING_EVENTS_URL=https://marketing.dakyx.com/api/internal/dakyx/events" \
  --set "MARKETING_APP_URL=https://marketing.dakyx.com"
```

- **The redirect must match exactly**: scheme, host and path, no trailing slash.
  Anything else is answered with a 400 by design.
- **`PARTNER_MARKETING_EVENTS_URL` must be https** in production, or delivery
  refuses to start.
- **If several Railway services run the OS image**, set the variables on every
  one that serves `os.dakyx.com`, `app.dakyx.com` or `editor.dakyx.com`. Check
  `SERVICE_ROLE` and `APP_SURFACE`. Event delivery runs in whichever process
  holds the background lease.

### 4. Set the SaaS variables

```bash
railway variables --service <saas-service> \
  --set "DAKYX_BASE_URL=https://os.dakyx.com" \
  --set "DAKYX_ISSUER=https://os.dakyx.com" \
  --set "DAKYX_CLIENT_SECRET=$CLIENT_SECRET" \
  --set "DAKYX_PARTNER_KEY=$PARTNER_KEY"
```

- **`DAKYX_ISSUER` must equal the OS's `OAUTH_ISSUER` character for
  character.** The SaaS refuses a sign-in whose issuer differs.
- **`DAKYX_BASE_URL` is where customers are sent to sign in.** `os.dakyx.com`
  is right unless the Owner says customers normally sign in at
  `app.dakyx.com`. Either host works, because the OS serves
  `/api/auth/oauth/*` and `/api/partner/*` on all three. The OS session cookie
  is per host, though, so a customer is asked to sign in on whichever host
  this names.
- **Do not set `DAKYX_REDIRECT_URI`** unless the SaaS's `VITE_APP_URL` is not
  `https://marketing.dakyx.com`. It defaults to
  `${VITE_APP_URL}/api/auth/dakyx/callback`, and it must equal the OS's
  `OAUTH_CLIENT_MARKETING_REDIRECTS`.

Setting variables triggers a redeploy on Railway. Wait for both to finish.

### 5. Check the wiring from outside (no account needed)

```bash
# The SaaS button is on
curl -s https://marketing.dakyx.com/api/auth/dakyx/config            # {"success":true,"enabled":true}

# The OS refuses an unknown redirect with a 400 and does not redirect
curl -s -o /dev/null -w "%{http_code}\n" "https://os.dakyx.com/api/auth/oauth/authorize?client_id=marketing&redirect_uri=https://evil.example/cb"   # 400

# The SaaS start step sends the browser to the OS
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://marketing.dakyx.com/api/auth/dakyx/start
#   302 https://os.dakyx.com/api/auth/oauth/authorize?response_type=code&client_id=marketing&redirect_uri=...

# The partner API refuses a wrong key and accepts the right one
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer nope" https://os.dakyx.com/api/partner/v1/entitlements/abcdefghij1234   # 401
curl -s -H "Authorization: Bearer $PARTNER_KEY" https://os.dakyx.com/api/partner/v1/entitlements/abcdefghij1234
#   {"subject":"abcdefghij1234","version":…,"active":false,"grants":[]}

# A forged event is refused
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{"id":"x","event":"entitlements.changed","data":{"sub":"x"}}' https://marketing.dakyx.com/api/internal/dakyx/events   # 401
```

**If the start step returns 404**, the SaaS deployed is older than `d26a319`.
Its social-login route was swallowing `/api/auth/dakyx/start`.

### 6. Put people on their clients (the Owner does this, or you guide them)

In the OS, open **Clients → each client with an active retainer → People with
access**, and add each person by email. A new address gets an account and a
set-password email. Each person card then shows badges such as
"Website Builder: MANAGED · retainer" and "Marketing: pro · retainer".

What each retainer gives, from `RETAINER_TIERS` in
`server/src/services/entitlements.ts`:

| Retainer | Builder | Marketing |
|---|---|---|
| Foundation | MANAGED | growth |
| Growth | MANAGED | pro |
| Transformation | MANAGED | agency |

To change these, edit `RETAINER_TIERS`. `checks/entitlements.ts` fails if a
tier is misspelt.

### 7. Live smoke test with a throwaway retainer

1. In the OS, create a test client, give it an active Growth care plan with
   **auto-invoice off**, and add a person you control (a `+test` address)
   under People with access.
2. Sign in to the OS as that person. The nav shows **"Marketing · included ↗"**,
   and Website → plan shows "included with your DakyX retainer".
3. Click it. You should land in the SaaS signed in. Its sidebar and Billing
   page show **Pro** with the banner "included with your DakyX retainer".
4. In the OS, **churn** the test care plan. Within about 30 s the SaaS session
   is signed out, and signing in again shows **Free**.
5. Confirm delivery on the OS database:
   `SELECT "userId","deliveredAt","attempts","lastError" FROM "EntitlementEvent" ORDER BY "createdAt" DESC LIMIT 5;`.
   `deliveredAt` should be set and `lastError` empty.
6. Delete the test client in the OS (its people lose access), and delete the
   test account in the SaaS admin if wanted.

If step 4 never signs them out, check `lastError` on `EntitlementEvent`. A 401
from the SaaS means `PARTNER_KEY` differs between the two services. A
connection error means the events URL is wrong. The SaaS's hourly reconcile
will still catch up.

### 8. Tell the Owner

Report each step's actual result. Name anything skipped and why.

## Rollback

- **To switch the link off without a deploy**, remove the variables:
  `OAUTH_CLIENT_MARKETING_SECRET` on the OS (the sign-in and the nav link
  stop), and `DAKYX_CLIENT_SECRET` on the SaaS (the button hides). Plans
  already granted in the SaaS lapse 72 h after the last successful sync.
- **Do not delete rows from `ClientMember`, `ProductGrant`, `plan_grants` or
  `social_login_identities` as a rollback step.** They are the record of who
  was linked and who was given what.
- **Code rollback means reverting the merge commits.** Leave the migration
  in place: its tables are unused by older code.

## Do not

- Do not reuse one secret for both values, or put either in a `VITE_*` variable
  (those are compiled into the browser bundle).
- Do not widen the OS session cookie to `.dakyx.com` to "make SSO easier".
- Do not point the SaaS at the OS database or the other way round.
- Do not add tiers to the change event to save a request. The event is
  deliberately empty.
