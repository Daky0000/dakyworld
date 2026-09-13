# Site metadata and the brand design system

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

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

`DAKYWORLD-BRAND-DESIGN-SYSTEM.md` (69 numbered sections, held by the owner)
governs every surface: the website, the OS admin UI, and every generated
document. Reuse existing components and tokens before inventing anything.

```
Ink #08101F   Navy #0B0A16   Blue #3157FF   Blue-light #6490FF
Cyan #6FE4FF  Lime #B8FF3D   Cream #F4F5F0  Muted #69758A  Line #DFE4EB
Space Grotesk (display) · DM Sans (body)
```

Three rules that are repeatedly got wrong:

1. **Lime is action and positive status only** — roughly 1–5% of a surface. It
   is a mark colour and never type on white. On light surfaces the accent is
   blue. Generators that touch both light and dark carry two accent constants
   for exactly this reason.
2. **Blue is structure, selection and emphasis.** When something needs an
   accent and isn't an action, it is blue.
3. **A gold/bronze/ivory identity was retired in Aug 2026.** If you find
   `#C7A24C`, `#8A6A2F`, `#F7F4EE`, `#0B0B0C`, `#6E6A63`, Playfair Display or
   Inter, it is a leftover, not a choice. `website-drafts/` still contains
   them, deliberately, as history.

Token values live in three places that must agree: `assets/site.css` (website),
`server/client/tailwind.config.js` (OS UI), and
`server/src/services/letterhead.ts` (documents, which re-exports to `pdf.ts`).
Near-miss values (`#F5F7F2`, `#68738A`, `#DFE4EC`, `#0B1630`) were swept out in
Aug 2026 — reintroducing one is new drift.

Real logo artwork exists as of Aug 2026 in `assets/brand/`, in an `-on-light`
and an `-on-dark` cut. The wordmark has its own typeface — **never re-set it in
Space Grotesk**. `server/assets/logo.png` and `mark.png` are picked up
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
2. **Status colours are Dakyworld's, not Tailwind's.** The reds lean cool, the
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

