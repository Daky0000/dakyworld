# DakyXTech infrastructure runbook

## Deploy OS

1. Confirm `main` passed type checks and focused tests.
2. Run database migrations once through the configured pre-deploy command.
3. Deploy the API and poll Railway until terminal `SUCCESS`.
4. Request `/api/ready` through the Railway domain and every custom domain.
5. Verify login and one protected read.
6. Check logs for repeated scheduler starts, auth bypass warnings, and secret leakage.

## Roll back OS

Redeploy the last known-good Railway deployment. If the API/worker split caused missing or duplicate work, set the known-good service to `SERVICE_ROLE=combined`, disable the new worker, redeploy, and verify scheduler ownership.

## Domain rollback

Keep `os.dakyx.com` active. If `os.dakyx.com` fails, revert only the new domain DNS and restore prior origin variables. Never remove the only working production hostname.

## Logs and health

- Railway deploy/build logs: OS service deployment view
- Readiness: `/api/ready`
- Database: private `Postgres` service and persistent volume
- Storage: Cloudflare R2

Never log credentials, session tokens, authorization headers, private keys, or database URLs.

## Storage buckets

Two Cloudflare R2 buckets, and only one of them is public.

- `dakyxtech` is served at its public `r2.dev` address (`R2_PUBLIC_URL`) and
  holds only what a website visitor may load: Website Builder pictures under
  `assets/dw/` and the brand images. Anything put here can be read by anyone
  who has or guesses the URL — the bucket does not list, but it does not
  check who is asking either.
- `dakyxtech-private` has no public address. It exists because, until 12 Oct
  2026, `scripts/migrate-images-to-r2.mjs` ran on every deploy and copied every
  `StoredFile` — email attachments, prospect audit PDFs, lead screenshots — to
  `files/<id>-<filename>` in the **public** bucket. On 12 Oct those 193 objects
  (268 MB) were copied to `dakyxtech-private`, size-checked, and deleted from
  `dakyxtech`; a listing afterwards found no `files/` key left in the public
  bucket. The rows in Postgres were never changed and still serve those files
  through the authenticated API.

The script no longer runs on deploy and no longer copies `StoredFile` rows at
all; it moves only `assets/dw/` pictures of repository sites
(`npm run migrate:r2`, by hand). If a `files/` key ever appears in the public
bucket again, something is writing private data to a public address: find it
before deleting the object.
