# Brand assets

Both files here are the real Dakyworld artwork, supplied 13 Aug 2026. They are
picked up automatically by `services/letterhead.ts`, so every PDF the app
produces — proposals, invoices — carries them with no code change.

## `logo.png` — the horizontal lock-up

The on-light cut: dark hexagon mark, ink wordmark, lime full stop.

- Fitted into a **190 × 46 pt** box at the top-left of the letterhead, aspect
  preserved. The current file is 1841 × 331, so it lands at 190 × 34 pt.
- Must be the **on-light** cut. The letterhead behind it is white, and the
  on-dark cut has a white wordmark that would vanish.
- Transparent PNG. Export at 760 × 184 or larger or it will look soft in print.

## `mark.png` — the square mark

The hexagon on its own, used as the page watermark at 5% opacity, low-right.

- If it is absent the watermark falls back to an oversized typographic "D".
- Also the on-light cut, for the same reason.

## Replacing either

Overwrite the file and re-render. Both are resolved once per process, so a
running server needs a restart to see a new file. Keep the same names — the
lookup is by filename, not by content.

The masters these were cut from live in
`Dakyworld Website/assets/brand/`, alongside the on-dark cuts and the tagline
lock-up, which the website uses.
