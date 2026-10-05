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
