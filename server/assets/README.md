# Brand assets

## `logo.png`

Drop the exported Dakyworld logo here as **`logo.png`** (or `.jpg`) and every
PDF the app produces — proposals, invoices — picks it up on the next render.
No code change and no configuration.

- It is fitted into a **190 × 46 pt** box at the top-left of the letterhead,
  keeping its aspect ratio. Export at roughly **760 × 184 px** or larger so it
  stays sharp in print; anything much smaller will look soft on paper.
- A transparent PNG is best. The letterhead behind it is white.
- If no file is here, `services/letterhead.ts` draws the wordmark from type
  instead — "DAKYWORLD®" with the gold underline and the tagline beneath.

That fallback exists because `01 Brand/Dakyworld_Visual_Identity_Guide` states
plainly that logo artwork was never produced, and the letterhead template's D
monogram is not in this repository. A wrong logo on a document a client keeps
is worse than a clean typographic one, so the code does not guess at it.
