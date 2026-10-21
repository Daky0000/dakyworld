# The Website Builder

> Part of the DakyXTech OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

## The Website Builder

**[server/docs/website-builder.md](../../server/docs/website-builder.md) is the map** —
every part of the Aug-2026 system plan, whether it is built, a skeleton or not
started, and where it lives. Read it before adding to this module; the seven
screens that are skeletons already say what they will hold, and the decisions
behind them are written down so they are not re-litigated.

It is a **product** now, sold as hosted seats on os.dakyx.com rather than
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
the words, links and pictures on a page of dakyx.com and publish it, without
touching HTML and without waiting for a developer. The same module is what would
carry a client's site: `Site` has a `clientId` and nothing in it is shaped around
DakyXTech being the only row.

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
- `dakyx.com/admin` is a static page that hands you to
  `os.dakyx.com/website`. It does **not** ask for a password: Pages has no
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
- **Two policies, and the rule between them is the security boundary
  (7 Oct 2026).** The editing preview keeps the app's origin
  (`allow-same-origin`) because the editor reaches into it through
  `contentDocument`, so its `script-src` is the picker's nonce and *nothing
  else* — no `'self'`, `https:`, `data:` or `blob:`. Any page script that ran
  there was the person editing: on 29 Sep a demo fix widened it to every page,
  and a `<script src="data:…">` in a customer's page could read `/api/auth/me`
  and the editor window around it — on os.dakyx.com that is the whole OS.
  Preview mode, and any page `drawnByScript()` says is an empty app shell, get
  `ISOLATED_PREVIEW_POLICY` instead: scripts on, **no** `allow-same-origin`, so
  the document is opaque, carries no session and cannot touch the editor.
  `checks/websiteEditorComplete.ts` asserts both, and that no policy ever has
  `allow-same-origin` beside a non-nonce script source. Demo pages
  (`routes/demos.ts`) are sandboxed the same way for the same reason.
- **A style is an inline `style` on the element that was selected**, never a
  rule in a stylesheet — a rule applies to every page at once and to elements
  nobody was editing. Anything the panel has no control for is left as the
  developer wrote it and named on screen, so it is visible that it survived.
- **The panel is the same three tabs for every element** — General, Style,
  Interactions — since 11 Oct 2026; see "The inspector" at the end of this
  file. Two things from the panel it replaced still hold. Every colour opens
  one popover: the brand swatches first because they are the right answer
  nearly every time, then a picker, a hex box and an alpha slider. And blank
  means "as designed" everywhere, which is why sizes are text fields holding
  numbers rather than `<input type="number">` with a zero sitting in it.
- **A shorthand is expanded only when one of its sides is written.** A
  developer's `padding: 4px 8px` and the panel's four sides would otherwise
  fight, and the shorthand would win — so writing `padding-top` takes the
  shorthand apart first. But it is *read* as four sides without being touched:
  changing a colour must not turn `margin: 0 auto` into four lines of diff
  (`writeProperty` in `client/src/lib/websiteStyleValues.ts`).
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
- **The site's own pop-ups are hidden in the editing frame** (picker script,
  `looksLikeOverlay`): fixed-position elements that name themselves cookie,
  consent, chat, popup, modal… or are `role=dialog`, pinned to the bottom edge, or
  a small corner button. Never a `header`, a `nav` or anything holding one — a
  fixed site header is something people edit. The frame posts
  `{type:"overlays", hidden, hiding}`; the editor shows a note with Show/Hide and
  remembers the choice per browser. Selecting a field inside a hidden pop-up
  un-hides that one. The published page is untouched.

### Customers, accounts and plans (7 Oct 2026)

- **Plan features are one table, `websiteTierFeature(path)`, and the gate that
  reads it is registered before every route** in `routes/website.ts`. It used to
  sit below ten register calls and saw none of their routes, so coverage depended
  on file order. `checks/websiteTierFeatures.ts` walks the real router: the gate
  precedes the first route, and every route with an SEO/assistant/agent/source
  segment maps to its feature, nothing else does.
- **Client sign-off is `ReviewLink`**, a hashed 192-bit token over a frozen draft
  snapshot with one atomic decision (`services/websiteReviewLinks.ts`); the
  reviewer's page is public at `/review/:token`. **Scheduling is
  `ScheduledPublish`**, claimed by conditional update and run through
  `publishPageCommand` as its creator, refused if the draft moved.
- **`Site.settings` is written only under a row lock** — `updateSiteSettings` /
  `setSiteSetting` in `services/websiteSiteSettings.ts`. A whole-document write
  drops whatever another feature saved a moment earlier; there are none left.
- **Inviting by email creates the account** (`findOrInvite` in
  `websiteAccess.ts`): an external customer account with no password plus a
  set-password link, and the inviter is told the same thing whether or not the
  address already had an account. A customer cannot add people by internal user
  ID; a closed account is not reopened by an invitation; 20 new accounts per
  inviter per day.
- **Deleting is a 30-day hold, never immediate** (`services/websiteDeletion.ts`).
  A site goes offline at once (hosted serving, publishing, review links and
  scheduled publishes all check `deletionScheduledFor`) and can be restored from
  `/website/account`; the daily housekeeping tick erases it. A customer closing
  their account is switched off and signed out at once and **anonymised**, not
  deleted, after the hold, so invoices and the audit trail still resolve.
  Refused while paying or while they are the only manager of a site others use.
- **Guided tours are data plus events** (`lib/tours.ts`, `components/TourHost.tsx`).
  A step points at a `data-tour="…"` element and, where it can, waits for an
  action the screens announce with `tourAction()` — `field-selected`,
  `text-edited`, `device-changed`, `mode-preview`, `publish-review-opened`… —
  emitted from state, so every route to the action counts. **A new screen
  feature a tour describes must announce its action, or the tour waits for
  ever** (the step still has Skip). The host is not modal; optional steps
  whose target is off screen are skipped. Progress is `User.uiState` via
  `PATCH /auth/ui-state` (row-locked merge; a late "started" never undoes
  "done"), cached in localStorage. `checks/browser/builderTour.mjs` takes the
  editor tour end to end. The editor hosts its own `TourHost` (it renders
  outside `Layout`); `Layout` hosts the workspace one.
- **Onboarding is `/website/welcome` plus `GettingStarted`.** No website →
  the welcome (wrapping `WebsiteSubscriberOnboarding`, which lands in the
  editor with `?walkthrough` and so with the tour running); "Skip for now" is
  remembered so Pages does not bounce back. The checklist is derived from the
  site and account, never ticked by hand.
- **Hosted sites get a form inbox** (`services/websiteForms.ts`). When a page
  is *served* (not when it is published), a `<form>` that posts nowhere —
  no action, `#`, `mailto:` — and looks like a message (POST, a textarea, an
  email/phone/name field; never a search) is pointed at `POST /__dakyx/forms`
  on the site's own host, with a `_page`, a `_form` and a `_gotcha` honeypot.
  The hosting middleware answers that path before its GET-only rule. A filled
  honeypot or a link flood is stored as spam and not emailed; a bot is told the
  same as a person. Files are refused (415), floods are limited in memory
  (no IP is stored), `_next` may only be a same-site path. The inbox API is
  `manage`-only (visitors' contact details); the ETag gains `-f1` when the
  served copy differs from the stored one.
- **Visitors are counted server-side** (`services/websiteVisits.ts`) as the
  hosting middleware serves a page (200 or 304): bots, link previews,
  prefetches and HEAD are not visits. A visitor is a SHA-256 of a daily salt
  that is never stored, the site, the IP and the user agent — kept in memory
  for the day only. Counts flush every 30 s into `SiteVisitDay` (path `"*"` is
  the whole site) and `SiteReferrerDay` (Search · Google, Facebook, Direct, a
  domain; clicks inside the site are not a source). A restart re-salts, so a
  returning visitor can be counted twice that day: an overcount, never a loss.
- **Help** is `GET /website/help` (account route): email and phone from the
  company profile, and WhatsApp only when `profile.whatsapp` is set in System
  settings — empty by default on purpose.
- **A phone opens the editor in List mode**, and the toolbar's secondary actions
  live in More. Menus in the bar sit at `z-[9990]`, above the floating Layers
  window (`z-[9980]`), which opens in the same top-right corner — under it,
  nothing in More could be clicked, which is what `builderRedesign` caught.

### The editor shell and the welcome flow (7 Oct 2026)

- **The editor is four columns now**: a top bar (page switcher, save status,
  a mode *menu*, devices, zoom, search, undo/redo, Save, Publish with an arrow
  menu for save/download/versions/discard, and an account menu for plan,
  designer controls and light/dark), a **tool rail** that opens one drawer at a
  time (Layers, Theme, Media, SEO, Grow, Help; Add, Notes and History open
  their dialogs), the page, and the **inspector on the right**, which exists
  only while something is selected. The rail carries `data-tour="more"`.
- **SEO, Grow and the Theme drawer's font switcher are one component** —
  `WebsitePageSeoInspector` with `section="seo" | "grow" | "theme"`. Splitting
  it into three would be three copies of the same queries that drift.
- The first-edit checklist on the canvas is derived from state (selected,
  changed, looked at a phone, published); only "put it away" is stored.
- **Layers docks by default** inside its drawer; popping it out is still
  remembered (`dw-structure-floating`). See "Deleting, moving and the floating
  Layers panel" below for where the floating window is drawn and how it docks.
- **`/website/welcome` is `WebsiteWelcomeFlow`**: name, purpose (chooses the
  starter template), address-or-not, how to start, how they heard, then a build
  log whose every line is a request that actually resolved. **Choosing GitHub
  adds a screen** (8 Oct 2026): the repository, and an install button that
  opens the app's install page in a new tab with a signed `state`. With the
  app's *Request user authorization (OAuth) during installation* box ticked,
  GitHub comes back to `GET /api/website/github/callback` with a code; that
  becomes a user token, `/user/installations` (+ each one's repositories) says
  what *this person* reaches, those rows replace their `GithubRepoClaim`s, and
  the token is revoked. The screen polls `GET /website/github/connect` until the
  typed repo appears, then `POST /sites` takes `githubRepositoryId` — refused
  without a claim, re-checked against the installation now — creates the site
  with no starter, the client runs `/scan`, and the flow lands on the page at
  `/`. **An installation id from a customer is never trusted**: they are
  sequential and sit in a URL anybody can edit. Until this, `PUT
  /sites/:id/github-app` let a site manager send just an installation id and a
  repository id, which `assertWebsiteConnectionChange` read as "no change";
  non-staff now need a claim there too. Needs `GITHUB_APP_CLIENT_SECRET` (the
  client id is read from `GET /app`), and every host people sign in on listed
  as a callback URL on the app. The team route is the paid setup assistance and
  shows its real price. Answers go on `User.uiState.welcome` (`heardFrom`,
  `purpose`, enums only). With no address, `POST /website/sites` now defaults
  `publicUrl` to the hosted address its first publish will give it (see "No
  address is ever invented" under Launch hardening) instead of the client
  inventing `name.com`. `checks/browser/welcomeFlow.mjs` walks it.

### The redesign, finished (7 Oct 2026, second pass)

- **Every rail item is a drawer now** — Add (`WebsiteSectionsPanel`), Notes
  (`WebsiteNotesPanel`) and History (`WebsiteVersions inline`) joined Layers,
  Theme, Media, SEO, Grow and Help. The old dialogs still exist for the
  command palette's callers.
- **Style has Normal and Hover.** Hover (`WebsiteHoverPanel`) writes only the
  `--dw-hover-*` properties the published page already understood; the element
  is shown in its hover state while the view is open. Shadow presets are tiles
  in both (`SHADOW_PRESETS`, `InspectorDesign.tsx`).
- **Interactions are motion, chosen by name.** The inspector stores a keyframe
  *name* in `--dw-enter` / `--dw-loop` / `--dw-scroll` (plus durations);
  `motionCss()` in `shared/websiteInteraction.ts` is the only CSS that turns
  them into animation, published by the same `regenerateInteractionStyles` as
  hover. Scroll-linked entrances use `animation-timeline: view()` where
  supported and play on load elsewhere; everything stops under reduced motion.
  No script is ever added. The panel became a list of interactions with two
  more slots (hover, click) on 11 Oct 2026 — see "The inspector" below — and
  the "When clicked" destination it used to hold is Settings → Link, with
  WhatsApp, phone and email as chips. `checks/websiteInteractions.ts` holds it.
- **The canvas overlay** (`WebsiteCanvasOverlay`) draws the selection label, the
  mini toolbar and the dark format bar for highlighted words over the frame, in
  the editor — nothing in it can reach the page's HTML. The format bar replaced
  the panel's text-formatting box.
- **The right-click menu is the design's list**, each item a real operation:
  Move up/down are structure moves (Designer controls), Hide on phone writes the
  phone override `display: none`, Delete/Duplicate need the field's structure
  permission and are disabled otherwise.
- **The tour host** has three cards: a centred welcome (the offer), step cards
  with a spotlight, and a centred finish with confetti. A reading step blocks
  the page (a click nudges the card); a doing step (`waitFor`) lets clicks
  through and pulses its ring. Steps can ask for an inspector tab
  (`requestTourTab`). It portals into `.website-editor` so dark mode applies.
- **A drawer's contents must not shrink**: `.dx-dbody > *` is `flex-shrink: 0`;
  without it the section cards collapsed into each other.

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

## Sites an AI built (Lovable, Bolt, v0, Replit)

These are the sites customers actually arrive with, and the framework work above
was not enough for them on its own. A Lovable export is a Vite + React project
whose file tree has one page in it and whose real pages are a `<Route>` table
inside `App.tsx`, with most of the writing in component props and data arrays.
Listing one row beside a page full of somebody's own words is the failure this
closes.

- **`router.ts` reads the route table.** `<Routes>`/`<Route>` JSX and
  `createBrowserRouter([...])` objects, nested paths joined to their parents,
  `index` meaning the parent's own address, lazy imports resolved, `@/` resolved
  to `src/`. A path built from a variable is **not** listed: a page list is a
  promise that the address is real. An import that resolves to nothing keeps the
  router file rather than pointing at a path that does not exist.
- **Only `readsRouteTable` adapters pay for it.** The scan reads at most three
  candidate files, best-named first, and stops at the first real table.
- **`CONTENT_NAMES` in `jsx.ts` decides what is content.** A component prop or a
  data key is offered only when its NAME reads as words a visitor sees.
  `className`, `variant`, `id`, `icon` and `type` are strings too, and every one
  of them is structure — offering them because they were strings is how an
  editor silently breaks a design nobody asked it to touch. A missing field is
  the safe failure; a wrong one is not.
- **`.ts` and `.js` are editable now**, for `src/data/site.ts` and friends. A
  file with no content-named strings simply has no fields, which the editor says
  out loud.
- **A template literal is refused**, because writing it back as a quoted string
  would change how the file reads for its developer.
- **`markdown.ts`** covers Docusaurus, Eleventy, Hugo, Jekyll and Astro content:
  front matter scalars whose key reads as content, plus the body as **one**
  field. Not split into paragraphs — Markdown's meaning is in its layout, and
  handing somebody half of it invites them to destroy the other half. A newline
  in a front matter value and a body beginning with a fence are both refused.
- **A source publish now opens a publish job** (`sourcePublishCommitted`). A
  framework host builds before anybody sees the change, so "committed" and
  "live" are minutes apart and the build can fail in between. There is no
  expected hash for these: the committed file is not the file the visitor
  receives, so the only honest signal is the words appearing at the address.
- **Uploaded images are committed with the file that references them**, into the
  framework's own static folder (`publicFolder`) — `public/` for most, `static/`
  for SvelteKit, Hugo and Docusaurus, the root for Jekyll and Eleventy. One
  commit, so there is never a minute where the page is live and its pictures are
  not.
- **The Edit button is decided by the file, not by the site.** A framework
  repository still has real `.html` pages in it, and sending those to the source
  editor took people away from the visual editor that opens them perfectly well.

## The framework page editor

Built 14 Sep 2026, after the Edit button landed somebody in a file browser when
they had clicked a page called Pricing. `websiteFrameworkView.ts` and
`WebsiteFrameworkEditor.tsx`: the live page on the left, that file's fields on
the right.

- **We do not build the project, and will not.** Turning a `.tsx` into HTML
  means running somebody's toolchain, and a rendered heading has no general way
  back to the literal it came from once it has passed through a loop, a prop and
  a layout. The HTML already exists — it is the published page — so that is what
  goes in the frame.
- **`mapJsxFieldsToHtml` decides what is clickable**, and it is strict on
  purpose: same tag, identical decoded value, unique on both sides. Two
  identical paragraphs match nothing. A guess here would show somebody one
  heading, take their edit, and change a different one.
- **`allowEditing` is false in the frame.** Typing happens in the panel, because
  the value being changed is the literal in the file, not the rendered text.
- **The live page can be behind, and says so.** It is whatever the host last
  built; after a publish the screen says the host is rebuilding rather than
  pretending the picture is current.
- **A page that was never deployed has no picture**, and the reason is on screen
  instead of an empty frame. Its fields still edit and publish.
- **The preview embeds no uploaded assets** — unlike the HTML editor's, which
  shows an unpublished draft. This shows what the public is already served.
- **Typing on the page works**, for the matched elements only: the preview's
  own picker is switched on, the words come back as a `text` message, the tags
  are stripped (a literal in a source file is plain text), and it becomes an
  ordinary edit to that field. The frame is never the record of anything.
- **Selection is two-way.** A field taking the caret outlines its element.

### What a framework page cannot have, and why

The HTML editor can do more because it owns the file: what it shows *is* the
bytes it writes. On a framework page the file is not the page, so the parts of
the builder that edit markup have nothing to write into:

- **styling** — the editor writes an inline `style` onto an element. The
  rendered `<div>` came from a component; unless the class list is a literal in
  this file, there is no byte to change;
- **structure — adding, moving or deleting sections** — those splice nodes. In
  JSX the "section" may be a `<Features items={…} />` or a `.map()`, and moving
  the rendered node means editing code;
- **shared elements and layers**, for the same reason;
- **anything not traceable to a literal** — text from a CMS, or a string the
  code assembles (`` `Item ${count}` ``, a ternary). A value that *appears*
  twice is no longer on this list; see below.

That list is the honest boundary rather than a backlog. Text, links, image
sources and alt text are what a literal can be, and those are what is offered.

### Following, counting, naming (14 Sep 2026)

Two sentences used to lock fields whose words were sitting in a string literal:
"these exact words appear more than once — a developer can name this one with a
`data-dw-field` marker", and "this part of the page is built by its code". Both
were true and neither was any use to the customer reading it. Three answers, in
`jsx.ts` and `sourceMarkers.ts`:

1. **Follow the value.** `<Hero title={hero.title} />`, `{TAGLINE}` and a
   backtick literal with nothing substituted into it are all static strings. The
   value is followed back to the `const` — a plain one, or a fixed key path into
   a `const` object *in the same file* — and that literal is the field. A
   backtick literal is written back between backticks. One literal named in two
   places is **one** field, so an edit reaches both. A name declared twice in the
   file is never followed: choosing a scope is a guess.
2. **Count the copies.** Identical words on the page are paired with identical
   literals in document order — but only when the counts agree **exactly** and
   only **one file** is in the running, and never over an element already matched
   by marker or by a value unique both ways. Recorded as `confidence:
   "positional"`. Counts that disagree still refuse: a fourth copy on the page
   means a source this does not know about, and pairing from the top would be
   wrong from there down.
3. **Name it.** `POST /website/pages/:pageId/name-fields` (the "Name these
   fields" button on a locked field) writes the `data-dw-field` itself, one
   attribute per element, one commit, `expectedFiles`-guarded like a publish. The
   same commit removes any marker *this editor* wrote (`dw.` + 12 hex) that is
   absent from the built HTML — a marker on a component that drops unknown props
   bought nothing, and litter in a customer's repo is worse than the ambiguity.
   An author's own marker is never removed. A string in a data file is refused
   rather than named: there is no element of its own to attach a name to.

Markers only take effect once the site rebuilds, and the response says so.
`checks/websiteFieldNaming.ts` holds the claims, negatives included.
- One element can carry two fields (a link's words and its destination); the
  click prefers the words.

## The visual editor on a framework page (14 Sep 2026)

The whole builder — layers, drag, responsive styling, shared elements, the
picker — now opens a framework page, because the editor is handed the **built**
HTML rather than the `.tsx`. Nothing in `regions.ts` or the editor changed; what
changed is where `pageSource` gets its bytes and what a publish writes.

- **`renderSource.ts` gets the HTML, and never runs the project.** `npm install
  && next build` on a connected repository is remote code execution with our
  database credentials in the environment — an npm lifecycle script in any
  transitive dependency runs as us before a line of their app compiles. So the
  order is: a prerendered export committed in the repo (`out/`, `dist/`,
  `build/`, `.output/public/`, `_site/`), then a **render service** if the
  operator has stood one up (`WEBSITE_RENDER_URL` — the seam where a sandboxed
  builder plugs in, off by default), then the published page. The answer says
  which, because only the first two are this commit.
- **`publishSourcePage` writes the file, not the page.** Committing rendered
  HTML would put a file in the repository that the next build overwrites, beside
  a source file still saying the old thing.
- **`applyHtmlEditsAsJsx` is the bridge**, and it refuses rather than
  approximates: an edit with nowhere to go — a style, a moved section, a heading
  built by code — fails the whole publish naming the part. A publish that wrote
  the three changes it understood and dropped the fourth would be a page that is
  half of what somebody approved, reported as success. Markup cannot cross
  either: a literal is plain text, so bolding half a heading is a code change.
- **Unwritable fields are read-only in the editor, not at the publish.**
  `sourceManagedFields` marks them, the preview leaves them unmarked so they
  cannot be clicked, and each carries a sentence saying where it does come from.
- **`mapJsxFieldsToHtml` carries the source span** with every mapping and takes
  `requireMarker`, so a generator that names its literals makes the mapping exact
  instead of best-effort. `demoBuilder.ts` now emits markers; `docs/website-ai-markers.md`
  is the instruction a customer pastes into Lovable or Bolt.
- **Both caches are dropped on a source publish** — the file and the render.
- **A source publish shows its own state.** "Waiting for the host to rebuild" is
  true of a static host and useless for a build that takes minutes and can fail
  on its own terms, so those jobs say "Committed — waiting for the build and
  deploy" and their failure names the build.
- **A page with no built copy anywhere** answers 409 and the editor offers the
  source screen, which needs no HTML at all.

## Formatting words, the selection outline, and the agent's schema (10 Oct 2026)

- **Bold, italic, underline and strikethrough are toggles** (`applyTextFormat`
  in `client/src/lib/websiteTextSelection.ts`). They used to be `set`, so bold
  could never come off, and "clear formatting" wrote `font-weight: normal` over
  the words instead of removing anything, so colour and highlight could never be
  cleared. A toggle is judged by **computed style** over the words, so a heading
  that is bold from its own CSS shows Bold pressed and pressing it writes
  `font-weight: 400`; pressing again removes that override rather than stacking
  700 on it. Removing formatting from part of a styled span splits the span
  (`isolate`) so the neighbouring words keep theirs. `checks/browser/textFormatting.mjs`
  covers the round trips.
- **One selection outline at a time.** The frame's picker script and the editor
  both write `data-dw-selected` — the script on a click, the editor directly for
  Select parent and Layers. Each used to clear only the one it knew about, so
  Select parent followed by a click elsewhere left two outlines, and clearing the
  selection removed one. Both now clear every mark. Escape inside the frame also
  clears, because after a click on the page the keyboard is in the frame.
- **The Delete key never acts behind a window.** `keyboardDelete` refuses while
  anything is being typed into, in List mode, while the editor is read-only or
  busy, and while a dialog is open — judged by markup (`role="dialog"`,
  `aria-modal`) *and* by the editor's own overlay state, because Find & replace
  was a full-screen overlay with neither, and Delete with focus on one of its
  buttons removed the selected block behind it, out of sight. Every editor
  overlay is a labelled `aria-modal` dialog now (Find & replace and the save
  conflict were the two that were not). `checks/browser/layersAndDelete.mjs`.
- **The editor sets its own `::selection`** in the frame, translucent, so a page
  with a faint selection colour still shows what is selected and a highlight
  just applied shows through it.
- **The agent's model schema is written by hand** (`AI_PLAN_JSON_SCHEMA` in
  `websiteBuilderAgent.ts`). `zodToJsonSchema(…, { target: "openAi" })` rendered
  `.optional()` as `anyOf [{ not: { $ref: OpenAiAnyType } }]` over a recursive
  definition, which structured outputs do not compile, and the planner's catch
  turned every failure into an "escalation report to the business owner". A
  failure is now said as one, logged as `[website agent] the planner failed`, and
  never filed on the person's behalf; the chat offers **Request developer help**
  under any answer that changed nothing. `checks/websiteAgentSchema.ts` keeps the
  schema closed, fully required and free of `not`, `$ref`, `default` and `anyOf`.
- **The person-facing wording is "developer help", never "report to owner".**
- **A GitHub 403 on publish names the credential and quotes GitHub.** The shared
  token (Settings → Developer) needs **Contents: read and write**, and the
  Settings screen used to ask for read only. An app installation is named as the
  app. `GitHubError.via` carries which one GitHub refused.
- **The builder agent runs on the OS agents' models** (`agentChain` on
  `callModel`). The free rungs are NVIDIA's `agent` ladder, then Claude, ChatGPT
  and Gemini, whichever have a key, each at the model for the request's level
  (`builderTaskLevel`: standard, or complex for a whole-site change, an
  attachment or a long brief). It used to answer from the "web pages" job, so
  changing an agent model in Settings changed nothing in the editor.
  `checks/websiteAgentChain.ts` proves the order against stub vendors.
- **The selected element is always shown to the model**, first, and the page
  list goes to 220 fields. It was the first 80, so selecting anything lower on a
  long page and saying "make this bold" asked about an element the model never
  saw. A plan whose changes could not be applied now says why instead of
  showing the model's "Done", and every plan logs one `[website agent]` line:
  model, level, proposed, applied, and what was dropped.

## Deleting, moving and the floating Layers panel (12 Oct 2026)

- **Almost nothing is locked.** `standingOf` in `structure.ts` used to be one
  sentence that refused three different things alike: a form or embed, anything
  inside one, and any block holding one or carrying an inline `on…` handler.
  On a page an AI built that is most of the page — one `onclick` on a button
  marked its section, and every section above it, "interactive" — so a contact
  section could be neither moved nor removed, and the person editing was told
  to change it in the source editor. Now only the skeleton (`html`, `head`,
  `body`) and a field with no element of its own are locked. Everything else
  moves among its siblings and can be deleted.
- **A delete that takes something with it is asked, not refused.** The control
  carries `forceRemove` and `removeWarning` — the server's own sentence naming
  what goes (a form, an embed, a video, scripts) — and the editor shows it in
  the question. The request must carry `force: true`; a bare remove is answered
  with the warning, so the assistant, the agent and a stale screen cannot
  delete a form by accident. **`remove` still means "without asking"**, which
  is what those three read before proposing a deletion, and `move` is the new
  flag the Layers drag and the move guard read.
- **A copy is the one thing still held back** for those blocks: a second form
  posts twice and a second script runs twice. Why is on the Duplicate button;
  the strip under the structure buttons says only what cannot be done at all.
- **A missing closing tag is a deletion that has to find its own end.** The
  reader in `parse.ts` does not apply HTML's implied end tags: `<li>A<li>B`
  nests B inside A, and A is still the field. Removing A's span would take the
  rest of the list. `removalEnd` stops at the first child that would have
  closed it (`IMPLIED_END`). Such an element is deleted after a question and is
  never moved or copied — its bytes cannot be lifted.
- **A link the editor wrapped round an element goes with the element.** The
  `<a data-dw-link>` is not a field, so deleting the picture inside it left an
  empty link on the published page: nothing to see, still a stop for a
  keyboard. Moving or duplicating a wrapped element is still wrong in the same
  way and is open.
- **The floating Layers window is drawn inside `.website-editor`.** It was
  portalled to `document.body`, and every colour it has is a variable declared
  on `.website-editor`. Out of reach, its background resolved to nothing and
  the window came loose see-through. The rules now carry fallbacks as well, so
  it is a solid panel wherever it is drawn.
- **Carried back over its drawer and let go, it docks.** The drawer keeps a
  slot while the panel floats (`.dx-layers-home`, with a Dock it here button),
  and the promise to dock is drawn as a ring round the drawer and round the
  window, because the window covers most of the slot while it is over it. A
  drag that never leaves the drawer is not a float.
- **Two rows above the Style panels were taken out**: the line naming the
  screen size being edited with the element's measured size, and the Saved
  style menu when there is nothing saved to choose. The menu still appears for
  an element that has an approved style.

`checks/websiteStructure.ts` holds the server half and
`checks/browser/layersAndDelete.mjs` the rest. The second reads the window's
**computed** background in both themes and compares it with the drawer's;
portalling back to `body` fails it.

## The inspector: General · Style · Interactions (11 Oct 2026)

The reference — every element, every control, where each value is stored — is
[server/docs/website-inspector.md](../../server/docs/website-inspector.md). What
is here is why it is built this way, and what cost time.

- **The same three tabs for every element, and Style is no longer tailored.**
  A container used to get a fourth tab (Layout), and the Style panel was drawn
  from what the element was, so a heading was never offered an image fit. Dan
  asked for the model of Elementor's V4 panel, which customers already know: one
  Style tab that is identical everywhere, where a control that does not apply
  simply has no effect and type set on a block is inherited by the words in it.
  That reverses the "contextual inspector" this file used to describe, on
  purpose. What still depends on the element is only what has to: the flex
  controls once it *is* a flex container, a Flex child group once its parent is
  one, offsets once it is positioned. The one per-element part is General →
  Content. `lib/elementInspector.ts` kept only the facts and the measured
  property list; the ownership model went with the panel it described.
- **Settings that are markup are a structure change, not a field value.** Tag,
  ID, attributes and a video's playback go to `POST /pages/:id/structure` as
  `{ kind: "settings", settings: { tag?, attributes? } }` and are written by
  `applyElementSettings` in `structure.ts`. The reason is the field ids: they
  are positional, and turning a top-level `<div>` into a `<section>` makes it a
  section of its own and renumbers every field after it. `identifyFields` pins
  each field to its element first, which is exactly what it exists for
  (`checks/websiteElementSettings.ts` proves four ids would move without it).
  The costs follow from that and are deliberate: a box saves when it is left
  rather than on each keystroke, every change reloads the preview, undo is the
  structure undo, and none of it is offered on a framework page (no structure
  there) or inside a linked shared element (a page-local tag change would make
  the copies drift; the lock is in the panel, as it is for moves).
- **The allowlist is the security boundary** — `shared/websiteElementSettings.ts`,
  used by the panel to say why and by the server to refuse again. Never
  reachable: script (`on*`, and `data-` names libraries run as code, such as
  `data-hx-*`), addresses (`href`, `src`, `action`…, which the link, picture and
  video controls validate), the design system (`class`) and the editor's own
  marks (`data-dw-*`). Values may not hold `<`, `>`, a backtick or a script
  address anywhere; a `data-` value may not hold brackets or semicolons. A tag
  moves only within its family, and `main` is never a target. This is narrower
  than a builder that owns its runtime, because here an invited editor must not
  be able to run script on the site's visitors.
- **A video's settings are attributes through the same door.** `<video>` is
  still kind `unsupported`, and settings answer to their own rule
  (`settingsReason`) rather than to the one that decides whether a block may
  move or go, so its typed controls work. The address
  may sit on one `<source>` child and is written there; several sources are a
  file per browser and are refused. Autoplay is sent with `muted`, because a
  browser will not start an unmuted video on its own and a switch that does
  nothing reads as broken.
- **A video's file can be uploaded, and a missing one is named (15 Oct 2026).**
  A demo imported as one HTML file played `nevermind-venue-tour.mp4` from beside
  it: the file never reached the server, the editor's preview and the demo link
  both answered 404 on every load, nothing said why, and no screen could upload
  a video — the library held pictures, and the panel's advice ("put the file
  where the site keeps its media") has no answer for a demo or a hosted site.
  Now `POST /sites/:id/assets` takes MP4 and WebM, judged by `sniffVideo` from
  the bytes (`.mov` and `.mkv` refused with the reason: they upload fine and then
  never play), stored like a picture (`assets/dw/<uuid>`, R2 when configured,
  which also serves byte ranges), within the plan's single-file size; **Upload
  video** sits under Video file. The panel watches the canvas player
  (`networkState === 3` or `error`, with a capture listener because a `<source>`
  child's error does not bubble) and names the file it cannot load. Demo import
  lists the files a page names locally (`localFilesNamed`) in its notes, which
  the import screen now shows. In the library a video is a video tile and never
  fills a picture's place. On the canvas the picker swallowed every click, so a
  player could not be started at all; a selected player with `controls` now
  keeps its clicks. `checks/websiteVideoFiles.ts`, `checks/browser/videoUpload.mjs`.
- **On the real demo none of that was reachable (20 Oct 2026).** Its player sat
  alone in a frame `<div>` with the usual fallback words ("Your browser does not
  support HTML video."), and words made `isField` read the `<div>` as a
  paragraph, so the `<video>` was never a field: a click selected the frame and
  no video panel ever opened. Players and embeds now make their parent descend,
  as an `<img>` always did (`PLAYERS` in `regions.ts`). Behind it, the page was
  4.6 MB with its pictures inlined, and the 3 MB guard in `changeStructure`
  refused *any* action that grew it — measured against the unpinned page, so a
  move or a new video address counted as growth. It now applies to Duplicate
  only, which is what its message always said. The browser check uses the
  framed shape; `checks/websiteVideoFiles.ts` covers both.
- **Videos up to 1 GB, on every plan (Dan, 20 Oct 2026).** Pictures keep each
  plan's own single-file limit and storage totals are unchanged, so a big video
  still has to fit the plan's storage. Up to 10 MB a video goes the old way
  (base64 in JSON, works without R2). Past that the editor sends 8 MB pieces to
  `POST /sites/:id/video-uploads/part`, and the server relays each into an R2
  multipart upload (`websiteVideoUpload.ts`). Relayed, not presigned, because a
  browser PUT to R2 needs CORS rules on the bucket — configuration outside the
  repo that would break uploads silently the day it drifted. An upload in flight
  is a signed ticket (site, size, name, who, expiry; key and upload id once the
  first piece has been sniffed), so there is no table for it. Complete trusts
  `ListParts`, not the browser, and re-checks storage. An abandoned upload
  leaves unjoined parts in R2 until a lifecycle rule clears them; none is set.
- **A structure refusal is a 409.** `StructureError` extends `WebsiteError(409)`,
  so a refused setting ("Use an https address…") reads in the HTTP log exactly
  like a revision race. Read the message on screen before chasing revisions.
- **Every settings change is an edit on the plan, so a video's switches are
  sent together.** The structure route counts one edit against the monthly
  allowance (30 on the entry plan) and shares a 20-a-minute limit with publish.
  Eight switches sent one at a time would be eight edits and eight reloads for
  what somebody thinks of as setting up one video, so `MediaSettings` gathers
  them and sends one change on Apply. Tag, ID and each attribute are single,
  deliberate actions and are sent as they are made.
- **A number is written as it is typed; anything else when the box is left**
  (`useTyped`). The first version wrote every keystroke, so `width: 1.` and
  `margin-top: au` went into the draft on the way to `1.5` and `auto`, were
  pushed to the frame, and would have been autosaved if the timer fired
  mid-word. The box shows what is being typed while it has the caret and what
  the element really has once it does not.
- **A removal and an insertion at one offset: the removal goes first.** Taking
  away the first attribute while adding another just past the tag name gave two
  splices starting at the same place; applied the other way round, the removal
  cut into the text just inserted. `splice` sorts by start, then by end.
- **`withoutAnchors` dropped a pending icon change** whenever anything on the
  page was moved, duplicated or removed: values are folded into the document
  and only the document is kept, and `icon` was not in the list that is folded.
  Found while adding settings to that path.
- **The Style tab reads through one context** (`StyleCtx` in
  `StyleControls.tsx`): what this draft sets at this screen size, what the
  page's own HTML says, what a wider screen hands down, and what the browser
  rendered — the last shown as the placeholder. The dot beside a label says
  which: filled is changed here (press it to put back what the page had), grey
  is the page's own inline style, a ring is handed down. **Looking writes
  nothing**, and `checks/browser/inspector.mjs` counts the writes.
- **List values are rows, and "cannot read this" is an answer.** Shadows,
  transforms, filters, transitions, background layers and gradients are taken
  apart in `lib/websiteStyleValues.ts`. Every reader returns `null` for what it
  cannot express, and the panel then shows the value as written with a Clear,
  never a near miss: a developer's `matrix()` rewritten as the closest rows is a
  different design. The first version read `background: element(#x)` as a
  colour called `element(#x)`; only something that is certainly a colour is one
  now.
- **Every value the panel writes must survive `safeStyle` unchanged, and that
  is a check** (`checks/websiteInspector.ts`). It is the seam where a panel
  looks right and the page is wrong, because the frame is pushed the raw value
  and the server stores the filtered one. It caught a real one before it
  shipped: `validFramingDeclaration` only knew a single position, so a
  two-layer background's `background-position: 0% 0%, center center` was
  dropped on save without a word. It is validated per layer now. The same seam
  is why list-valued properties and the editor's `--dw-*` numbers get 400
  characters where everything else gets 120 (`LIST_VALUED`): three shadows do
  not fit in 120. And why the frame is asked for `border-style` — the Border
  type control showed a blank for a border the site really draws.
- **A tablet or phone rule carries less than an inline style**
  (`safeResponsiveStyle`): no `-webkit-` property, no custom property, no
  `url()`. So text stroke, Clipping → Text and picture layers are offered on
  Desktop only (`allowedAt`), rather than accepted and refused at save. A
  colour or gradient layer added on a smaller screen *replaces* the desktop
  layers there — that is what a `background-image` override is — and the panel
  says so.
- **What a text element's typography reaches inside it (15 Oct 2026).** A font
  size, line height, letter or word spacing set on a *text element* — one whose
  children are all phrasing content (`isTextElement`): a heading with a span, a
  button with an icon — reaches every word inside it, from the widest screen
  that sets it, on every screen alike. That is what Dan's "font size does
  nothing on tablet and phone" was: AI-builder pages size headings through an
  inner `<span class="text-4xl">`, whose class beats inheritance. The rule is
  `:where([token]) :not(sub, sup, [style*="font-size"]){font-size: inherit !important}`,
  specificity (0,1,0): it beats the span's class, never a field's own rule
  (0,3,0), and skips a word with its own inline value. A Desktop size needs a
  token for that, so `applyValues` gives a text element one when its Desktop
  metrics change; the rules are regenerated from the inline style.
  **Nothing else reaches.** Three fixes on 14–15 Oct had pushed all eleven text
  properties onto `*` on tablet and phone only: a paragraph's weight un-bolded
  its bold words, its colour recoloured its links, "None" removed their
  underline, and a *section's* size flattened its heading to paragraph size and
  could beat the heading's own setting by stylesheet order. Desktop never did
  any of it. Containers reach nothing — normal inheritance only. On a framework
  page the children are not read, so `TEXT_TAGS` decides, and only from Tablet
  or Phone (a Desktop size there is written into the block's own style).
  `checks/websiteResponsive.ts` holds it, and fails on the 14 Oct generator.
- **The traps that let those three fixes ship green.** Their browser checks used
  a hand-written preview with no CSP, no server, no published page; and the
  inline-style "cascade" they added (`applyEffectiveWithCascade`,
  `syncAllResponsiveStylesToIframe`) never ran in the editor at all, because
  `el instanceof HTMLElement` is false for an element from the iframe's realm.
  Both are gone. Test a property through the server's own `readPage` /
  `applyValues` / `previewDocument` and measure the published page, not the
  fixture. And `change()` now writes `latestEdits` before it pushes, because the
  preview sheet is built from a field's style and overrides together and a
  visibility change sends both at once.
- **A site's own `!important` beats a Desktop change.** Desktop is an inline
  style without `!important`, so `.nav-cta{font-size:15px!important}` on
  dakyx.com wins on the canvas and live, while a Tablet or Phone override
  (`!important`, (0,3,0)) wins over it. Known and not yet decided: making
  Desktop win means mirroring Desktop declarations into the generated
  stylesheet for every edited element.
- **Custom CSS is the declarations no control owns.** One inline style holds
  everything, so the box shows what is left over (a `text-shadow`, a `cursor`)
  and refuses, with the reason, anything a control owns, anything `--dw-*`, and
  anything the server would drop. Designer controls only.
- **Display conditions are `display` per screen size and nothing else**
  (`setPickedVisibility`). It touches `display` only where visibility needs it:
  a tablet `display: flex` somebody set for layout survives unless it would
  show the element where it should be hidden. Showing something again on a
  smaller screen than it is hidden on needs its real display — a flex row put
  back as `block` is a different layout — so the frame's value is remembered
  whenever the element is visible (`naturalDisplays`), and switching Desktop
  back on restores the page's own `display` rather than deleting it.
- **Interactions are five slots and one animation list.** `enter` (page load,
  or scroll into view), `loop`, `scroll`, `onhover`, `onclick`, each a layer of
  one `animation-*` list. Separate rules cannot do this: the cascade lets one
  `animation` erase another's, and an animation removed and put back starts
  again. Hover and click only switch a `--dw-…-live` property on, so an
  entrance carries on while the pointer arrives — `checks/browser/motionRules.mjs`
  reads the animation's clock across a hover to prove it. `--dw-enter`,
  `--dw-loop` and `--dw-scroll` predate the layers and are on published pages;
  every value they could hold reads back as an interaction (`dw-enter-up` is a
  fade from the bottom) and animates as before. An old scroll fade keeps its own
  keyframe until somebody chooses another effect, so opening an element never
  rewrites it.
- **An element that only animates on hover or click is left exactly as the site
  made it the rest of the time.** The at-rest rule matches only elements with
  an entrance, loop or scroll effect. For somebody who asked for reduced motion
  the hover and click layers do not exist (`prefers-reduced-motion:
  no-preference` around them) rather than being forced to `animation: none`,
  which would also stop a spinner the site animates itself.
- **A per-screen switch overrides the property.** `--dw-onhover-no-m: 1` plus a
  media rule setting `--dw-onhover: none !important`. An important declaration
  in a stylesheet beats a normal inline one, which is the only way a rule can
  win over a `style` attribute.
- **A custom effect is still one of a fixed set**: `dw-fx-custom-<slot>` are
  fixed keyframes over numbers the element carries (`--dw-<slot>-o0`, `-t0`…).
  Both states always write the same list of transform functions, so each one
  interpolates on its own instead of collapsing into a matrix that loses a full
  turn.
- **A click cannot replay an animation, and the panel says so.** With no script
  on the page the only hooks are `:active` (while pressed) and `:focus` (links
  and buttons, until focus moves). Likewise scroll into view is scrubbed by the
  scroll where the browser can, not "played once when seen".
- **The panel adds the preview rules to the frame if they are missing**, as the
  Hover view does, so Play works on a frame the server did not prepare. Play on
  hover and click marks the element `data-dw-play`, which only the preview's
  copy of the rules knows; the published copy never mentions it.
- **A control that needs a picture asks for one**: `pickImage(apply)` opens the
  media library and hands the address to whoever asked (a background layer, a
  poster) instead of to the selected element's `src`.
- **The link moved to Settings, and took WhatsApp with it.** The old
  Interactions tab held "when clicked: WhatsApp / call / email". Destination is
  Settings → Link for everything now; `Destination` grew a WhatsApp chip that
  tidies a typed number to the digits a `wa.me` address needs.

Checks: `websiteElementSettings` (server half of Settings), `websiteInspector`
(the pure rules and the seams to the server), `websiteInteractions`,
`websitePropertyAudit` (the inventory, and one set of tabs), and in a browser
`inspector.mjs`, `inspectorTabs.mjs`, `motionRules.mjs`, `stylePanel.mjs`.

Three things that cost time writing them:

- **`count()` does not wait.** A section draws its controls only once open, so
  counting straight after clicking its summary reads zero. Wait for a child.
- **Playwright will not hover something that never stops moving.** Its
  `hover()` waits for the element to be stable, and one fixture spins for ever
  on purpose. Move the mouse to the element's centre instead.
- **A heredoc eats backslashes here, and a `\n` pattern matches nothing on a
  CRLF file.** Write a patch script with the Write tool, read the file as LF,
  and write it back with the endings it had.

### Hover tips (17 Oct 2026)

Dan asked what the "B · O · W · None" chips under *Button style* meant. They are
the suffixes of the site's own classes (`btn-b`, `btn-o`, `btn-w`, via
`variantLabel`), so the label is only as clear as whoever wrote the stylesheet.
He asked for hover explanations on things like that, everywhere.

`components/EditorTips.tsx` is one tooltip for the whole editor, mounted once in
`WebsiteEditor`. Controls do not import it. A control gets a tip from:

- **`data-tip`** (plus `data-tip-heading`) written by the component. Wins.
- **The glossary**, `lib/editorTips.ts`, keyed by the words on screen: a
  `label`, `.dx-lt` or `.dx-row-l` by its text, and a button in a labelled
  group by `Group/Option` (`Display/In-blk`). Add a line there to explain a new
  label. The control does not need to change.
- **Any `title` already in the editor**, moved onto `data-tip` so every hint looks
  the same. A title that only repeats the visible words stays a title, because it
  is there for truncation. A button that was named only by its title is given
  that name as `aria-label` first.

A `MutationObserver` on the editor root re-annotates as panels open.

Button-style chips carry `data-tip-field` / `data-tip-variant`. On hover the
button is cloned *in the preview*, given that class, measured with
`getComputedStyle`, and removed. The tip draws a sample on the backdrop colour
the button really sits on, with a summary ("Outline, no fill · 2px #1A4FFF
border"). This was chosen over guessing that "o" means outline: the
measurement cannot be wrong. A preview on another origin gives no sample, and
the words still show.

Two traps:

- **The bubble is portalled to `document.body`.** Rendered inside the editor
  root, it was drawn *under* the inspector, which has its own stacking layer.
  `editorTips.mjs` asserts nothing covers it, and `elementFromPoint` needs the
  tip's `pointer-events:none` switched off to make that test mean anything.
- **Moving `title` breaks `getByTitle`.** `stylePanel.mjs` clicked Italic and
  Underline by title. Find icon buttons by role and name, which the move keeps.

## Launch hardening (12 Oct 2026)

A launch audit, then fixes. What each rule is for, so nobody undoes it.

- **An agent's whole-page rewrite is signed and inspected, twice over.**
  `POST /sites/:id/agent/apply` used to take `documentHtmlUpdates[pageId].html`
  from the request body and store it as the page's whole-document draft — the
  one way round "`$document` is written only by the server", and an editor
  could stage a `<script>` under a harmless label for a publisher to send live.
  Each entry is now an HMAC (`signingKey()` in `lib/secrets.ts`, its own
  purpose string) over site, page, the person the plan was made for, the
  HTML's hash and the label; apply refuses a missing or altered one before any
  page is written. **Independently**, `services/website/activeContent.ts`
  refuses a rewrite that adds anything that runs which the page does not
  already have (a new or changed script, `on*`, a script address, `srcdoc`,
  frames, `base`, meta refresh) — because what a model writes can be steered
  by the words on the page it is reading. `introducedActiveContent` reads the
  page the way the browser parses it: a raw-text or RCDATA element
  (`<style>`, `<title>`, `<textarea>`, `<xmp>`, `<noscript>`, `<noembed>`,
  `<noframes>`, `<iframe>`), a comment (`<!-->`, `--!>` and all) and an SVG
  `<![CDATA[` end where the browser ends them, and the `<img onerror>` after
  that closer is read as markup. The earlier copy renamed the opaque tags so
  the parser *walked* their contents, on the theory that reading more can only
  be stricter — it is not, because a `<p title="</style><img onerror=…>">` then
  lets the quoted value swallow the real `</style>` and the live `<img>` after
  it. Inside `<svg>`/`<math>` those elements are not raw-text, so there they
  are still walked (the quote really does span, as in the DOM) — and *which*
  `<style>` is inside is decided by a stack of open foreign elements kept by
  the spec's foreign-content rules, not a counter. One counter missed every
  way out (13 Oct 2026): an integration point (`<foreignObject>`, `<desc>`,
  SVG `<title>`, MathML `<mi>`…`<mtext>`, `<annotation-xml
  encoding=text/html>`), a breakout start tag (`<p>`, `<img>`, `<font
  color>`…), `</p>`/`</br>`, and an HTML end tag closing what an unclosed
  `<svg>` sits in. The HTML around an `<svg>` is not modelled, so where it
  decides (a misnested end tag, table modes, out-of-order HTML inside a
  `<foreignObject>`) the page is **read both ways**: on the rewrite either
  reading's finding counts, while the page as it stands is credited only with
  what *every* reading finds — crediting its most let a handler lying inert in
  a `<style>` that only an impossible reading walked into pay for the same
  handler written live. The price is that an edit to a page whose readings
  disagree about a handler is refused naming it; an unchanged page is never
  refused (`before === after` is nothing introduced). Past 32 readings the rest
  of the page is refused as "markup this check cannot read safely" rather than
  guessed. **The check runs synchronously in the API on the customer's own
  source**, so the work is bounded too: foreign nesting (or HTML inside an
  integration point) past 128 deep, 64 decision points, 100,000 stack entries
  walked below the current node, or 4 million characters parsed across
  readings (a 1 MB page gets four readings, not 32) makes the **whole page**
  unreadable, so any change to it is refused. Not "from there on": the open
  foreign stack does not hold the HTML around it, and an unclosed `<svg>` 128
  deep followed by `</div><style><img onerror>` is inert inside a `<div>` and
  live without one — same stack, same words after it. What was open at a point
  is serialised once, for the one point that needs it: serialising it at
  every point made `<svg>` + `<g>`×8000 + `</x>`×8000 (56 KB) take 79 s or
  abort out of memory (13 Oct 2026). Tags are
  tokenized as a browser does (a quote opens a value only after `=`; `<svg.x>`
  is not an SVG; `</style\v>` does not close), `<style/>` opens raw text, and
  CDATA on an integration point is read both ways because Chromium and the
  spec disagree there. Proved against Chromium with 10,000 generated shapes:
  of the 5,541 that ran, the counter missed 1,074 and this misses none. Both
  client call sites send `documentHtmlUpdates` back whole, or the signatures
  cannot survive. `checks/websiteActiveContent.ts`.
- **A value written into an attribute is escaped for the quote the page
  used** — `inAttribute()` in `regions.ts`, for a meta field's words, a
  picture's address, a link, alt text, a style and a class. A page's
  description, social copy and keywords were written into `<meta content>`
  with only `&`, `<` and `>` escaped, so any EDITOR could save a description
  of `0;url=https://evil.example" http-equiv="refresh` and every visitor of
  the published page was sent away — while the preview, which strips refresh
  tags, looked normal. Pictures, links and alt text had the same gap on any
  imported page that quotes with `'`. Only the quote the page used is escaped
  (an apostrophe in a double-quoted description stays readable), a bare value
  is given quotes, and it is done where the span is written rather than when
  the draft is saved, so drafts saved before the fix are covered. **And** the
  publish guard blocks a refresh, security-policy or cookie meta, or a
  `<base>`, that the source page did not already have (`noNewPageControls`).
  `checks/websiteAttributeFields.ts`, which fails 16 ways on the old code.
- **Text that ends up inside `<script type="application/ld+json">` is escaped
  for the script, not just for JSON** (`<`, `>`, `&`, U+2028/9). Every SEO
  replacement that carries somebody's words is a function, because a string
  replacement expands `` $` `` and `$'` into pieces of the page.
- **One rule for script-ish `data-` names** — `isScriptDataAttribute` in
  `shared/websiteElementSettings.ts`, used by the Settings panel and by
  `sanitize.ts` alike. `data-bind` and `data-hx-*` run code on Knockout and
  htmx sites; so do `data-script` (_hyperscript's alias of `_`) and Datastar's
  set (`data-text`, `data-show`, `data-effect`, `data-computed`, `data-attr`,
  `data-signals`, `data-class`, `data-indicator`, `data-init` and the
  `data-on-*` family). The rule anchors the ambiguous names to the whole word
  or a dashed suffix, so `data-attribution`, `data-classname` and `data-target`
  (the count-up figures) all still survive. The rest is old Bootstrap, handled
  in `sanitize.ts` because the value is what is dangerous, not the name:
  `data-template`/`data-content` are dropped when `data-html` is on the
  element (both are rendered as HTML then), and a `data-target`/`data-parent`/
  `data-container` whose **decoded** value holds `<` is dropped, because jQuery
  builds and runs a selector that starts with one — `&lt;img…` reaches the
  browser as `<img…`. A `data-target` holding a number or a plain selector
  (`#section`) keeps working.
- **A hosted picture whose bytes moved to R2 is a 302 to R2**, never a 404.
  `scripts/migrate-images-to-r2.mjs` sets `SiteAsset.content` to NULL after
  uploading, and the hosting route used to answer 404 for a NULL column.
  Authorisation still comes first: a site serves only a file one of its own
  LIVE pages references, read from a per-site path set extracted in Postgres.
  **The set is held in process and checked on every request against a version
  of the LIVE pages** — their ids and the trigger-written `publishedEtag`,
  never the HTML — and is extracted together with its version in one
  statement. It used to sit in the response cache; with that cache off (the
  default) every picture re-extracted the whole site through the fallback
  gate, which refuses once twenty reads are running, so a page with forty
  pictures got about half of them as 503. Do not put it behind a timer
  instead: checked, it is exact both ways — a picture published a moment ago
  is served at once, one removed is refused at once, and a refusal is never
  kept. Host lookups are shared while in flight (`sharedLookup`) for the same
  reason and keep nothing afterwards. Upload paths are always a fresh
  `assets/dw/<uuid>.<ext>` and are cached immutable; package-import paths
  keep their own names and still revalidate. `checks/websiteHostingLoad.ts`.
- **The R2 migration is a manual one-off, never a deploy step.** As Railway's
  `preDeployCommand` it ran on every deploy and copied every `StoredFile`
  (email attachments, prospect audit PDFs, lead screenshots) into the *public*
  bucket. Private documents must never be written to the public bucket; those
  phases are gone and `preDeployCommand` is `npm run db:deploy`. The script
  still moves only upload keys on repository sites — written before hosting
  had its R2 fallback, and conservative on purpose.
- **A custom domain is unique only once verified.** A claim is stored before
  anything is proved, so `@unique` let anybody type a business's domain and
  keep the real owner out for good. A hand-written partial unique index
  (`WHERE "customDomainVerifiedAt" IS NOT NULL` — Prisma cannot express it)
  enforces it; verifying clears every other unverified claim of the same
  domain in one transaction under a per-domain advisory lock (two proofs
  landing together deadlocked without it). The other spelling of a verified
  domain (`www.` or bare) is a 301 to it, and the DNS instructions say when a
  name is a zone apex, where a CNAME is not allowed. The certificate is still
  switched on by hand in Railway, and the panel says so.
- **Hosted sites answer `robots.txt`, `sitemap.xml` and `favicon.ico`** unless
  a LIVE page owns the path. The page cache key ignores the query string, so
  `?utm_source=` links stop missing it. An icon the home page names at another
  address of the same site — the other `www.`/bare spelling, its hosted host,
  its verified domain — is answered by its path (or 204), never redirected:
  sent to the other spelling, `/favicon.ico` came straight back through that
  spelling's 301, and the two looped until the browser gave up.
- **The visitor limit counts pages and pictures apart.** In memory, per host
  and client address: `WEBSITE_HOST_RATE_LIMIT` (300 a minute) for pages and
  everything else, ten times that for `/assets/dw/` pictures. One count for
  both made a forty-picture page cost forty-one requests, so a school or a
  mobile carrier's shared address was refused after about seven page views —
  with an empty body, which is a blank page; the 429 says so in words now. It
  protects the shared process, evicts old windows rather than refusing when
  full, and is never a database write per page view. **It keys on `req.ip`**,
  which is right only while `TRUSTED_PROXY_HOPS` matches the path a request
  took: read `server/deploy/CAPACITY.md` step 9 before any customer domain is
  proxied through Cloudflare.
- **Deleting a picture a live page uses is refused on a hosted site** — there
  is no repository copy; the row or the R2 object is the only one. For every
  site the R2 object is kept whenever something published may still point at
  it, because with R2 on, the editor writes the R2 address into the page
  itself — and the route's `ASSET_DELETED` event (`storedObject: "kept"`
  beside the `repoPath`) is then the only record of that key. **Erasing a
  site reads those events as well as its remaining rows**, before both
  cascade away, and removes its upload keys from R2, best effort: never a
  package path, never a key another site's library holds or another site's
  delete kept. A hosted site's all go. **A repository site keeps every upload
  its own pages mention** (published, source or draft, hidden pages too),
  because the customer's repository is still live and loads them from the
  bucket; each kept key is logged with the site, the repository and the pages
  (`mediaKept`) — the only record once the site is gone, for removing them by
  hand on request — and the erase dialog says so in one sentence. Which pages
  mention a key is found by the upload's uuid, each page read once in
  Postgres: a join testing every key against every page took 8–11 s on a
  60-page site with 400 uploads, this a quarter of a second.
  `checks/websiteDeletion.ts`.
- **No address is ever invented under dakyx.com, nor one the site is not
  served at.** Without `WEBSITE_HOST_DOMAIN` a hosted site gets
  `https://<label>.hosting.invalid` (a reserved name that never resolves) and
  screens say "No public address yet"; `adoptHostedAddresses` moves those to
  the real host domain at boot once it is set. **The label is
  `hostedLabelFor(slug)` everywhere** — `POST /sites`, the boot fix-up and
  `ensureHostedAddress` — because the first two used the whole slug while the
  label is cut to fifty characters, so a name over about 41 characters was
  promised a host that answered 404. When another site already holds the
  label the placeholder stands, and the first publish moves an address still
  made from the slug onto the label it really got. The fix-up also corrects a
  whole-slug address under the host domain, prefers a verified domain when it
  rewrites, and never moves an address the site is already served at.
  `checks/websiteHostedLabel.ts`.
- **An edit is a page changed on a UTC day.** Every autosave used to spend one
  of the plan's monthly edits. `writePageEdit` decides inside the conditional
  update itself, so two saves arriving together cannot both count; the
  allowance refuses only a change that would count. **The day is
  `SitePage.editCountedOn`, and only a counted edit writes it** — never
  `updatedAt`, which a rename, a discard, a publish or any other write moves:
  read from there, one of those at the limit made the page free for the rest
  of the day (`checks/websitePlanLimits.ts`). Nor `draftSavedAt`, which
  publishing, discarding and every shared-element save clear.
- **Changing a page's words goes through that one guard** —
  `assertEditAllowance` then `writePageEdit` (or `countPageEdit` when the words
  live on a shared element): the page save, a layout change, find & replace and
  the global-content sync (once for each page touched, all or nothing, each
  page written against the revision it was read at), restoring a version (an
  edit only when the page would read differently — emptying the draft is a
  discard), copying a field out of a version, inserting a section, saving a
  shared element (an edit of the page it was typed on), the five SEO tools that
  rewrite a page (`/seo/page`, `/seo/technical`, `/seo/conversion-bar`,
  `/seo/speed-optimize`, `/seo/brand-theme` — `writeToolEdit`; a run that
  leaves the page as it was spends nothing) and applying an agent plan.
  **`applyAgentSitePlan` works the whole plan out in memory and then writes
  each page once**, allowed for every page it changes and in one transaction
  against the revisions it read: it used to write as it went, so a page saved
  meanwhile left a plan half applied. **Whole means before it starts, too**:
  every page the plan touches (`pages`, `structuralActions`,
  `documentHtmlUpdates`) must still be at `pageRevisions[pageId]` (else its
  page plan's `draftRevision`; a layout action on a page neither names is
  refused, not assumed current), and any part that fails — a layout action
  naming an element that is gone, a rewrite that will not restore — refuses
  the plan with a 409 before anything is written or counted. A failed part
  used to be one line in a 200 with the rest written around it, and only a
  rewrite compared revisions, so field edits planned minutes earlier landed
  over a colleague's save. The editor's chat sends **its own** revision for
  the page open in it (an autosave while the assistant thinks is not somebody
  else's work) and awaits a layout change before sending the edits after it;
  a rewrite is always sent at the plan's revision, because it replaces the
  page. Paused for non-payment refuses all of
  them, and every publish too — the page and version publishes, the
  agent's batch publish, a source file's publish (in `websiteSource.ts`'s
  default `authorize`, before GitHub is read) and `/seo/page` with
  `publishNow`, whose allowance is asked before the commit — which with
  admission off had checked nothing. **`publishPageCommand` and
  `publishVersionCommand` ask it themselves**, because the scheduler and the
  work queue call them directly: a scheduled publish, and its timed revert,
  went live while paused. Scheduling (`POST /pages/:id/schedule`) is refused
  while paused, and a job that comes due then is marked FAILED with the
  reason, not left PENDING — a publish that goes out whenever the card clears
  is not the one anybody scheduled. Publishing on its own never counts. A
  route that writes a page's draft without it is free at the limit and open
  while paused — give a new one the guard. `checks/websiteEditGuard.ts`, which
  also proves each SEO tool and the agent answer a save that lands mid-request
  with a 409 that counts nothing.
- **On a website, the plan is the website's.** `resolveSiteEntitlement` finds
  the site's paying owner (`Site.clientId` → the client's live purchase → its
  account) and puts everybody on that website under that plan, with its edits,
  imports, AI runs (`WebsiteWorkJob.chargedUserId`, daily and monthly, refunds
  included) and storage (all of that client's websites) counted against the
  owner. Business sells fifteen team accounts, and each colleague used to be on
  Starter there — refused AI, refused at thirty edits, measured against 50 MB —
  while every colleague on a Starter website had thirty edits of their own.
  DakyX staff keep the whole product on a client's website (a fix the client
  asked for must not stop at the client's limit or a payment pause), and what
  they use there is **their own**, by the Owner's decision of 13 Oct 2026:
  staff's `chargedUserId` is the staff account. It was the client's, so thirty
  fixes a Starter client asked DakyX for spent the client's thirty edits and
  refused the client's own next save, and a Starter meter showed AI the plan
  has none of. Storage is still counted over the client's websites, because
  the files are theirs. A website with no paying owner is on the person's
  own plan, as before. It decides whose plan applies, never who may act: the
  membership still does, and a site the person cannot see is a 404, not its
  owner's plan. A colleague is told "this website's" plan, and is not shown the
  owner's purchase. `checks/websitePlanScope.ts`.
- **The daily AI allowance is the plan's** — Starter 0, Pro 10, Business 50
  (`AI_DAILY_LIMIT_EDITOR/_CARE/_MANAGED`); the legacy `AI_DAILY_USER_LIMIT`,
  when set, still caps every plan. Pro's and Business's labels read the same
  numbers the queue enforces; the public page states the defaults, and
  `deploy/CAPACITY.md` step 8 gives them.
- **dakyx.com is not a trusted origin.** It was on `TRUSTED_ORIGINS`, the one
  list behind the credentialed CORS grant *and* `refuseForeignWrites`, and the
  marketing site is edited with this very builder: script that landed there
  ran with the Owner's session. The marketing site sends no credentials and
  calls only public routes that set their own CORS. Never add it back
  (`checks/originGuard.ts`). `CLIENT_ORIGIN` is a comma-separated list.
- **The surface gate takes the narrowest surface any host header names**
  (app, then editor, then os), so a forged `X-Forwarded-Host` can only take
  access away; `req.hostname` is not used because Express fills it from that
  very header (`checks/appSurface.ts`).
- **A set-password token goes only to the checkout key**, the UUID the
  checkout page keeps in `sessionStorage` and never in a URL. A Paystack
  reference alone — which sits in browser history and receipts — learns paid
  or unpaid and nothing else (`checks/checkoutTokenScope.ts`).
- **Past due counts from `pastDueSince`, never from `updatedAt`.** With no
  paid-up date, the fortnight before editing pauses and the notice stage (the
  second from day 4, the third from day 14) run from when the subscription went
  past due. `paystackEvents.ts` sets it on the event that moves the row into
  PAST_DUE, keeps it on every later one and clears it on the one that moves it
  out. It ran from `updatedAt`, and that handler rewrites the row on every
  `subscription.*` and `invoice.*` event, so a further declined charge unlocked
  a customer locked for non-payment and every notice went out as the first. A
  paid-up date still comes first; a past-due row with neither date falls back
  to its last write, which is late but never early, and is how rows already
  past due were backfilled. **The notice quotes what the plan charges** —
  `monthlyPrice` until `billingPriceUpdatedAt` says Paystack was stepped up,
  `standardRecurringPrice` after, per year on an annual plan — in the
  purchase's currency from the stored amount, never `priceFor` at today's rate.
  `checks/websiteDunning.ts`.
- **Hosted forms are limited in the shared rate table** (site and address,
  eight in ten minutes), and a site emails its managers at most
  `WEBSITE_FORM_EMAILS_PER_DAY` (50) a day; past that, messages wait in the
  inbox and one last email says so.
- **A ZIP is judged by its declared sizes before anything inflates**, and each
  entry is held to its declared size while it does — one lying entry costs a
  16 KB block, not the process.
- **Errors go to Sentry, scrubbed, and only the accidents.**
  `src/instrument.ts` is the first import of `index.ts` and `worker.ts`; the
  client loads `lib/monitoring.ts` lazily on the production hosts only.
  `errorHandler` reports only what it renders as the generic 500 — never a
  `WebsiteError`, a validation refusal or any composed error class, whatever
  its status — because a refusal is the system working. Any `URIError` —
  Express's own for an undecodable parameter (`/review/%zz`), or a bare
  `decodeURIComponent` anywhere, which has no status — is answered 400 "That
  address is not valid." before the log line and never reported: it was a 500
  anyone could repeat to spend the quota, and its message is the raw
  parameter. The decoders a stranger reaches first answer before that:
  `readSessionCookie` treats a `dw_session` that does not decode as no
  session (it runs on every request, signed in or not), and the website ids
  in `/sites/%zz`, `/pages/%zz` and `/shared/%zz` are the gate's 404
  (`websitePathId`, also behind `websiteRequestSiteId`). Code that decodes
  something no request brought — a scraped page's `mailto:`, the
  `/demos/<slug>` in a site's stored `publicUrl` (`findLinkedDemo`, on every
  opening of a page: a slug that does not decode is no slug, and the brief
  finds the demo), a pasted Maps link's place name ("100% Dental" is kept as
  written) — catches its own, or its accident is answered as the visitor's.
  `checks/monitoring.ts`, `checks/websiteStoredDecode.ts`.
  Before anything leaves, cookies, bodies, auth headers, IP, frame
  variables, query values and Prisma's echoed arguments are removed (Prisma
  prints the call's values, which here means customer HTML and visitors'
  messages); tags, `extra` and `contexts` are scrubbed too, and a thrown
  plain object leaves its keys and none of its values. A token-shaped
  segment is masked even with percent-escapes attached (a link cut off
  mid-character). **The scrubbers run on the event loop over text a stranger
  chooses, so every pattern must stay linear** and every string is cut to
  4 KB first, back to a character that cannot be inside a token or an
  address; three patterns were quadratic and one cubic, and a 15 KB path
  parameter stalled the API for half a second per request. `maxValueLength`
  is 64 KB, not 4 KB, because Prisma's verdict follows the page HTML it
  prints. **No lookbehind in `lib/monitoring.ts`**: it is in the main bundle,
  and Safari before 16.4 cannot parse one, which would stop the app loading.
  The DSNs are committed on purpose — they only permit sending — and
  `SENTRY_DSN=off` stops it. The CSP's `connect-src` names exactly the ingest
  host. `checks/monitoring.ts`.

## Masks, audio, embeds, form words and nine more frameworks (21 Oct 2026)

From the editor audit in [server/docs/website-editor-audit.md](../../server/docs/website-editor-audit.md),
which is the list of what was found, what was fixed and what is still open.

- **A mask is two properties and no picture.** Style → Mask writes
  `clip-path` (a basic shape in percentages) and `mask-image` (a gradient from
  black to transparent), both from `shared/websiteMask.ts`, both unprefixed so
  they can change by screen size — a `-webkit-` property cannot be written at
  tablet or phone width at all. `mask-image: url(…)` is **not offered and is
  refused**: masks are fetched in CORS mode, and the library's files come from
  cloud storage on another origin with no CORS headers, so the element would
  vanish on every screen without a word. Reading follows the list-value rule:
  only exactly what a preset writes is that preset; a developer's own
  `polygon()` is shown as written. `clip-path` and `mask-image` joined
  `LIST_VALUED` (400 characters), because a polygon is a list of points.
  **Chromium serialises a computed fade differently from the declaration** —
  `transparent` comes back as `rgba(0, 0, 0, 0)` and the default `to bottom`
  disappears — so a browser assertion compares the computed form.
- **Audio is sniffed before video.** An `.m4a` is an MP4 box whose brand says
  audio, and `sniffVideo` calls every non-QuickTime MP4 a video. A bare MPEG
  frame header is eleven set bits — which a JPEG also starts with — so the
  version, layer, bitrate and sample-rate fields are checked too, and ADTS needs
  its whole 12-bit sync word. `playableMedia` in `websiteManagement.ts` is the
  one decision for both upload doors, and `want` (the player the file was
  chosen under) settles the in-between cases: a phone's voice memo in an
  ordinary MP4 box is audio under an audio player; an MP3 under a video player
  is refused; Ogg is refused everywhere because Safari never plays it. Audio
  rides the 1 GB video allowance (`assertMediaStorageAllowance(…, "audio")`),
  and the chunked ticket gained `m: "audio"` — absent still means video, so a
  ticket signed before this keeps working.
- **A stored file is served in pieces** (`lib/byteRange.ts`), on the hosted
  route and the editor's raw route. `res.send` ignores `Range`, and Safari plays
  nothing from a server that answers its first `bytes=0-1` with the whole file:
  every video under 10 MB stored without R2 was silent on iPhones before audio
  existed. Several ranges, another unit or a backwards range get the whole
  file (the rules allow it); only a start past the end is 416.
- **A frame can be pointed at another video or place — from a list.**
  `shared/websiteEmbed.ts` is the boundary: https, no credentials or port, a
  listed host, and on it the path the service embeds from. A link can already
  go anywhere, but a frame draws another site *inside* this one at the
  designer's size, which is a sign-in form wearing the customer's header. The
  server holds `src` on an `<iframe>` to that rule in `attributeProblem`, with
  its own length (2,048 — a Maps `pb=` address is routinely past 400); `srcdoc`
  is never reachable. The panel's converter takes what people actually paste —
  a watch page, `youtu.be?t=1m30s`, an unlisted Vimeo, the whole `<iframe>`
  code with its `&amp;`s — and a typed place becomes the keyless
  `maps.google.com/maps?q=…&output=embed`. A frame already pointing off the
  list keeps working and says so. The Add panel's media sections
  (`MEDIA_SECTION_TEMPLATES` in `websiteSeo.ts`) arrive **empty** — a frame
  with no address, a player with no file — rather than somebody else's video
  or a town picked for the customer.
- **Form words are fields, in a series of their own.** A `<select>` used to
  read as rich text whose value was its `<option>` markup, so a word typed
  into it deleted every option on the published page. Placeholders, a submit
  input's `value` and options are `formText` fields now — but field ids are
  positional, and giving them the next number would renumber every field after
  a form and make every draft written against those ids refuse to publish. So
  they are numbered `sN.form.M` and every positional id is `slot()`, the count
  of the fields that are not form words: the same number it was before they
  existed (`checks/websiteFormText.ts` proves it against the old ids). They
  are plain text, written into the attribute escaped for its quote like a
  meta description, pushed onto the attribute in the frame (a text area
  decodes the HTML text without running it), and never typeable on the canvas.
  **The same defect sat one level up**: a `<label>` wrapped round its control
  (`<label>Party size <select>…</select></label>`) was rich text holding the
  control, and the rich-text sanitiser keeps no form element. It keeps its slot
  now, as a plain field over its one run of words (`wordsAroundControl`); with
  words on both sides of the control it is left to the code and says why; and
  the picker never puts a caret in anything that holds a control.
- **Nine more frameworks, and two traps in them.** Angular (its `Routes` table,
  each component mapped to the `.html` template beside it), SolidStart,
  TanStack Start, Qwik City, Svelte with Vite, a Vue Router SPA, VitePress,
  MkDocs and Hexo. **Angular reads a bare `@` in text as the start of a block**
  from v17, so `encode` writes it as `&#64;` in Angular templates only — an
  email address typed into a heading must not fail the build, and a Vue file
  keeps the `@` as typed. **A `.ts` route file is parsed as TypeScript, not
  TSX**: as TSX, `<Routes>[…]` is an element. Hexo sits before Jekyll because
  both have a `_config.yml` and, read as Jekyll, a Hexo page was listed at
  `/source/…`. TanStack's `_layout.tsx` is a layout, not a page at `/`.
  VitePress pictures go to the `public/` beside its root — `docs/public` when
  the page is under `docs/`, `public` otherwise; a root anywhere else is in the
  compatibility notes rather than guessed.
- **A sitemap index is followed, and pages in folders are found.** dakyx.com's
  `sitemap.xml` is an index of `page-sitemap.xml` and `post-sitemap.xml`; it
  was read as two pages with those names, so every newly scanned page arrived
  hidden and a site with no repository got a page per sitemap file. And
  `htmlIn` reads one folder, so the nine posts in `blog/` were never pages.
  A nested `.html` is listed **only when the site's own sitemap names it**, and
  never from a tooling, hidden, partial or archive folder; one extra repository
  listing is made, and only when the sitemap names an address the folder's own
  files do not. A folder's `index.html` is `/team`, as a package import names
  it, but its preview resolves against `/team/` (`pageDocumentUrl`) — against
  `/team`, `photo.jpg` was `/photo.jpg`.

Checks: `websiteMasks`, `websiteAudio`, `websiteEmbeds`, `websiteFormText`,
additions to `websiteFrameworks`, `websiteRouterTable`, `websiteTemplate` and
`websiteDiscovery`, and `checks/browser/masksMediaForms.mjs` through the real
editor — a computed clip and mask on the canvas and the published page, a WAV
uploaded and playing, a frame refusing another site and showing YouTube, and a
placeholder edited live.
