# Website editor implementation

**The client-facing half of this document is public**, at
[dakyworld.com/website-builder](https://dakyworld.com/website-builder) and
[/website-builder-setup](https://dakyworld.com/website-builder-setup), with
[/products](https://dakyworld.com/products) as the shelf they sit on. Those pages
are a translation of this file and of `website-compatibility.md` into a client's
words. **A change here that affects how somebody uses the Builder is not finished
until those pages say the same thing** — particularly the four compatibility
grades and the publish-then-verify story, which clients quote back. The pages
live in the repository root: `products.html`, `website-builder.html`,
`website-builder-setup.html`.

The editor supports imported or repository-backed HTML pages, and a source workflow for framework pages — React/Next/Remix/Gatsby/Vite (`.jsx`, `.tsx`), Astro, Vue/Nuxt, Svelte/SvelteKit and Markdown content — covering both their words and their layout. It does not build or run a customer's project: a framework page is previewed as its live published page, and edits are traced back to literals in the source. There is no running React canvas, and a page that has never been deployed has fields but no picture.

## Available workflows

The visual sidebar includes a searchable Layers tree in document order, expand/collapse controls, changed/error filters, keyboard navigation and selection breadcrumbs. Filtering preserves ancestor context so nested elements remain understandable.

- **Sites:** connect a public address and optional GitHub repository, scan existing pages, or import HTML files (up to 2 MB). Additional pages can be imported into an existing site. JavaScript app shells without rendered content are refused with a source-editor explanation.
- **Visual editing:** select page content or parent containers; edit text, links, images, and design controls. The inspector is contextual: the sections drawn are derived from what the selected element is in the rendered page — its kind, tag, computed `display`, its parent's computed `display`, whether it has text of its own and whether it has children — so an image is never offered typography, flex controls appear only on a flex container, flex-child controls only inside one, and position offsets only once the element is positioned. Every CSS property has exactly one section that owns it; less common properties are under Advanced rather than removed. Layout controls cover flex/grid, dimensions, constraints, spacing, position, stacking, image fitting, gradients, typography, colours, borders and effects. CSS units and expressions are retained. Image replacements update the canvas immediately and discard the old `srcset` candidates.
- **The panel itself:** groups collapse, and open on their own when they are either what somebody came to change or already carrying a value the site set — a collapsed group carrying a change shows a dot rather than hiding it. Layout choices are drawn rather than named: display, flex direction, distribution and alignment are pictures of the arrangement they set, with the words kept as tooltips and accessible names, and anything with more choices than fit stays a menu. Padding and margin are arranged around a centre rather than listed as four numbers. Controls share one height and sit on the sunken surface, taking a border on focus. Sections and origin chips carry `data-section` and `data-origin` so a restyle cannot silently break the browser checks.

- **Effective values:** every control shows the value actually governing the element, read from the preview frame at the active viewport, with a word saying where it came from — the website's stylesheet, a `style` attribute in the page's HTML, or an override made here at desktop, tablet or phone width. An override can be reset to the website's value one property at a time. Opening an element writes nothing: computed values are displayed, never stored, so looking at a page cannot change it. A declaration identical to the one in the page's source is not reported as somebody's override, because a desktop draft carries the element's whole `style` attribute.
- **Responsive styling:** Desktop edits base styles; Tablet edits overrides at 1024px and below; Phone edits overrides at 640px and below. Phones inherit tablet values until explicitly overridden. The canvas uses 1280/820/390px viewports with zoom; changing widths preserves the frame and pending edits. Clear one property or all overrides to inherit again. The full device map travels through undo, draft recovery, conflict resolution, version restore, export and publish review. A shared browser/server sanitizer and renderer keep live and exported media rules consistent.
- **Shared elements:** one logical component with instances on several pages — a header, a call to action, a footer, or anything else repeated. Detection uses `data-dw-shared` annotations, exact subtree matches including the words (high confidence) and matching structure with different words (medium, offered as a question and never applied); page state such as `aria-current` and active-nav classes is normalised away, and a page's own `<main>` is never offered on structure alone. Any container can also be made shared by hand, which outranks detection. A shared change is stored once against the element, keyed by slot, and resolved onto each page's own field ids — so it shows on every linked page's editor and preview before it is published. The inspector states the scope before the controls that use it: all linked pages, or only this one, which detaches that copy first without changing what the page shows. A detached instance keeps everything it had, receives no further changes, and can be re-linked (taking the shared version). Publishing is all-or-nothing across the linked pages, in one commit, and refuses if any affected page moved since the review or if any page's copy has changed shape. A page publish never publishes a shared change; it says where to publish it instead.

- **Page structure:** drag Layers or use Move up/down to reorder editable siblings, duplicate static blocks, and remove elements. Copies can be edited independently before publishing. Actions save a revision-checked document checkpoint, retain prior content/style changes in review, and support server-side undo/redo. Persistent `data-dw-node` identities prevent positional edits from moving to another element. Clients cannot submit raw document checkpoints. Concurrent writes and full-source hash checks protect changes made by another editor or developer.
- **Drafts:** autosave with revision checks, conflict resolution, undo/redo, and per-user tab recovery for unsaved changes. Saving a draft does not publish. Failed saves retain local changes. Publish review binds the draft revision to the current source hash.
- **Assets:** upload PNG/JPEG/WebP/GIF images, choose them from a site library, include referenced images in the same repository commit, or embed them in downloaded HTML. Uploads and previews require site access. Replacing an image clears its old `srcset` so it cannot keep showing the previous picture.
- **Settings:** site details, colours, fonts, optional AI suggestions and brand voice. Fonts must already be loaded by the website. Only internal administrators with website management rights can change the repository connection associated with the OS's shared GitHub credentials.
- **Team:** assign existing accounts as viewer, editor, reviewer, publisher, developer or manager. External accounts only see assigned sites. Membership changes are audited; concurrent changes cannot remove the last active manager. Account creation/invitation remains with the OS account administrator.
- **Publishing:** review changes, commit to the configured branch, view versions, restore a version into a draft or publish a rollback. Rollback review shows content, links, base/device styling, button variants and tab targets that differ from the current source. Per-page database locks reject simultaneous publishes. The GitHub adapter compares expected content against the exact parent commit and never force-updates a branch. A newer draft saved during a publish is preserved.
- **AI:** an optional proposal panel scoped to one selected field or the page. Suggestions include the unsaved draft, pass the editor validator and existing budget checks, and require explicit application into the draft. The assistant never publishes. No paid model calls were made during implementation checks.
- **Source files:** browse `.jsx`, `.tsx`, `.astro`, `.vue`, `.svelte`, `.md`, `.mdx` and `.markdown` inside the site's configured repository folder, edit literal text, content-named component props and existing `href`/`src`/`alt` strings, review a byte-preserving change, download source, or publish with both source and publish permission. Full-file hashes reject stale edits. Dynamic values, class names and component internals remain code-controlled. Unsupported or ambiguous fields are explained. Source code is parsed, never executed.
- **Source styling and links:** each block carries the style written on the element in the file — text and background colour, text size and alignment, padding, space above, corner radius — edited with the HTML inspector's own controls and sanitised by the same `safeStyle`. A template gets a `style="…"` attribute; JSX gets a `style={{ … }}` object; clearing the last declaration removes the attribute. A native `<a>` can be set to open in a new tab, which always writes `rel="noopener noreferrer"` with it and removes both when switched back. A style or target the code computes — `style={styles.hero}`, `:style`, a spread, `target={t}` — is refused with its reason. Computed values from the site's own stylesheet are not shown, because the picture beside the panel is the customer's published page rather than a frame we control.
- **Source screen sizes and hover:** a block can be styled at tablet (1024px and below) and phone (640px and below) width, and given hover, focus and active colours. The answer stays in the page — `data-dw-responsive` holds the declarations, `data-dw-style` the token — and the media rules are regenerated into one fenced region per page inside a global stylesheet the project already loads (`app/globals.css`, `src/index.css` and the other usual paths are probed; none is ever created, and with none present the edit is refused and says what to add). Hover values are custom properties in the ordinary inline style, so they need only the fixed interaction block. Page and stylesheet travel in one commit, both guarded against the reviewed version. Screen-size styling is offered on native elements only, because a data attribute on a component reaches its props rather than the DOM.
- **Source layout:** move, copy and remove blocks of a framework page from the same panel. Every language the editor opens has a layout engine: JSX elements and components, `.astro`/`.vue`/`.svelte` markup, and Markdown sections (a heading with everything under it). Actions are queued in the browser, replayed server-side against the file on the branch, and bound into the same review hash as field edits; undo drops the last action. Blocks the page's code places — a `.map`, a condition, a `v-if`/`v-for` chain, a form, the outermost returned block — are refused by name. A duplicate loses its `data-dw-field` marker and gains its own `data-dw-style` key; blocks with fixed IDs, `<main>`, and Markdown sections are not duplicated, since their identities are link targets. Values are written before any block moves, so a field edit cannot land on the block that took another's place. Blocks created by a duplicate have no editable words until published.

## Which GitHub credential a site publishes with

Both work, per site. A site with a customer's own GitHub App installation borrows an hour-long token scoped to the repositories they chose; every other site uses the shared token exactly as before. The credential is ambient for the duration of one piece of work (`withGithubCredential`), so a nested read during a commit inherits it without every function growing a token parameter. `docs/github-app.md` is what to create on GitHub and what to put in Railway — until that exists nothing changes. `checks/githubApp.ts` covers it.

## What it costs, and who pays

A client on an **active** retainer gets every product at no charge; everyone else pays the product's own price. The rule is decided in one function — `decideAccess()` in `services/products.ts` — so the public page, the onboarding list and whoever is quoting cannot reach different conclusions. A paused retainer covers nothing.

Prices live in the `Product` table and are edited at `Products → Product pricing` (needs `website.manage`). dakyworld.com reads them from `GET /api/public/products`, which is unauthenticated and mounted above the session middleware, so **moving a price in the OS moves it on the website without a deploy**. The number in the site's markup is still real: it is what a crawler sees, what renders with JavaScript off, and what stands when the request fails — `assets/pricing.js` only replaces a number that has since moved, and fails silently.

That is the opposite direction from care plans, deliberately. A retainer's price is a published offer with a page of conditions around it, so the site owns it and the OS syncs (`carePlanCatalogue.ts`). A product's price is a single number on a card.

`Site.clientId` is what makes the question answerable at all; it is set on the site's settings screen, and the onboarding list says so when it is missing. `checks/products.ts` covers the rule with no database.

## Onboarding a website, and what a client sees

`Website → Onboarding` is the list somebody works down before a client is given a website: address, repository, a branch proved readable by actually reading a file from it, pages scanned, the compatibility report gone through, this site's own colours and fonts set so the editor stops offering Dakyworld's, shared elements linked, publishing confirmed, and the client's own access. Every line is **derived from the site rather than ticked**, so nothing can claim to be done after it has stopped being true — a branch that becomes unreadable goes back to blocked on its own. The last line is the handover conversation, which is the only thing on the page nothing can work out for itself, and it is recorded on the site's activity.

A customer does not get the operations menu with most of it missing. `client/src/lib/clientWorkspace.ts` holds what they are offered — Pages, Assets, Team, Activity — the header says "Dakyworld · Website" rather than "Dakyworld OS · Internal Operations", the builder's own second navigation strip is dropped because those four are already in the header, and they land on their pages. The permission boundary was already right; this is the surface catching up with it, and `checks/websiteClientWorkspace.ts` asserts that nothing a client is offered leaves the website product.

## Publishing, and knowing it worked

A commit is not a deployment. `PublishJob` records every publish from before it starts until the change has been seen on the live page: the row is written **before** GitHub is touched, so a process that dies mid-publish leaves a `COMMITTING` row the next boot asks GitHub about rather than a mystery — either the commit landed and the state is `RECONCILIATION_REQUIRED` with the sha on it, or nothing happened and it says so. After the commit the job carries the public address, a distinctive string the change put on the page and the file's hash; the scheduler looks at the live page on a backoff from twenty seconds out to five minutes, and settles on `COMPLETED` with how long the host took or `VERIFY_FAILED` with the page still showing the old version. The editor shows that line under the publish notice, so "published" stops meaning "committed". `services/websitePublishJobs.ts`; `checks/websitePublishVerify.ts` covers the deciding with no database, `checks/websitePublishJobs.ts` the rows and the clock with an isolated one.

## The site survey

`Website → Site survey` reads every page at once and says what the website is
made of, because that is the first question anybody asks about a site they did
not build. Four answers, each carrying its evidence:

- **Global elements.** The repeated regions from `sharedCandidates`, now *named*:
  header, footer, primary navigation, breadcrumbs, sidebar, call-to-action band,
  newsletter signup, cookie notice. The naming reads the page's own words for the
  block — landmark tags first, then `role`, `aria-label`, id and class, then
  position as a last resort — and a block it cannot name is still reported as a
  repeated block rather than dropped. A region on *every* page is told apart from
  one on merely more than one, because that is the difference between the site's
  furniture and a pattern.
- **What the site asks for.** Every link and button whose words and destination
  repeat across pages, counted by pages reached and by total appearances, with
  buttons told apart from links. This is how "the same CTA throughout" becomes a
  number rather than an impression.
- **Kinds of page.** Home, catalogue or listing, product, event, article, contact.
  Judged from what is on the page, not from its address — a catalogue is a page
  that repeats one *card* (something clickable carrying a picture or a heading)
  three or more times outside the site's own furniture. Three further rules keep
  that honest, each about a different way a run of similar blocks can fail to be
  a listing, and none of them about any particular website: the run must go to at
  least three *distinct* destinations (five prose sections all carrying the same
  "email us" link are a document); its typical item must be a teaser rather than
  an essay (or every long document with headings is a catalogue); and its
  destinations must not be mostly the site's own navigation, which the survey
  knows because it has already counted which links repeat across the whole site
  (a "where next" block of site links is navigation wherever it appears).
- **Colours and typography.** Every declared colour, normalised so `#FFF` and
  `#ffffff` are one colour, ordered by how much the site leans on it and tagged
  with what it is doing (text, background, border, shadow, graphics); and the
  first family of each font stack, with sizes and weights.
- **Design tokens.** The custom properties a stylesheet declares once and reuses
  (`--brand: #3157ff`). Where a site has these they *are* its design system, so
  they are reported with the value they hold and how often it is leaned on.

**It has to survive a real page.** The fixtures were a few hundred bytes and hid
two collapses, both found by running the survey over real public websites rather
than over its own test data. `sharedCandidates` asked its "is this block on
another page" question by scanning every block against every other block, each
comparison against a fingerprint of a whole subtree; and the survey re-read the
entire page for every question it asked about it. Two copies of one real news
page took over eight minutes, which in a request is not slow but broken. Both are
now worked out once — a map of fingerprints to pages, and one parse per page —
and the same two pages take about two seconds. `checks/websiteSurvey.ts` carries
a deliberately loose bound on three pages of four hundred cards, as a guard
against a regression of that shape rather than as a benchmark.

Sharing one parse per page also fixed a rule that had never fired: an unlabelled
first or last block is named header or footer by its position, and the check for
that compared the element against the page's outermost blocks by identity — with
the element from one parse and the blocks from another, always false. It failed
as a cautious-looking wrong answer ("nothing in it says what it is") rather than
as an error, which is why nothing noticed.

**A summary, not an inventory.** Real sites repeat a great deal inside their own
furniture — a logo, a search box, a row of section links, each repeating on every
page because the header does. Detection drops a block that sits inside another on
*every* page, but that is stricter than it sounds: a header found on two pages
does not swallow a piece of it found on three, and three pages of one news site
came back with forty regions of which two were the answer. The survey folds an
unnamed block into a region it is mostly inside. Only unnamed ones — a navigation
lives inside the header on most websites ever built, and reporting the header
while dropping its navigation loses the more useful of the two. Nothing is folded
in `sharedCandidates` itself, because the shared elements feature has its own
reason to offer a nested block: somebody may want to link just the call to action
inside the footer.

Position is treated as the weak evidence it is: an unlabelled block is named
header or footer only when it *is* the first or last block, not when it sits
inside one. Before that, one site's header produced sixteen regions all called
the header.

**Nothing in it calls a model.** Every answer is derived from the markup, so a
survey costs nothing, cannot invent a page, and reads the same twice.

The deciding is `services/website/survey.ts` and has no database or network in
it; `services/websiteSiteSurvey.ts` is the half that reads the pages, applies the
sixty-page limit and reports a page it could not read rather than failing the
whole survey. `checks/websiteSurvey.ts` covers the deciding against a four-page
fixture with no database.

**It reads the site's stylesheets, not just its pages.** Almost every website
keeps its design in a CSS file, and a palette read from the markup alone is a
palette of whatever somebody happened to inline — usually nothing. The same
rules that already governed `siteStyleClasses` govern this, in one shared place
(`linkedStylesheetHrefs`, `siteStylesheets`): same host only, because a font CDN
is not this site's design system and following arbitrary URLs out of somebody's
HTML is a door with no reason to open; the first few per page; from the
repository where one is connected and from the live site otherwise; cached
alongside the pages; and skipped quietly when unreachable, because a palette
missing one file is still a palette.

`var(--brand)` is resolved to the colour the token holds before counting. Without
that, a site that declares its palette once and refers to it by name everywhere —
which is how modern CSS is written — reports each colour exactly once, at its
declaration, and reads as almost colourless. On this repository's own seventeen
pages the difference was nine uses of the ink colour across three pages versus a
hundred and fifty-four across all seventeen.

What it still cannot see: a stylesheet on another host, and anything a script
computes at runtime. The screen says which of the two it managed — stylesheets
or only the pages — so a thin palette can be told from a plain one.

## Compatibility

`docs/website-compatibility.md` is the contract — exactly what is supported, what is supported with limits, what stays with a developer and what is not supported at all. `services/website/compatibility.ts` is the same judgement as code, applied to one website by `Website → Compatibility`: every page is read and graded, findings are merged and counted across the site, and the site gets a rating and a readiness state. Readiness is a separate question from grading, so a perfectly editable site with no repository connected reads as `PUBLISH_BLOCKED` rather than as a problem with its pages. Run the report before a client is given access to a website; every finding in it is written as a sentence somebody can act on.

## Preview and compatibility

Imported scripts, forms and embedded frames do not run in the editor. A CSP sandbox and nonce permit only the trusted picker; styles, fonts and images may render from the public site. This isolates the OS session, but JavaScript-driven menus, animations and client-rendered content will not behave like the live website. Test the live site after deployment.

Source annotations such as `data-dw-field="hero.title"` give HTML elements stable identity. Duplicate/reserved annotations fall back to discovered positions. Existing content IDs remain unchanged when container fields are added. Hidden and generated regions are excluded.

Public HTML/CSS fetching validates DNS, pins the chosen public address, revalidates redirects, and caps time and response size. Loopback fixtures work only when both `NODE_ENV=development` and `DEV_NO_AUTH=true`; production cannot fetch private/loopback servers.

Responsive controls store escaped `data-dw-responsive` JSON and a stable `data-dw-style` token on the selected element, plus one editor-owned media stylesheet. Rules use `!important` to override ordinary inline base styles. A developer's inline `!important` still wins; the inspector identifies that case. Existing higher-specificity important stylesheet rules may also win. Arbitrary custom breakpoints and responsive image-source groups are not implemented. Original site CSS remains in place.

Structure controls operate on static siblings within one actual HTML parent. Interactive/script/form subtrees and malformed unclosed elements remain source-controlled. Blocks containing fixed HTML IDs cannot be duplicated, since copying them can break selectors, labels and fragment links. Arbitrary reparenting, new block templates, a running React/Next/Vue canvas, project ZIP execution, scheduled publishing and website subscription billing remain unfinished. `<picture>` source groups and dynamic image components still require source changes. Downloaded HTML embeds uploaded images; it does not bundle the original site's external CSS/fonts/assets. Changing a site's public subfolder requires reviewing existing relative asset addresses.

Layout history stores at most 20 snapshots per direction, bounded to six megabytes per direction. A complete structural version can be restored as a draft for review; the review explicitly identifies whole-page restoration. If source files change underneath a layout checkpoint, inspection remains available but publishing/export and further structural actions are blocked until the draft is discarded or a saved version is restored against the latest source.

GitHub and PostgreSQL cannot share a transaction. A database outage after a successful GitHub commit can leave local history incomplete; inspect the repository commit before retrying. A durable publish-job/reconciliation system remains a production hardening task.

## Local validation

Migrations added:

- `20260908000200_website_memberships`
- `20260908120000_editor_imported_sources`
- `20260908130000_editor_assets_and_audit`
- `20260909000100_editor_asset_relations`

Apply with `npx prisma migrate deploy`, then `npx prisma generate`. TypeScript is now a runtime dependency because the JSX adapter uses its parser. Local checks use an isolated editor database. Production startup runs pending migrations through `npm start`; the Railway service uses `server/` as its root directory.

From `server/`, with an isolated `DATABASE_URL`:

```powershell
npx tsc -p tsconfig.json
npx tsc --noEmit -p tsconfig.checks.json
npm --prefix client run build
npx tsx checks/website.ts
npx tsx checks/websiteVisual.ts
npx tsx checks/websiteButtons.ts
npx tsx checks/websiteJsx.ts
npx tsx checks/websiteSource.ts
npx tsx checks/websiteAssistant.ts
npx tsx checks/websiteFetch.ts
npx tsx checks/websiteGitHub.ts
npx tsx checks/websiteLayers.ts
npx tsx checks/websiteInspector.ts
npx tsx checks/websiteShared.ts
npx tsx checks/websiteSharedApi.ts
npx tsx checks/websiteCompatibility.ts
npx tsx checks/websiteSurvey.ts
npx tsx checks/websitePublishVerify.ts
npx tsx checks/websiteClientWorkspace.ts
npx tsx checks/githubApp.ts
npx tsx checks/products.ts
npx tsx checks/websiteResponsive.ts
npx tsx checks/websitePreviewRuntime.ts
npx tsx checks/websiteStructure.ts
npx tsx checks/websiteEditorComplete.ts
npx tsx checks/websitePublishing.ts
npx tsx checks/websiteAccess.ts --database
```

Browser checks are separate, and are run by one command that starts and stops
the harness itself:

```powershell
npm run checks:browser
```

`websiteBuilder.ts` exercises the existing live-source fallback against a local fixture; run it with `NODE_ENV=development` and `DEV_NO_AUTH=true`. Permission checks authenticate real sessions independently of that bypass. GitHub/source/AI checks use local responders or validated fixture plans and make no external writes or model calls.

The responsive suite covers 73 core cases, and the real API suite covers device and structural drafts, concurrent edits, review/export, restoration and removal. `websiteStructure.ts` checks stable identities, independent copy editing, undo/redo and stale-source protection. `websitePreviewRuntime.ts` executes the actual nonce picker script against a controlled DOM double to check message origins, live media rules, image replacement and viewer controls. It does not render CSS or replace browser verification.

`websiteShared.ts` covers shared-element identity, slots, drift refusal and detach snapshots with no database. `websiteSharedApi.ts` runs the whole lifecycle over real HTTP against an isolated database with the real GitHub adapter answered by a fixed responder — detection, one stored change, another page's draft and preview carrying it, detach and re-link, refusals for a drifted copy and a moved page, one commit for every affected file, and a refused commit leaving the change intact. 61 checks; it needs `DATABASE_URL` set to an isolated local editor database.

Migration `20260909180000_shared_elements` adds `SharedElement` and `SharedElementInstance`. The spec's separate `SharedElementField` table is the element's `slots` JSON here: a slot has no identity of its own, being a position inside the element plus a record of what was in that position when it was shared.

`websiteInspector.ts` covers the inspector's rules without a browser: single property ownership, capability derivation, parent-aware sections, conditional position offsets, the source/computed/override/effective value model and readable colour and font display.

The inspector is also checked in a real browser, because asserting that a control exists in the source is not evidence that the right control was drawn. Playwright is not a dependency of this project; the driver finds an installed copy, or is given one:

```powershell
npm --prefix client exec vite -- --port 5199 --strictPort --host 127.0.0.1
$env:PLAYWRIGHT_URL = "file:///C:/Users/<you>/AppData/Local/npm-cache/_npx/<hash>/node_modules/playwright/index.mjs"
node checks/browser/inspector.mjs
```

It renders `client/inspector-harness.html` — a mount for the inspector alone, not part of the app and not bundled by `vite build`, which takes only `index.html` as an entry — and asks the browser which sections and controls each kind of element got, what value each control shows, and that opening an element wrote nothing into the draft. 52 checks. Stored draft additions are backward compatible; editor core version is now 3.

The assembled client builds successfully. Interactive browser and visual verification remain outstanding: the computer-use inventory had no available browser and automatic approval review blocked a headless Chrome launch. A build alone does not establish visual correctness.


## Client usability improvements (12 September 2026)

The editor opens in Client editing mode. Text, links, images and approved brand styles remain available. The More menu holds Designer controls, Download HTML, Versions, AI and Discard. Designer controls restore the full contextual inspector, style clipboard and structure actions. This mode is a presentation preference, not a permission boundary; existing server permissions still apply. The preference is saved per user in this browser. Toolbar labels use a 12px minimum.

A four-step first-edit guide covers selecting a heading, changing it, checking the phone preview and reviewing publication. Dismissal is remembered per user; More can reopen the guide. Steps advance manually, so finishing the guide does not assert that an edit or publish occurred.

Image uploads and library selections now open a replacement preview with editable description before the user chooses Use this image. Crop & focal point offers shape presets, click selection, horizontal/vertical sliders and two framing previews. Applying a crop writes object-fit, object-position, aspect-ratio, width and height through the normal draft styling path for the active device. Original image bytes remain unchanged. The preview shows the crop, not a complete simulation of the surrounding page; check the actual phone/page preview before publishing. Uploaded images use their authenticated library preview before they are published.

Settings stores up to 20 named heading, button and container-spacing presets in the existing site settings JSON. Properties are restricted and values are validated. Editors apply an approved preset to a selected element. Managers can review matching elements across the site's pages and apply the reviewed styles to drafts. This is an explicit application of styles, not a live token binding: changing a saved preset does not silently restyle published pages. Existing content and device overrides remain intact. Each page uses its reviewed revision and document hash; results identify saved pages and conflicts individually. Linked shared elements are reported and edited through the existing shared workflow. Publication remains a separate page or shared review.

Publishing shows Draft saved, Publishing, Checking live site and Live, with an HTTP(S) live-site link and state-specific failure guidance. Queued work is no longer described as already committed. A failed status lookup offers Retry status check.

### Verification

The client production build and server TypeScript check pass. Prisma Client was regenerated from the existing schema; no database migration or production write was performed for this change.

- `checks/websiteBrandPresets.ts`: preset validation, matching, preserved draft content/device overrides, shared exclusions and responsive crop declarations.
- Existing `websiteInspector.ts` (82 checks), `websitePublishVerify.ts` (23 checks), and `checks/browser/inspector.mjs` (58 checks) pass.
- `checks/browser/builderUsability.mjs`: real Chromium interactions for simple/designer controls, guide, preset selection, crop geometry, publish states, and two-page draft application with one simulated conflict. Desktop and phone screenshots were inspected.
- `checks/browser/builderEditor.mjs`: assembled editor toolbar, persisted mode, guide dismissal, preview switching, and no incidental writes from those actions.

Browser checks use intercepted API fixtures, not a production account or deployment. The separate `client/builder-harness.html` entry is not included in the production build. Run the browser checks against Vite on port 5199 with `PLAYWRIGHT_URL` pointing to an installed Playwright module. Screenshots are written to `checks/artifacts/`.

The client session protocol and unfilled observation sheet are in [website-usability-test.md](website-usability-test.md). Three actual participants and their availability are still required. No customer usability results are claimed.

## Selected text and interaction styles

Text, heading, link and button editors preserve highlighted ranges when using formatting controls. Text colour, highlight, bold, italic and underline apply only to the selected words, including selections crossing existing emphasis. Metadata remains plain text. Read-only editors cannot modify content. Whole-element colour controls route to an active text selection when one exists.

Hover and keyboard-focus styles support colour, background, border colour, shadow, opacity, transform and underline. The state preview does not publish editor markers. These styles apply across screen sizes and travel through existing drafts, revisions, shared edits and publishing. Transition presets respect reduced-motion preferences. Reset removes the selected state's overrides.

Validation: production build and server TypeScript pass. Browser checks cover nested text selections, retained selections, read-only fields, real hover/focus computed styles, state preview and reduced motion. Publication tests cover rich text sanitization, stable field identity and generated interaction styles. Database integration checks now run and pass against an isolated local database (`websiteBuilder`, `websiteSharedApi`, `websitePublishJobs`, `websiteEditorComplete`, `websiteAccess --database`); all five carry a guard refusing any database that is not local and named for testing. Three-client observed usability sessions still require participants.


## September 2026 editor redesign

The editor now uses the full window with a focused top bar, a collapsible inspector, optional Layers, and Content / Style / Interactions tabs. Dark and light editor themes do not affect the public website. Desktop, tablet, phone and preview remain available. Designer controls expose structural operations and advanced settings; normal style controls are directly available under Style.

Selected-word formatting, image framing, site-stored presets, draft history and forward publish diffs remain intact. Hover, keyboard focus and active styles publish through generated CSS. Image framing validates numeric coordinates and ratios and reports cropped resolution. Discard requires confirmation. Ctrl/Cmd+S saves, Ctrl/Cmd+Z undoes, Shift+Z redoes and Ctrl/Cmd+Enter opens review; shortcuts also work inside the canvas.

The active assistant already supported validated proposals. Its obsolete skeleton was removed, and proposals now have a sandboxed static preview before approval. Activity already worked; it now has a dedicated component with loading and empty states. The API already had global rate limiting; expensive website mutations now also have a per-user limit.

Audit corrections: setup HTML was a complete six-step guide, not a stub; brand presets persist in site settings; rich-text labels and history already existed; browser harnesses are used by checks and excluded from production. See CONTRIBUTING.md, website-api.md and adr/0001-preserve-website-source.md for engineering guidance.

## Survey stylesheet coverage

The site survey reads up to ten same-site stylesheets per page. This reaches the
main design system when consent, font, and base stylesheets appear first. The
button variant menu keeps its smaller three-file budget. Cross-origin stylesheets
remain blocked. The browser check runner now starts Vite from the client folder
and terminates the Windows process tree it created.
