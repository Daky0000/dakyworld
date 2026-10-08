# Site metadata and the brand design system

> Part of the DakyXTech OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

## The website's metadata is generated

Everything between the `BEGIN SEO` / `END SEO` markers in each `<head>`, the
visible breadcrumbs, `robots.txt` and `sitemap.xml` all come from
`scripts/build-seo.mjs` and `scripts/build-breadcrumbs.mjs`. **Hand-editing
inside the markers fails CI.** Change the table at the top of the script and run
`npm run site`; the page copy itself (title, description) is read *out* of each
page rather than written into it, so the words stay the owner's.

```bash
npm run site        # regenerate metadata + breadcrumbs, then check links
npm run security    # secret scan (tree and history) + dependency audit
npm run links:fix   # rewrite any .html internal link to the canonical form
```

## The brand design system is canonical

**[docs/DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md) (version 21, 8 Oct 2026)**
governs every surface: the website, the OS and editor UI, every email and
every generated document. Its reference page is the approved homepage draft,
`website-drafts/home-v21.html`, which is now `index.html` + `assets/home.css`.
It replaced the August 2026 system (Space Grotesk / DM Sans, ink `#08101F`,
electric blue `#3157FF`, lime `#B8FF3D`, cream `#F4F5F0`); any of those
values outside `website-drafts/` is a leftover.

```
navy #091833  ink #0D1526  blue #2563EB  blue-d #1D4ED8  blue-light #8FB2FF
pale #EAF1FF  canvas #ECEEF1  soft #F6F7F9  line #E3E6EB  line-2 #D2D7DF
muted #5B6374  faint #8A91A0   ·  Outfit only, self-hosted, weights 300-600
radius 22 panel / 14 card / 10 control  ·  the dot pattern is the one ornament
```

Rules that are easy to get wrong:

1. **Blue is the only accent.** Lime is retired; in the OS it survives only as
   the `positive` status colour. `--lime` and `--cyan` in `site.css` are now
   aliases of blue so a forgotten rule cannot bring them back.
2. **A headline's second half is grey (`muted`), not blue.** Headlines are
   regular weight (400). Bold is 600 at most.
3. **The dot pattern never sits under body copy.** It goes on panel edges,
   behind photographs and product shots, and across navy/blue bands; it is
   removed from one-column hero layouts.
4. **Everything is a panel in the frame**: sections are white or `soft`
   panels with a 22px radius, 12px apart on the `canvas`. `.section` and every
   top-level `main > section` get this from `site.css` / `pages.css`.
5. Photos are self-hosted in `assets/img/`. The current ones are Unsplash stock
   and must never be captioned or implied to be our team or our clients.

Token values live in the places listed in DESIGN-SYSTEM.md §11 and must agree:
`assets/site.css` (website), `server/client/tailwind.config.js` (OS UI), the
email renderer, and `server/src/services/letterhead.ts` (documents).

Real logo artwork exists as of Aug 2026 in `assets/brand/`, in an `-on-light`
and an `-on-dark` cut. The wordmark has its own typeface — **never re-set it in
Outfit**. The website header and footer use the `-on-light` cuts
(`header-lockup-on-light.png`, `footer-lockup-on-light.png`) since v21. `server/assets/logo.png` and `mark.png` are picked up
automatically by the letterhead at render time; the typographic fallbacks in
`letterhead.ts` and `proposalDocx.ts` exist for when the files are absent and
should stay.

Artwork uploaded under Settings → System wins over both. Order everywhere is
**uploaded → shipped file → type**.

### The OS UI has a semantic layer above those primitives

`server/client/tailwind.config.js` now carries two tiers. The nine brand colours
above are **primitives** and never change. Everything else is a **semantic**
token that says what a colour is *for*, and exists because the design system
describes a brand rather than an operations tool — it has nothing to say about
what colour a failed send is, so before Sep 2026 every screen invented one.

| Token | Replaces | For |
|---|---|---|
| `muted` | thirteen steps of `text-ink/25…65`, 871 uses | all secondary text |
| `faint` | `text-ink/30` and friends on placeholders | placeholders, disabled, an empty cell — never a label |
| `sunken` | `bg-ink/[.02]`…`[.06]` and `bg-ink/5` | the one inset surface |
| `line-strong` | `border-ink/15`, `/20`, `/25` | a divider meant to be seen |
| `positive` `warn` `danger` `info` | ~500 uses of stock `emerald-*` `amber-*` `red-*` | status, each as surface / line / text / solid |

Three rules follow from it:

1. **§05 allows exactly two text colours on a light surface** — `ink` and
   `muted`. An opacity of ink is not a third one. `text-ink/40` measured 2.61:1
   on cream and was the most-used text colour in the product.
2. **Status colours are DakyXTech's, not Tailwind's.** The reds lean cool, the
   ambers lean ochre, and `positive` is lime walked down towards ink rather than
   an unrelated emerald — so the accent and the success state are visibly the
   same idea at two brightnesses.
3. **Radius has four values and no more**: `rounded-full` for pills,
   `rounded-[10px]` for chips and inline inputs, `rounded-xl` (12px) for fields
   and small panels, `rounded-2xl` (16px) for cards. `rounded-lg` is 8px, below
   §15's floor, and does not appear.

The shared components in `client/src/components/ui.tsx` are the other half of
this — `Notice`, `Loading`, `StatGrid`/`StatTile`, `Thead`/`Th`/`Td`/`Tr` and
`SectionHeading` exist so a status box, a loading state, a row of figures and a
table header are each drawn once. Reach for one before writing a `<div>`.

