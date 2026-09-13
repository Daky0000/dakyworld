---
description: Commit, push, and verify the Railway deploy really happened
---
Ship the finished change.

1. `git status` and `git diff` — review what is actually going out.
2. Commit and push to `main`.
3. **A push to `main` is not a deploy.** Verify it landed:
   compare the local bundle hash against the live one —
   `ls server/client/dist/assets/index-*.js` versus
   `curl -s https://os.dakyworld.com/ | grep -oE 'assets/index-[^"]+'`.
   Do not probe `/api/*` to check: every `/api/*` path answers 401 whether or
   not the route exists, because `requireAuth` is mounted at `/api` ahead of
   the routers.
4. If the hashes differ after the build should have finished, deploy directly:
   `railway up --service dakyworld --ci` **run from `server/`** — Railway's
   Root Directory is `server`, so running it from the repo root uploads the
   wrong tree. `railway deployment list --service dakyworld --json` gives
   status; the CLI often reports `Failed to stream build logs` on a build that
   is fine.
5. Call out anything needing a manual step: dashboard settings, new env vars.

$ARGUMENTS
