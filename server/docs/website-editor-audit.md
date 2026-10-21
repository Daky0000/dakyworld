# Website editor audit — frameworks, elements, media (21 Oct 2026)

Asked: does the editor support most of the frameworks people arrive with, can
it edit every section and element on a page, and can it do masking, audio and
the other things a site editor is expected to do?

Method: the architecture notes ([docs/claude/13-website-builder.md](../../docs/claude/13-website-builder.md),
[website-inspector.md](website-inspector.md)) read end to end; the framework
registry, route-table reader and syntax adapters read; a "kitchen sink" page —
every common HTML construct — put through the real `readPage`; this
repository's own files and dakyx.com's live sitemap used as fixtures; every
finding either fixed with a check or listed below as open.

The short answer, before this change: frameworks were broad (twelve) but
missed Angular and the newer React/Solid/Qwik meta-frameworks; almost every
element was editable, but form wording was not, a drop-down could be
destroyed by typing into it, an embedded frame could not be pointed anywhere
else, and audio could not be uploaded; there was no masking; and on
dakyx.com itself the blog posts could not be opened and new pages arrived
hidden.

---

## 1. Frameworks

| Framework | Pages come from | Words are edited in | Before | Now |
|---|---|---|---|---|
| Plain HTML / CSS | `.html` in the site's folder | the visual editor | ✅ top-level only | ✅ plus pages in sub-folders the sitemap names |
| Next.js (app and pages routers) | route files | `.tsx` / `.jsx` | ✅ | ✅ |
| Remix / React Router 7 | `app/routes` | `.tsx` / `.jsx` | ✅ | ✅ |
| Gatsby | `src/pages` | `.tsx` / `.jsx` / Markdown | ✅ | ✅ |
| Vite + React (Lovable, Bolt, v0, Replit) | the `<Route>` table in `App.tsx` | `.tsx` / `.jsx` | ✅ | ✅ |
| Preact (Vite) | as Vite + React | `.tsx` / `.jsx` | ✅ (detected as Vite React) | ✅ |
| Astro | `src/pages` | `.astro` / Markdown | ✅ | ✅ |
| SvelteKit | `src/routes/**/+page.svelte` | `.svelte` | ✅ | ✅ |
| Svelte + Vite (no Kit) | `src/App.svelte` | `.svelte` | ❌ not detected | ✅ |
| Nuxt | `pages/` | `.vue` | ✅ | ✅ |
| Vue, file-routed | `pages/` | `.vue` | ✅ | ✅ |
| Vue + Vue Router SPA | `createRouter({ routes })` | `.vue` | ❌ not detected (no `pages/`) | ✅ table read, lazy views followed |
| **Angular** | `Routes` / `forRoot` / `provideRouter` | `.component.html` (and Angular 20's `.html`) | ❌ | ✅ `@` escaped as `&#64;` |
| **SolidStart** | `src/routes` | `.tsx` / `.jsx` | ❌ | ✅ |
| **TanStack Start / Router** | `src/routes` with `__root` | `.tsx` / `.jsx` | ❌ | ✅ |
| **Qwik City** | `src/routes/**/index` | `.tsx` / `.jsx` / `.mdx` | ❌ | ✅ |
| Docusaurus, Eleventy, Hugo, Jekyll | content folders | Markdown | ✅ | ✅ |
| **VitePress** | the folder holding `.vitepress/` | Markdown | ❌ | ✅ |
| **MkDocs** | `docs/` | Markdown | ❌ | ✅ |
| **Hexo** | `source/` (pages) | Markdown | ❌ misread as Jekyll, wrong addresses | ✅ pages; posts from the file browser |
| WordPress, Shopify, Wix, Squarespace | — | — | out of scope by contract ([website-compatibility.md](website-compatibility.md)) | unchanged |
| Webflow / Framer exports | static HTML | the visual editor | ✅ as static HTML | ✅ |

Nothing is built or run for any of them (`renderSource.ts` says why); the
visual editor opens a framework page through its built or published HTML.

## 2. Elements

From the kitchen-sink probe, after the fixes. "Field" means it can be selected
and edited; every field also gets the identical Style and Interactions tabs.

| Element | How it is edited | Before |
|---|---|---|
| Headings, paragraphs, list items, quotes, captions, labels, table cells, `dt`/`dd`, `summary`, `address`, `time`, `small`, `mark`, `pre` | text / rich text, typed on the page | ✅ (several labelled just "Text"; now named) |
| Links, buttons (`<a>`, `<button>`) | words, destination, style, new tab, icon | ✅ |
| Images, `<picture>` sources, CSS background images | address, alt, focal point, crop, library | ✅ |
| Icons (inline SVG, icon fonts) | swap, remove | ✅ |
| Containers (`section`, `div`, `header`, `nav`…) | tag, layout, style; move, copy, delete | ✅ |
| Page title, description, social title/description/image | in Page details | ✅ |
| Video | file, upload (1 GB), start/end, switches, poster | ✅ |
| **Audio** | file, **upload**, start/end, switches | ⚠️ settings only, no upload, panel said "read-only" |
| **Embedded frame** (YouTube, Maps…) | **which video, map or player it shows**, description, lazy, full screen | ❌ preserved only |
| **Form placeholders, submit-input words, drop-down options** | plain words, live on the canvas | ❌ not reachable |
| **`<select>`** | a field of its own; options beside it | 🐞 read as rich text: typing deleted every option |
| Form (`<form>`) | move, style, delete; what it does on submit stays with the code | ✅ |
| Canvas, custom elements | move, style, delete | ✅ (preserved) |
| `<object>`, `<embed>` | — | ❌ still not selectable (open, below) |
| Masking (any element) | **Style → Mask: shape and fade** | ❌ none |

### Sections

Moving, copying and deleting any block works (structure engine); the Add panel
inserted six marketing sections and nothing for media. It now also inserts a
**Video (YouTube/Vimeo)**, a **Video player**, an **Audio or podcast player**
and a **Map** — each empty, so the panel asks for the link, file or place
rather than showing somebody else's media.

## 3. Defects found and fixed

| Defect | Where | Check |
|---|---|---|
| A `<select>` was rich text whose value was its `<option>`s: a word typed into it deleted every option on the published page | `formFields` in `regions.ts` | `websiteFormText.ts` |
| A label wrapped round its control (`<label>Party size <select>…</select></label>`) was rich text holding the control, which the rich-text sanitiser drops — the same loss one level up | `wordsAroundControl` in `regions.ts` | `websiteFormText.ts` |
| dakyx.com's `sitemap.xml` is a sitemap index; it was read as two pages called `/page-sitemap.xml` and `/post-sitemap.xml`, so every newly scanned page arrived HIDDEN, and a site with no repository was given a page per sitemap file | `readSitemap` in `site.ts` | `websiteDiscovery.ts` |
| Pages in folders were never discovered — dakyx.com's nine `blog/*.html` posts could not be opened in the editor | `nestedPages` in `site.ts` | `websiteDiscovery.ts` (against this repository's files) |
| A folder's `index.html` previewed against `/team`, so its relative pictures resolved at the site root | `pageDocumentUrl` | `websiteDiscovery.ts` |
| Hosted media and the editor's raw files ignored `Range`, so Safari would not play a video or audio file stored without R2 | `lib/byteRange.ts` | `websiteAudio.ts` |
| A Hexo site was detected as Jekyll and its pages listed at `/source/…` | registry order in `frameworks.ts` | `websiteFrameworks.ts` |
| Player and frame panels said "read-only", which stopped being true weeks ago | `unsupportedField` | `websiteAudio.ts`, `websiteEmbeds.ts` |

## 4. Added

- **Masking** — Style → Mask: fourteen shapes (`clip-path`) and seven fades
  (`mask-image` gradients) with a length, per screen size. `shared/websiteMask.ts`.
- **Audio** — upload MP3, M4A, WAV, FLAC (Ogg refused with the reason), chunked
  to 1 GB, library tiles, missing-file warnings. `playableMedia` in
  `websiteManagement.ts`.
- **Embeds** — point a frame at a YouTube, Vimeo, Loom, Wistia, Google Maps,
  OpenStreetMap, Spotify, SoundCloud, Apple, Google Calendar or Calendly
  address; paste a link or the embed code; type a place for a map.
  `shared/websiteEmbed.ts`.
- **Form words** — placeholders, submit-input words and options.
- **Media sections** in the Add panel.
- **Nine frameworks** — Angular, SolidStart, TanStack Start, Qwik City, Svelte
  + Vite, Vue Router SPAs, VitePress, MkDocs, Hexo.
- **Clearer layer names** for `summary`, `caption`, `dt`, `dd`, `address`,
  `time`, `pre`, `legend`, `option`.

## 5. Still open (not done here, in rough order of value)

1. **Captions for video** (`<track kind="captions">` with an uploaded `.vtt`).
   Accessibility, and the next natural thing after audio and video upload. The
   package importer now serves `.vtt` with its type; nothing creates one yet.
2. **Picture masks** (a logo or blob shape as a mask). Needs CORS headers on
   the R2 bucket or uploads served same-origin; until then they would vanish
   silently, which is why they are refused.
3. **Adding a form field or a drop-down option.** Words can change and an
   option can be deleted; a new one is a layout change the structure engine
   does not offer for form controls.
4. **`<object>` and `<embed>`** are not selectable. Rare (PDF viewers, old
   Flash); adding them as fields needs the same separate id series form words
   use, or every field after one renumbers.
5. **Document uploads** (a PDF menu or price list to link to). The library
   holds pictures, video and audio only.
6. **Jekyll posts' addresses** are taken from the file name
   (`/2024-01-01-title`), which is not Jekyll's default permalink; and a route
   table's parameter routes (`/blog/:slug`) are listed as pages although no
   one can be sent to that address. Both predate this audit.
7. **Angular projects before v17** keep static files in `src/assets`, but an
   uploaded picture is committed to `public/`. **VitePress rooted outside
   `docs/`** has the same problem. Both are in the compatibility notes.
8. **A Desktop value loses to a site's own `!important`** (known, see "The
   inspector" in the architecture notes).

## 6. Verification

- `npx tsc --noEmit` in `server/` and `server/client/`, `npm run checks:types`,
  and `npm run build` in `server/client/`.
- New checks: `websiteMasks` (112), `websiteAudio` (57, real route and
  Postgres), `websiteEmbeds` (98), `websiteFormText` (41); additions to
  `websiteFrameworks` (71), `websiteRouterTable` (34), `websiteTemplate` (63),
  `websiteDiscovery`.
- The positional-id claim was checked against the code before this change: the
  same fixture through a worktree at the previous commit gives identical ids;
  the only difference is the `<select>` that used to be rich text.
- `checks/browser/masksMediaForms.mjs` through the real editor in Chromium.
  In this container the client's Playwright wanted a newer Chromium build than
  `/opt/pw-browsers` holds; it was run through a `PLAYWRIGHT_URL` shim adding
  `executablePath`, which is an environment detail and not committed.
- The full `npm run checks` suite against a local Postgres: 195 of 196 files
  pass. The one failure, `hybridScraper.ts`, cannot launch the Chromium build
  its Playwright wants in this container and fails identically at the
  previous commit.
- The full browser suite (`npm run checks:browser`, through the shim): 23 of
  25 pass. `builderImages.mjs` and `builderRedesign.mjs` time out waiting for
  a library tile's title and the publish review's heading, and do exactly the
  same at the previous commit. `inspector.mjs`, `stylePanel.mjs` and
  `layersAndDelete.mjs` were updated for the Mask section and for a form now
  saying its words are fields.
- Rendered and looked at: the Mask section on a selected picture (circle,
  bottom fade, tiles), an uploaded audio file on the canvas, a frame showing a
  YouTube embed, and a placeholder field. The picture of the last caught a
  defect no check had: Settings → Link was offered on an input. Form words are
  never offered a link now, and `websiteFormText.ts` fails without that fix.
