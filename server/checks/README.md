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

Run one directly while working on it:

```bash
npx tsx checks/spine.ts
```
