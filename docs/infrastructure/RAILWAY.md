# Railway configuration

## Current production

The OS builds from `Daky0000/dakyworld`, branch `main`, root directory `/server`, in `us-west2`. The public container port is `8080`. PostgreSQL remains on Railway private networking. Cloudflare R2 remains the object store.

Required production variable names include `DATABASE_URL`, `APP_SECRET`, `APP_URL`, `CLIENT_ORIGIN`, `NODE_ENV`, `SERVICE_ROLE`, R2 credentials, and GitHub App credentials. Values belong in Railway, never Git.

## Production OS roles

- API: `SERVICE_ROLE=api`, start command `npm run start:api`, public domain, health check `/api/ready`
- Worker: `SERVICE_ROLE=worker`, start command `npm run start:worker`, no public domain
- Migration: `npm run db:deploy` from one pre-deploy path only
- Redis: private Railway service referenced through `REDIS_URL`

Production uses separate API and worker processes. Migrations run in the API pre-deploy command. The API does not start the scheduler; the worker owns the background lease and starts one scheduler.

## Staging

The persistent `staging` environment has separate PostgreSQL and Redis volumes plus separate API and worker services. It contains no production integration credentials or production data. No public staging domain is attached.
