# The DakyX edge bridge

Route B of the publish router (`../docs/publish-router.md`). It is a Cloudflare
Worker in front of a customer's own host. A just-published page is served from
here within a second, until the host has rebuilt. It fails open: on any error,
the request goes to the customer's host untouched.

The code is `src/worker.ts`. `checks/publishRouter.ts` runs it in Node against
an in-memory Durable Object.

## Deploying it, once

Do this on a throwaway domain first, and run the six checks in
`../docs/publish-router.md` before any customer uses it.

1. **Hosting domain.** Buy it (for example `dakyxsites.com`) and add it to Cloudflare. The Free plan is enough for the zone.
2. **Workers paid plan** ($5/month), for Durable Objects.
3. **Cloudflare for SaaS** on that zone (SSL/TLS → Custom Hostnames).
   1. Create a DNS record `edge.dakyxsites.com`, proxied. This is the CNAME target customers point at. Set it as the **fallback origin**.
   2. Create `bridge-admin.dakyxsites.com`, proxied. This is the admin hostname the OS writes to.
4. In this folder:
   1. Replace `REPLACE_WITH_HOSTING_DOMAIN` in `wrangler.toml`.
   2. Run:
      ```
      npx wrangler login
      npx wrangler secret put ADMIN_TOKEN     # a long random string
      npx wrangler secret put BYPASS_TOKEN    # another one
      npx wrangler deploy
      ```
   The `*/*` route on the zone sends every custom hostname, and the admin hostname, through the Worker.
5. **Railway** (`dakyworld` service, production). Set:

   | Variable | Value |
   |---|---|
   | `BRIDGE_ADMIN_URL` | `https://bridge-admin.dakyxsites.com` |
   | `BRIDGE_ADMIN_TOKEN` | the `ADMIN_TOKEN` above |
   | `BRIDGE_BYPASS_TOKEN` | the `BYPASS_TOKEN` above |
   | `BRIDGE_CNAME_TARGET` | `edge.dakyxsites.com` |
   | `CLOUDFLARE_API_TOKEN` | a token with **SSL and Certificates: Edit** on the zone, for custom hostnames |
   | `CLOUDFLARE_ZONE_ID` | the zone's id |

## What a customer does

They press **Make instant** in Website settings. Then:

1. They add two records: a TXT record proving the domain is theirs, and one CNAME pointing their web hostname at `edge.dakyxsites.com`.
2. DakyX checks the records and creates the Cloudflare custom hostname.
3. Once its certificate is issued and nothing redirects in a loop, the bridge turns active.

Email (MX) and every other record are never touched. Where the DNS provider
supports Domain Connect and has accepted
`domainconnect/dakyx.com.bridge.json`, the records are one click.

## How the OS uses it

All calls go to the admin hostname, with `Authorization: Bearer <ADMIN_TOKEN>`.

| Call | Does |
|---|---|
| `PUT /v1/hosts/<hostname>/config` | Where the host serves the site (`origin`) |
| `PUT /v1/hosts/<hostname>/object?path=/about.html&ttl=86400000` | Serve this file until it expires |
| `POST /v1/hosts/<hostname>/renew` | Keep files alive while the host has not caught up (up to 7 days) |
| `DELETE /v1/hosts/<hostname>/object?path=…` | The host has caught up |
| `GET /v1/hosts/<hostname>/status` | What is bridged |
| `GET /v1/probe?origin=…` | What the host answers from Cloudflare's side |

A visitor's request carrying `x-dakyx-bridge-bypass: <BYPASS_TOKEN>` skips the
bridged files. This is how the watcher sees whether the host itself has
rebuilt.
