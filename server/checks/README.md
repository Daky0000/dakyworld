# checks/

Regression checks that are meant to last, run with `npm run checks`.

This is not `tmp/`. `tmp/` is gitignored and holds the throwaway harness written
to prove one change worked on one afternoon; the good ones there have been
invaluable and none of them runs again unless somebody remembers it exists.
These are committed, they all run with one command, and a change that breaks one
is meant to be noticed.

Three rules, learned from the harnesses in `tmp/`:

1. **A database and nothing else.** No API key, no network, no Docker beyond
   Postgres. A check that needs a credential is a check that stops being run.
2. **Assert the crossing, not only the effect.** A tool that dedupes its own
   writes will make an effect count pass while the gate lets everything through.
   Count `ToolCall` rows as well as rows in the table you expected to change.
3. **A check that creates rows deletes them, including the ones it expected to
   be refused** — and the last call must be the delete-only half of `reset()`,
   or it re-creates on the way out exactly what it was there to remove.
   **`LlmCall` counts.** A check that drives a real `callModel` writes ledger
   rows, and `checks/costs.ts` sums those over an hour band: 23 uncached rows
   left behind by `checks/screenshots.ts` moved the cache rate enough to fail
   it, so the file that went red was not the file that was wrong. Delete them,
   scoped to your own `purpose` and to a timestamp taken at the start of the
   run, so a genuinely recorded call is never touched.

**Never run one check by hand while `npm run checks` is going.** Four of these
files bind port 4599 and several share database fixtures, so the collisions
surface as EADDRINUSE and as impossible-looking failures in files nobody
touched. New files should bind port 0 and read the port back.

Run one directly while working on it:

```bash
npx tsx checks/spine.ts
```

## Every vendor can be pointed somewhere else

Rule 1 says no API key. What makes that possible for anything that talks to a
vendor is that each client reads its root from an environment variable and
falls back to the real address:

```
ANTHROPIC_BASE_URL  OPENAI_BASE_URL  GEMINI_BASE_URL  PERPLEXITY_BASE_URL
OPENROUTER_BASE_URL  APIFY_BASE_URL  SLACK_BASE_URL
```

Point them at one local express and the **real** adapters run against a fake
vendor — the same code path, the same retries, the same refusals. `tmp/vendorStub.ts`
is the model-layer one; `checks/vendorBases.ts` is the committed proof that the
override actually reaches the wire.

Two things to keep right, both of which have been wrong here before:

- **Read the base per call, never capture it at import.** `BASE` in
  `models/call.ts` was a module constant while `openRouterBase()` was a
  function, so a harness repointing a vendor between scenarios got a frozen
  address in one half and a live one in the other: green, testing nothing, and
  on a machine with a real key, spending money.
- **A stub is a different far end, not a way past the credential check.**
  `toolReadiness()` is deliberately untouched by any of this. Making it answer
  "configured" when nothing is means an agent calls `email.send`, receives a
  fake success and reports the letter as sent — which is the exact failure the
  readiness layer exists to prevent. Set the credential (`APIFY_TOKEN=stub`)
  and let the real gate pass for the real reason.

SMTP needs no override: `smtp.host` and `smtp.port` are already settings, so a
local sink is configuration rather than code.
