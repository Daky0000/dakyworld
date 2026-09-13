# The Website Builder

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

## The Website Builder

**[server/docs/website-builder.md](../../server/docs/website-builder.md) is the map** —
every part of the Aug-2026 system plan, whether it is built, a skeleton or not
started, and where it lives. Read it before adding to this module; the seven
screens that are skeletons already say what they will hold, and the decisions
behind them are written down so they are not re-litigated.

It is a **product** now, sold as hosted seats on os.dakyworld.com rather than
used only in-house. Three decisions shape everything: hosted seats (so no
installed module, no license server, no update endpoint), billing through
`CarePlan` + `Invoice` + Paystack rather than a parallel `License` model, and
editable regions rather than blocks.

`src/services/website/`, `routes/website.ts`, the `/website` screens, and
`admin/index.html` at the repository root.

**Everything outside `services/website/` imports from
`services/website/index.ts` and from nowhere else inside it.** That is the
`website-editor-core` boundary: `parse`, `discoverFields`,
`validateFieldChange`, `sanitizeValue`, `detectConflicts`, `applyValues`,
`buildPreview`, `buildPublishPlan`, `describeChanges`. A second site, a client's
site, an AI proposing a change and an agent publishing one all go through the
same parse, the same sanitiser and the same conflict check, or they are four
editors that agree until the day they do not.

**A draft save is an exchange, not a shout.** `SitePage.draftRevision` is quoted
on every save and checked *in the same statement that writes*, so two editors on
one page cannot silently overwrite each other. A refused save changes nothing —
not the draft, not the revision — and answers 409 with both versions of every
contested field, which is what the comparison dialog renders. The revision is
monotonic and is bumped by a publish and by a discard as well as by a save:
both change what the draft is, and a second screen holding the old number has to
be told. `ifRevision` is refused explicitly rather than by Zod, because a
`ZodError` renders as "Validation failed" plus an issue list to somebody whose
actual remedy is to reload the page.

**The publish path never reads the source cache** (`sourceCache.ts`). The whole
purpose of the conflict check is to decide whether the page has moved under a
draft, and a copy taken ninety seconds ago cannot answer that. `publishPage`
invalidates the page it wrote, inside itself rather than at the call site, so a
second publisher — a rollback, an agent — cannot forget. Live-site reads get a
much shorter TTL than repository reads: GitHub Pages already lags a publish by a
minute, and a cache on top of that lag makes a working publish look dead.

**Rollback has two doors and they are different.** *Restore as draft* is the
default and is right nearly every time — a page usually moved on for reasons
unrelated to the edit being undone. *Publish this version* writes the whole
stored file back and is the emergency; because it can undo a developer's later
work it is never one click, and the diff is fetched first. **That diff compares
what a person can see, not the bytes.** The first version compared inner HTML and
printed plain text, so a file differing only in whitespace listed three changes
whose before and after were the same sentence — on the one screen that has to be
believed. Invisible differences are counted and said separately.

**`middleware/errorHandler.ts` is its own module** so a harness can mount it.
Whether a refusal reaches somebody as a sentence they can act on is a rule with
real consequences, and it was one nothing could exercise without booting the
whole application.

`checks/websiteBuilder.ts` covers all of it — 55 assertions, database only, the
page's HTML served from a local express so the real read path runs with no
network and no credential. Lets a non-technical person change
the words, links and pictures on a page of dakyworld.com and publish it, without
touching HTML and without waiting for a developer. The same module is what would
carry a client's site: `Site` has a `clientId` and nothing in it is shaped around
Dakyworld being the only row.

**The editable-region model, not the block model.** Pages become a list of
fields — headings, paragraphs, list items, link labels and destinations, button
labels, styles and destinations, image sources and alt text — grouped by the
section they sit in, with each section named after its own heading. Adding,
removing and reordering sections is deliberately **not** offered: that needs a
component library that knows how to render a new section, and rebuilding this
homepage's arches, orbs and count-up figures as generic blocks would be a
redesign wearing a migration's clothes.

**A button is its own kind of field, because it has two things a link does
not** — `kind: "button"`. Its words and its destination were always editable,
because those are what an `<a>` has. Which *style* it wears was not, so turning
the lime call to action on a page into the dark one meant editing HTML, which
is the thing this editor exists to avoid. And there was no control at all for
opening a link in a new tab.

- **A style is recognised structurally, never from a list of button names.** A
  button has one when it carries both `X` and `X-something`, so `class="btn
  btn-primary"` has stem `btn` and style `btn-primary`, and
  `class="category-btn"` has neither — nothing on it carries `category`.
  `resolveVariantChange()` is the whole rule and it takes the stem from the
  style being **asked for** rather than the one already worn, which is what
  lets a button wearing only `btn` be *given* a colour. Without that, "None"
  would be a one-way door: publish a button with its style removed and no menu
  could ever reach it again.
- **That rule is the security story.** Free-text class editing — which is what
  a naive version of this is — reaches `hidden`, or any utility class on the
  page, from a control a client is meant to use for choosing a colour. Here the
  element must already carry the class the request hangs off, so from
  `class="btn"` you can reach `btn-anything` and nothing else. A style that is
  not allowed is **refused, never coerced**: a style that silently became a
  different style is worse than one that did not change.
- **The swap is one token.** Every other class survives, in place — `mt-9` on a
  button is a developer's spacing decision and has nothing to do with which
  colour somebody picked — so a publish is still a one-line diff.
- **The menu comes from the site's stylesheet, the rule does not.**
  `siteStyleClasses()` reads the linked CSS (same host only, cached beside the
  pages, degrading to the classes the page itself wears). Read off the page
  alone the homepage offered two of this site's three button styles, because
  nothing on it wears `btn-ghost`. **It is a menu, not a permission** — nothing
  about whether a style may be *written* consults it.
- **`target` and `rel` are one fact.** `target="_blank"` without
  `rel="noopener"` hands the page it opens a live handle on the one it came
  from, and nobody choosing "open in a new tab" is choosing that. One switch
  writes both and removes both, and a `rel` token the developer put there for
  their own reasons (`nofollow`) survives in each direction. Removed, not
  emptied: `target=""` is not "no target" to a browser, which is the one place
  the `style=""` precedent does not apply.
- **A `<button>` element gets the style control and no destination**, because
  where a `<button>` leads is decided by script. It was already editable as
  ordinary text; what it did not have was the switch its `<a>` siblings have.
- The style is **pushed into the frame** like text and inline style are, so a
  colour changes under the cursor rather than after the next save and reload.
  The editor sends both halves of the swap, because it is the side that knows
  which token is the style — reading it back off the element would be a second
  implementation of that rule, in another language, that has to agree with the
  first for ever. `newTab` is in `LIVE_KEYS` for the opposite reason: it changes
  nothing visible, so reloading to show it would cost a scroll position and a
  caret for no difference at all.
- **Destinations are offered, not validated into a corner.** The route sends
  the site's own pages and the box is a datalist over them, because `contact`
  instead of `/contact` is a link to nowhere that looks exactly like a link
  until a visitor clicks it. An address off the site, an anchor and a `mailto:`
  still go in the same box.

`checks/websiteButtons.ts` (59) covers it against the real pages here. Half of
it is negatives: an ordinary link must stay a link, a `<button>` must not be
offered a new tab, and every one of `hidden`, `btn`, `""`, `btn-primary hidden`
and `btn-<script>` must leave the page byte-identical.

```
GitHub (or the live site)  →  parse.ts     offsets for every element
                              regions.ts   fields, grouped into sections
                              sanitize.ts  what a client may put back
   SitePage.draft ──────────→ applyValues  splice the original bytes
                              publishPage  one commit → Pages rebuilds
```

- **Nothing is re-serialised.** `parse.ts` exists to answer one question — which
  bytes may be replaced — and an edit is a splice at recorded offsets. Every
  ordinary parser gives you *a* document back rather than *the* document, and the
  diff on a publish would be the whole file instead of the heading that changed.
  `checks/website.ts` holds it to that against every real page in this repo.
- **The repository is the source of truth; only the edits live here.** A draft is
  `{ fieldId: { value, original } }` — never a copy of the page — so a developer
  goes on editing these files underneath. Ids are positional, which is why
  `original` exists: a draft written against a heading that has since moved
  **refuses to publish and says so** rather than writing itself into whatever now
  sits at that position.
- **Read from GitHub when a token is configured, from the live site when not.**
  The second is the honest fallback rather than a blank screen. **Writing has one
  route**, and publishing without a token that can write says so — it does not
  save a draft and call it published. The repository must also be on the writable
  list under Settings → Developer; that list denies by default.
- **What a build script owns is not offered.** Everything between a `BEGIN`/`END`
  comment pair is excluded, keyed on the convention rather than the two block
  names, so the generated `<head>` metadata and the visible breadcrumbs cannot be
  edited into something `npm run site` silently reverts a week later. The title
  and description sit *outside* the markers and are editable, and carry a note
  saying their generated link-preview copies need `npm run site` afterwards.
- **The preview needs three things and is wrong without any one of them** —
  `previewDocument()`. A `<base>`, because the HTML is served from the OS's
  origin where the site's CSS does not exist. The page's own CSP widened so
  `'self'` includes the website, sent **as a header**: a `<meta>` policy can only
  narrow what a header already allows, so the app's own header went on forbidding
  the site's stylesheet however the tag was rewritten, and the preview rendered
  as unstyled black text. And `form-action 'none'` plus `frame-ancestors 'self'`,
  because a preview of the contact page must not send a real enquiry. Analytics
  hosts are stripped from the policy so an afternoon of editing does not appear
  in the owner's own traffic.
- **Stripping a tag is not the same as removing the code.** `sanitize.ts`
  unwraps unknown elements and keeps their words, which is right for a pasted
  `<div>` around a sentence and nonsense for `<script>`: the parser never reads
  into one, so "its children" is the raw source, and a heading cheerfully
  displayed the words `alert(1)` to every visitor. `CODE_ELEMENTS` are dropped
  whole.
- **`class` and `data-*` survive sanitising on purpose.** The homepage figures
  are a `<strong class="count-up" data-target="70">`, and dropping the attributes
  would freeze the number at zero.
- **Pages are discovered, never seeded.** From the repository tree where a token
  exists, from `sitemap.xml` otherwise — and **a file the sitemap does not list
  arrives hidden**, which is how the plan document and the 404 stay out of a
  client's page list without anybody naming them in code.
- `dakyworld.com/admin` is a static page that hands you to
  `os.dakyworld.com/website`. It does **not** ask for a password: Pages has no
  server to check one against, so a form there would post credentials to another
  origin, which is the shape of a phishing page. It does not redirect on its own
  either — a page that bounces you onward bounces you onward when you press back.

**Three modes, and Visual is the one people use.** *List* is the form — every
field under its section, the only view that can answer "did I miss anything"
and the only one that reaches a field with nothing visible to click (the title,
the description). *Preview* is the page with no editor furniture on it at all.
*Visual* renders the real page and you click the thing you want to change.

**The editor takes the whole window.** `Layout` drops its centred `max-w-7xl`
column for `/website/pages/*` and becomes a `h-screen` flex column, so the page
being edited is a page rather than a card in a reading column. The properties
panel is on the **left**, the page fills what is left of the screen, and the
layer list — every field, under its section, click to select — sits at the top
of that panel rather than behind a disclosure triangle. It is the only way to
reach the page title, a picture's description, or a heading three screens down.

- **No drag and drop, and nothing moves.** What that phrase usually means is a
  layout builder with a component model; this site has none, and turning
  somebody's hand-written HTML into something only the builder can open is the
  opposite of the point. Selection, words, and look — nothing else.
- **Single click selects, double click types.** The caret goes into the element
  on the page, at its real size and in its real typeface; the boxes in the panel
  are how you reach what has nothing visible to click, not the main way in. Only
  text, richtext and link fields are typeable — a picture is changed by address,
  because there is nothing to type into it. `Escape` ends typing, and the
  element is `contenteditable` only while it is actually being typed into.
- **Changes are pushed into the frame, not waited for.** `text` and `style` go
  down to the picker as they change, so a colour moves while the slider is still
  moving. The frame is reloaded only for an edit that cannot be pushed — a
  link's destination, a picture — which is what `needsReload` tracks. Reloading
  on every autosave, as it used to, threw away the scroll position and the caret.
- **Eleven of the homepage's 203 fields have no element to push at**: the page
  title and description by design, and nine whose `attrInsert` the parse never
  recorded. The frame answers `absent` for those and the editor falls back to
  `needsReload`, because a push that lands nowhere and says nothing is
  indistinguishable from an editor that is broken.
- **The effect that seeds `edits` refuses to run while `dirty.current` is set.**
  Clicking into the frame and back out again focuses the app window and
  refetches the page; without that guard the refetch handed the effect a fresh
  copy of the saved draft in the middle of somebody typing, and their unsaved
  words went back to what the server last knew. The guard is the fix, **not**
  switching the refetch off: an editor that never refetches never catches up
  with the site either, which is its own way of showing somebody stale words and
  letting them conclude that nothing worked.
- **The editor reads the page back from the published site, and Pages takes a
  minute or two to rebuild.** Until it has, a publish that worked looks exactly
  like one that did nothing. The banner says so, the page query is re-invalidated
  at 20s, 45s and 90s, and the circular arrow in the bar looks again on demand.
- **The frame acknowledges every push, and silence is a fact.** A push that was
  applied and a push that never arrived look identical from this side, and one
  of them leaves somebody typing into a page that never changes — which is
  exactly how it was reported. The frame answers `applied`; a push with no
  answer inside 900ms sets `liveBlind`, which says so in the panel, sets
  `needsReload`, and shortens the autosave to 600ms so the reload becomes the
  thing that shows somebody their own change. It is slower than the live push
  and it is always right, which is the correct trade when the fast path has
  stopped working for a reason nobody has found yet.
- **A push the frame cannot land is said out loud.** An `absent` reply marks the
  field in the panel — "not on the page itself" for the title and description,
  "appears once the draft saves" for the rest — because an edit that changes
  nothing visible and explains nothing is indistinguishable from a broken editor.
- **The picker never hands back an element's own `innerHTML`.** It carries the
  `data-dw-*` this script put on the children, and `data-*` survives sanitising
  on purpose (`data-target` drives the count-up figures), so those marks were
  being stored in drafts and would have been committed into the live page.
  `words()` clones and strips them, and `sanitize.ts` drops `data-dw-*`
  independently so a draft written before that fix cannot carry them either.
- **The page is swept once so it can be clicked.** A site whose sections fade in
  on scroll shows almost nothing in a frame that has never been scrolled, and
  nobody can click a heading they cannot see. Under `?pick=1` the picker scrolls
  the document top to bottom to trip every `IntersectionObserver`, then marks
  anything still under 10% opacity with `data-dw-shown`. Never in plain Preview:
  that one is meant to be the page exactly as a visitor gets it.
- **Undo is over the whole draft, not per field.** One Ctrl+Z should take back
  whatever just happened, and that is as likely to be a colour as a word.
  Snapshots are `JSON.stringify(edits)`; typing debounces onto one step, and
  discrete actions — a toggle, an alignment, adding a border — commit their own.
- **The server marks the elements, the browser does not find them.**
  `previewDocument(html, url, fields)` inserts `data-dw-field` at each field's
  `attrInsert` under `?pick=1`; the frame posts up which one was clicked. The
  ids are positional, so working them out on the other side of the frame would
  be a second `readPage` that has to agree with the first for ever.
- **A nonce in `style-src` switches off every `style=""` attribute in the page,**
  and that attribute is the only thing this editor writes. `'unsafe-inline'` is
  what permits style attributes, and a nonce anywhere in the directive makes a
  browser ignore it — so nonceing the picker's own stylesheet silently disabled
  the feature. The element kept the attribute and the browser dropped the
  declarations: a heading set to align left did not move, with nothing on screen
  to say why. `style-src-attr 'unsafe-inline'` puts attributes back without
  loosening `<style>` elements, and `checks/websiteVisual.ts` now asserts it.
  **Asserting that the editor set the attribute is not a test of anything** —
  four rounds of green tests did exactly that while the feature was dead. Assert
  the computed style.
- **The picker's script and styles carry a nonce the response's CSP names**, so
  the page's own inline scripts stay forbidden and only this one runs. Clicks
  are swallowed rather than followed, for the same reason `form-action` is
  `'none'`.
- **A style is an inline `style` on the element that was selected**, never a
  rule in a stylesheet — a rule applies to every page at once and to elements
  nobody was editing. Anything the panel has no control for is left as the
  developer wrote it and named on screen, so it is visible that it survived.
- **The panel is a fixed set of controls, in three sections.** *Appearance*
  (background, width, height, opacity, radius, overflow, padding on four sides,
  and shadow / text shadow / transform / filter behind an "Add" link),
  *Typography* (face, size, colour, weight, italic/underline/strike, alignment,
  leading, tracking, case) and *Border*. Numbers scrub — drag a field's label.
  Every colour opens one popover: the brand swatches first because they are the
  right answer nearly every time, then a picker, a hex box and an alpha slider.
  Blank means "as designed" everywhere, which is why they are text fields
  holding numbers rather than `<input type="number">` with a zero sitting in it.
  Filter is the one hand-typed CSS string and the one place the no-text-box rule
  is bent; it is behind the "Add" link, and a value that does not parse does
  nothing rather than breaking the layout.
- **`padding` shorthand is expanded on the way in and written as longhands.**
  A developer's `padding: 4px 8px` and the panel's four sides would otherwise
  fight, and the shorthand would win.
- **A refusal from GitHub is a setting, and settings say what to do.**
  `publishPage` translated only "no token" and "repo not on the writable list";
  a token that exists but cannot write raised a bare `GitHubError`, which the
  central handler renders as the flat "Something went wrong." Every status
  GitHub can answer with is now a sentence naming what to change — 401 the token
  has expired, 403 it needs Contents: write on that repository, 404 the
  repository or branch is wrong or invisible to it, 409/422 a branch protection
  rule. See the note on error classes in the error handler: deciding which of the two kinds a
  new error class is, is not optional.
- **`safeStyle` filters what is stored as well as what is written.** Nothing in
  the panel can produce a bad declaration, so it is not the editor this guards
  against: a draft is stored JSON that outlives its session and is spliced into
  a public page. `url(` goes because it fetches from a page with a strict CSP,
  `expression(` because old IE ran it, and anything with a quote or an angle
  bracket in it because that is how you leave an attribute.
- `checks/websiteVisual.ts` (190) runs against every real page here: marking 203
  elements changes no field's value and lands no mark outside a tag, and a style
  edit is still a one-line diff in a 474-line file.

Built from `reusable_website_editor_system_plan.pdf` (23 Aug 2026), whose block
model was deliberately not followed for this site; the plan lists converting an
existing hard-coded website as a non-goal for version one, and this is why.

## Framework sites (Next, Astro, SvelteKit, Nuxt, Vue, Vite)

The page list used to ask one question — "which folder holds the `.html`?" —
and a framework project has no answer until it is built, so every one of them
got an empty table and a 422 telling the customer to build their site first.
Their pages were `app/page.tsx` and `src/pages/index.astro` the whole time.

Framework knowledge lives in `services/website/frameworks.ts` as a registry,
split in two on purpose:

- a **route adapter** maps a repository's file list to routes — pure string
  work, no file ever read, which is what makes `checks/websiteFrameworks.ts`
  an array of paths and no fixtures;
- a **syntax adapter** reads and writes a file's fields: `jsx.ts` for the JSX
  family, `template.ts` for the HTML-shaped ones (`.astro`, `.vue`, `.svelte`).

They are separate because they do not line up: Next and Vite share the JSX
adapter and nothing else; Nuxt and a plain Vue SPA share the template adapter
and disagree about routing. Adding a framework is one detector, one route
function, and a syntax adapter only if its files are a new language.

- **`template.ts` scans; it does not compile.** There is no parser here for any
  of the three languages, so the rule is that anything it is not certain about
  is the code's: a `{` or `}` anywhere in a text node or attribute value, a
  bound or directive attribute (`:href`, `bind:`, `@click`, `client:load`),
  `<script>`/`<style>`, Astro frontmatter, and a component's own props. Each
  refusal is an issue with a line number rather than a silent omission, because
  a field that is quietly missing reads as a bug in the editor.
- **A brace typed into a text box is escaped** (`&#123;`). Somebody writing
  "{free}" means the word; writing it back raw would turn their heading into a
  template hole that fails the build.
- **One validator, two adapters.** `validateFieldValue` is exported from
  `jsx.ts` and used by both, so the two cannot come to disagree about what an
  `href` may contain — which is exactly how two editors end up agreeing until
  the day they do not.
- **Every accepted edit round-trips before it is returned**: discover, splice,
  discover again, and refuse unless the same field IDs come back with only the
  edited values changed. That is what stands in for a compiler.
- **`Site.sourceKind` is written by the scan**, because the scan is the only
  thing that has looked. It decides which editor the Edit button opens: a
  framework route is source, and handing it to the visual editor would offer
  somebody a file it cannot read.
- **A framework route's `filePath` is addressed from the repository root**, and
  the scan returns `repoPath: ""` with it. A route file stored relative to some
  chosen page folder would be committed to a path that does not exist.
- **Registry order is load-bearing.** Every SvelteKit project has a
  `vite.config.ts`, so `vite-react` is last and claims a repository only when
  nothing else has.
- The HTTP contract did not change: `checks/websiteTemplateRoute.ts` puts a
  `.vue` file through the same browse, review, review-hash guard,
  expected-file commit guard and audit row a `.tsx` goes through.
