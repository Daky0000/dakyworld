# Contributing to Dakyworld OS

Run commands from `server/`. The client is in `client/`; the API is in `src/`. Use the Node version supported by the deployment configuration.

## Local setup

1. Run `npm ci` and `npm --prefix client ci`.
2. Create a local `.env` using the variables described in the root README and `src/index.ts`. Never commit credentials.
3. Point `DATABASE_URL` at a dedicated local PostgreSQL database, for example `postgresql://postgres:postgres@localhost:5432/dakyworld_dev?schema=public`.
4. Run `npx prisma generate` and `npx prisma migrate deploy`. Run `npm run seed` only against your own development database.
5. Run `npm run dev` and, in another terminal, `npm --prefix client run dev`.

## Validation

- `npx tsc --noEmit -p tsconfig.json` checks API types.
- `npm --prefix client run build` checks and builds the client.
- `npm run build` performs the deployment build. Stop Vite first on Windows because this command reinstalls client dependencies.
- `npm run checks` runs the check suite. Read `checks/README.md` first: database checks create fixtures and must use an isolated database.
- Core checks can run independently, for example `npx tsx checks/websiteAssistant.ts`, `npx tsx checks/websiteInteractions.ts`, and `npx tsx checks/websiteImageFraming.ts`.
- Browser checks use the real editor through `client/builder-harness.html?editor`. Start Vite with `npm --prefix client exec vite -- --port 5199 --strictPort --host 127.0.0.1`; the checks address `127.0.0.1` and Vite's default bind answers only on `localhost`, so without `--host` every browser check fails to navigate. Install Playwright in a local development environment, then run `node checks/browser/builderRedesign.mjs`. `PLAYWRIGHT_URL` can point to an existing Playwright module, as a `file:///` URL on Windows. The harness is excluded from the production Vite entry.

Keep changes focused, preserve existing drafts and conflict checks, and include tests for new write paths. Never use a production database for fixtures. Deployment uses Railway's `server/railway.json`; verify its health check and live UI after deployment.
