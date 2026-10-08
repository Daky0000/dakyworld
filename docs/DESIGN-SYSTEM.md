# DakyXTech design system

**Version 21 · adopted 8 October 2026.** Supersedes the August 2026 system
(Space Grotesk / DM Sans, ink `#08101F`, electric blue `#3157FF`, lime
`#B8FF3D`, cream `#F4F5F0`). The reference page is the approved homepage
draft, `website-drafts/home-v21.html`. If this document and that page
disagree, fix whichever is wrong; do not let a third version appear.

It governs every surface: the website at dakyx.com, the OS at os.dakyx.com,
the Website Builder at editor.dakyx.com, every email we send, and every
generated document (proposals, invoices, contracts, reports, letterhead).

## 1. Character

Business, corporate, calm. A consultancy a business owner trusts with money,
not a design studio showing off. That means:

- white panels on a cool grey canvas, plenty of space, one accent colour
- regular-weight headlines; weight is used for the second half of a
  headline only by making it *grey*, never by making it heavy
- small tracked capitals for labels, never for sentences
- squared-off buttons (10px), not pills
- one real photograph where a person helps; drawn UI where the product helps
- the **dot pattern** as the only decoration (§7)

What it is not: gradients on text, glassmorphism, giant blurred shapes,
pastel blocks, playful motion, more than one accent colour.

## 2. Colour

| Token | Value | Use |
|---|---|---|
| `navy` | `#091833` | the logo navy. Dark bands, the featured plan, the announcement bar, footers of documents |
| `ink` | `#0D1526` | all body text and headings on light surfaces |
| `blue` | `#2563EB` | the logo blue. The one accent: primary buttons, links, selection, figures that matter |
| `blue-d` | `#1D4ED8` | hover/pressed state of `blue` only |
| `blue-light` | `#8FB2FF` | blue text or marks **on navy** (blue on navy fails contrast) |
| `pale` | `#EAF1FF` | tinted chips, tick circles, selected rows |
| `canvas` | `#ECEEF1` | the page behind the panels |
| `panel` | `#FFFFFF` | panels and cards |
| `soft` | `#F6F7F9` | alternate panels, inset cards, table headers |
| `line` | `#E3E6EB` | hairlines and card borders |
| `line-2` | `#D2D7DF` | a border meant to be seen: outline buttons, inputs |
| `muted` | `#5B6374` | secondary text. 6.0:1 on white, 5.1:1 on canvas |
| `faint` | `#8A91A0` | placeholders, captions under 13px are not allowed in it. Never a label |

Rules:

1. **Two text colours on a light surface**: `ink` and `muted`. The grey
   second half of a headline uses `muted`. Opacity of ink is not a third.
2. **Blue is the only accent.** Lime is retired from the brand. It survives
   only inside the OS as a *status* colour (positive), never as decoration.
3. On navy, text is white or `rgba(255,255,255,.72)`; accents are
   `blue-light`.
4. Status colours (OS, emails that report a state) are semantic and live in
   the OS token tier: `positive`, `warn`, `danger`, `info`. They are not brand
   colours and never appear on the marketing site.

## 3. Type

**Outfit is the only typeface**, weights 300–600, self-hosted
(`assets/fonts/outfit-*.woff2`; Google Fonts is never linked — see the head of
`assets/fonts.css`). Fallback stack:
`"Outfit", "Segoe UI", system-ui, -apple-system, sans-serif`.

| Role | Size | Weight | Tracking | Line height |
|---|---|---|---|---|
| Display (h1) | clamp(40px, 5.2vw, 72px) | 400 | -0.04em | 1.04 |
| Section heading (h2) | clamp(32px, 3.8vw, 52px) | 400 | -0.035em | 1.08 |
| Card heading (h3) | 21–25px | 500 | -0.03em | 1.15 |
| Figure | 30–40px | 400 | -0.04em | 1 |
| Lead | 17.5px | 400 | 0 | 1.6 |
| Body | 16.5px | 400 | 0 | 1.6 |
| Small | 14–15px | 400 | 0 | 1.5 |
| Label (caps) | 12px (11px in tiles) | 500 | +0.14em, uppercase | 1.5 |

- A headline may have a grey second half: `Better customer experiences.
  <span class="muted">Less manual work.</span>` That is the system's only
  typographic flourish.
- Card titles in a services grid may be set as labels (caps, 15px, +0.12em).
- No italics for emphasis, no serif, no outlined or gradient text.
- Emails cannot rely on Outfit: they name it first and fall back to Segoe UI /
  Arial. Word documents are set in Arial outright (§11). PDFs embed Outfit.

## 4. Shape and space

- **Radius has four values**: `22px` panels and bands, `14px` cards and tiles,
  `10px` buttons, inputs and chips, `50%` avatars and dots. Nothing else.
- **The frame**: panels sit on the canvas with a `12px` gap between them and
  `12px` from the window edge (`8px` under 640px). The header is a panel too.
- Content width inside a panel: `min(1180px, 100% - 64px)` (`- 36px` on phones).
- Section padding: 72px top and bottom (52px on phones). Hero panel: 28px.
- Grid gaps: 12px between cards, 40–56px between columns.
- Shadow is used for things that float (photo stat card, dropdown, FAQ card
  on a band): `0 20px 40px -20px rgba(13,21,38,.4)`. Cards on panels have a
  hairline border instead.

## 5. Components

Names are the CSS classes on the website; the OS and emails mirror them.

- **Announcement bar** — navy strip above the header, one sentence, one link.
- **Header** — white panel: logo · links · "Sign in" text link · blue "Book a call".
- **Buttons** — `btn-b` blue (primary, one per view), `btn-o` white with
  `line-2` border (secondary), `btn-k` ink, `btn-w` white on a band.
  15px/500, 13×20px padding, radius 10px, an arrow that nudges 3px on hover.
- **Link** — blue, 500, with an arrow. No underline except in body copy.
- **Label** — tracked caps above every heading (`cap`).
- **Panel** — white or `soft`, radius 22px, on the canvas.
- **Band** — a panel in `blue` or `navy`, white text, carries the dot pattern.
- **Tile** — white, hairline border, radius 14px: a caps label at the top, a
  figure at the bottom, a source line under it.
- **Card** — `soft`, radius 14px, icon square (44px, white, hairline) at the
  top, caps title, body, a link at the foot. Turns white with a `line-2`
  border on hover.
- **Steps** — numbered circles (40px, hairline) in a ruled list.
- **Case card** — image on top (16:10), caps tag in blue, title, one
  paragraph, a ruled row of figures.
- **Plan card** — white with hairline; the featured one is navy with a blue
  chip.
- **FAQ** — ruled accordion; the toggle is a 30px square that fills ink when
  open and its plus turns to a cross.
- **Photo stat card** — white, radius 14px, shadow, sits on the bottom-left of
  a photograph: a blue figure, one line, a grey source.
- **Form field** — 48px tall, radius 10px, `line-2` border, `ink` 2px focus ring
  in `blue`.

## 6. Photography

One photograph per section at most, never decorative. It shows people
working, ideally in West Africa. **Stock photography must be replaced with
real DakyXTech or client photography as it becomes available**, and stock is
never captioned or implied to be our team or our clients. Photos are
self-hosted (`assets/img/`), never hotlinked.

## 7. The dot pattern

The signature. A dot grid (1.15px dots on an 11px grid) seen through soft
radial masks so it reads as scattered land, not wallpaper.

```css
.dotfield{position:absolute;pointer-events:none;
  background-image:radial-gradient(circle,currentColor 1.15px,transparent 1.6px);
  background-size:11px 11px;color:#BFCADB;
  mask:radial-gradient(38% 30% at 30% 40%,#000 60%,transparent 100%),
       radial-gradient(30% 26% at 70% 62%,#000 55%,transparent 100%),
       radial-gradient(22% 20% at 55% 20%,#000 50%,transparent 100%)}
```

- On light panels: `#BFCADB`. On blue: `rgba(255,255,255,.2)`. On navy:
  `rgba(130,165,255,.22)`.
- **It never sits under body text.** It belongs at the edges of a panel, behind
  a photograph or a product shot, and across bands. On one-column (phone)
  layouts it is removed from any panel where it would end up under copy.
- In documents and emails, where masks are unavailable, it is a pre-rendered
  PNG (`assets/brand/dots-*.png`) placed in a corner.

## 8. Motion

A 16px rise and fade as a section enters (0.7s, `cubic-bezier(.2,.7,.2,1)`),
arrow nudges on hover, the accordion. Nothing else moves. Everything honours
`prefers-reduced-motion`.

## 9. Voice and honesty

The copy rules that already applied still apply: plain English, short
sentences, prices stated, no invented numbers. The design adds three:

1. **No testimonial, star rating, user count or logo wall that is not real.**
   Template slots for them are filled with measured client results instead.
2. Figures always carry their source (the client's name) on the line beneath.
3. Stock photos are never captioned as our team or our clients.

## 10. Logo

The masters are in `assets/brand/masters/`: the colour lockup (navy wordmark,
blue X) on light surfaces, the white lockup on navy and blue. The wordmark is
artwork — never re-set it in Outfit. Minimum height 28px on screen. Clear
space equal to the height of the X on every side.

## 11. Surfaces

| Surface | Where the tokens live | Notes |
|---|---|---|
| Website | `assets/site.css` (`:root`) | the reference implementation |
| OS / editor UI | `server/client/tailwind.config.js`, `server/client/src/index.css` (`.os-*`) | primitives above + the semantic status tier; the v22 frame below |
| Emails | `server/src/services/emailLetterhead.ts` | tables and inline styles, no webfont request; the navy header band is one embedded picture (`server/assets/email-band.png`), white card on canvas, soft footer |
| PDFs | `server/src/services/letterhead.ts` → every PDF | navy band across the top of every page with the dot field drawn as vectors, white lock-up, contact lines in light text; plain footer rule; balance due in the pale panel; Outfit embedded via `useBrandFonts()` |
| Word documents | `server/src/services/proposalDocx.ts` | the same band, as a floating picture behind the header (`server/assets/doc-band.png`); set in **Arial**, because a .docx names one family with no fallback and Word substitutes a serif when Outfit is missing |

### The v22 furniture (8 Oct 2026)

Approved from `website-drafts/system-v22.html`. Colours and type are unchanged
from v21. This is how the homepage's frame is carried into the products.

- **Apps.** The sidebar, top bar and page are white panels on the canvas,
  12px apart, with 22px corners (16px and 8px gaps on a phone). Navy appears as
  a band carrying the dot field, never as a wall: the old full-height dark
  sidebar is gone. The active nav item is pale blue, and table headers use the
  spaced caps on the soft grey.
- **Signed-out screens.** One frame (`AuthFrame` in `Login.tsx`): a navy panel
  with the dot field, the product's promise and three tiles saying what it
  does, beside a white panel with the task. The tiles carry no numbers, because
  nothing about the visitor is known before sign-in.
- **Passwords.** Every password field can be revealed. Choosing one shows a
  four-step meter and the server's own rules as a ticked guide (see
  `lib/passwordStrength.ts`).
- **Email and documents.** A navy band across the top carries the white
  lock-up and the dot field. A workspace that uploaded its own logo keeps a
  white header, because uploads are on-light artwork. The corner ribbons and
  the watermark are retired.

When a value changes, it changes in all of these in the same piece of work.
`docs/claude/14-brand-and-metadata.md` records the traps.
