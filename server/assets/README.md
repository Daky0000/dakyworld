# Brand assets

The real Dakyworld artwork, supplied 13 Aug 2026. `logo.png` and `mark.png`
are picked up automatically by `services/letterhead.ts`, so every PDF the app
produces — proposals, invoices — carries them with no code change. The two
`logo-email*.png` cuts are the same identity for email.

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

## `logo-email.png` and `logo-email-dark.png` — the email letterhead

Attached to every outgoing email as inline parts and referenced from the HTML
as `cid:dakyworld-logo` and `cid:dakyworld-logo-dark`. See
`lib/brandAssets.ts` for why they are embedded rather than linked.

- **Sized for the message, not the screen.** 336 × 61 shown at 168 wide, and
  264 × 47 shown at 132 — double, so they stay sharp on a phone.
- **Palette-reduced to about 3 KB each.** They ride along on every single
  email, including every step of every sequence.
- **Flattened onto their backgrounds** — white for the header cut, `#050A14`
  for the footer cut — rather than left transparent. A mail client in dark
  mode inverts the background behind an image and never the image itself, so a
  transparent ink wordmark becomes an invisible logo.

Regenerate both from the masters after any identity change:

```python
from PIL import Image
def cut(src, dst, width, matte, colors=96):
    im = Image.open(src).convert('RGBA')
    im = im.resize((width, round(im.size[1] * width / im.size[0])), Image.LANCZOS)
    flat = Image.new('RGB', im.size, matte)
    flat.paste(im, mask=im.split()[3])
    flat.quantize(colors=colors, method=Image.FASTOCTREE).save(dst, 'PNG', optimize=True)

cut('assets/brand/dakyworld-lockup-on-light.png', 'server/assets/logo-email.png', 336, '#FFFFFF')
cut('assets/brand/footer-lockup-on-dark.png', 'server/assets/logo-email-dark.png', 264, '#050A14')
```

## Replacing any of them

Overwrite the file and re-render. All of them are resolved once per process,
so a running server needs a restart to see a new file. Keep the same names —
the lookup is by filename, not by content.

The masters these were cut from live in
`Dakyworld Website/assets/brand/`, alongside the on-dark cuts and the tagline
lock-up, which the website uses.
