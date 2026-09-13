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
- Browser checks use the real editor through `client/builder-harness.html`. **`npm run checks:browser`** runs all of them: it starts the harness on 127.0.0.1:5199, runs each check, and stops the harness again — reuse an already-running one if you have it. Playwright is deliberately not a dependency of this project, so install it yourself or point `PLAYWRIGHT_URL` at an installed copy's `index.mjs` (a `file:///` URL on Windows); the runner refuses with exit 2 rather than skipping, because a browser suite that exits zero on a machine with no browser reports success for work it did not do. `npm run checks` does **not** include these — it only picks up `checks/*.ts`, which is how four of the five came to be quietly broken. The harness is excluded from the production Vite entry.

Keep changes focused, preserve existing drafts and conflict checks, and include tests for new write paths. Never use a production database for fixtures. Deployment uses Railway's `server/railway.json`; verify its health check and live UI after deployment.
