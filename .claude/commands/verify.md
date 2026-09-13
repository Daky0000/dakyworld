---
description: Typecheck, build and run server/checks the way that actually proves something
---
Verify the current change honestly. A passing build is not a test.

1. `cd server && npx tsc --noEmit`
2. `cd server/client && npx tsc -b && npm run build`
3. Start Postgres if it is not up (see README.md, "Running it locally").
4. From `server/`: `set -a; . ./.env; set +a` then `npm run checks`.
   `npm run checks` does not load `.env` itself and every check needs
   `DATABASE_URL` — without the `set -a` line the failure reads like a broken
   database rather than a missing variable.
5. `cd server && npm run checks:types`.

Report what actually ran and what actually passed. If a step was skipped, say
so. If the change is visual or document-shaped, also render it and look at the
picture — see "Render it and look at it" in CLAUDE.md.

$ARGUMENTS
