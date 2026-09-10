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

The editor supports imported or repository-backed HTML pages and a separate static JSX/TSX source workflow. It does not yet provide a running React project canvas or arbitrary framework editing.

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
- **Source files:** browse JSX/TSX inside the site's configured repository folder, edit literal native-element text and existing `href`/`src`/`alt` strings, review a byte-preserving change, download source, or publish with both source and publish permission. Full-file hashes reject stale edits. Dynamic values, custom component props, class names and component structure remain code-controlled. Unsupported or ambiguous fields are explained. Source code is parsed, never executed.

## Which GitHub credential a site publishes with

Both work, per site. A site with a customer's own GitHub App installation borrows an hour-long token scoped to the repositories they chose; every other site uses the shared token exactly as before. The credential is ambient for the duration of one piece of work (`withGithubCredential`), so a nested read during a commit inherits it without every function growing a token parameter. `docs/github-app.md` is what to create on GitHub and what to put in Railway — until that exists nothing changes. `checks/githubApp.ts` covers it.

## Onboarding a website, and what a client sees

`Website → Onboarding` is the list somebody works down before a client is given a website: address, repository, a branch proved readable by actually reading a file from it, pages scanned, the compatibility report gone through, this site's own colours and fonts set so the editor stops offering Dakyworld's, shared elements linked, publishing confirmed, and the client's own access. Every line is **derived from the site rather than ticked**, so nothing can claim to be done after it has stopped being true — a branch that becomes unreadable goes back to blocked on its own. The last line is the handover conversation, which is the only thing on the page nothing can work out for itself, and it is recorded on the site's activity.

A customer does not get the operations menu with most of it missing. `client/src/lib/clientWorkspace.ts` holds what they are offered — Pages, Assets, Team, Activity — the header says "Dakyworld · Website" rather than "Dakyworld OS · Internal Operations", the builder's own second navigation strip is dropped because those four are already in the header, and they land on their pages. The permission boundary was already right; this is the surface catching up with it, and `checks/websiteClientWorkspace.ts` asserts that nothing a client is offered leaves the website product.

## Publishing, and knowing it worked

A commit is not a deployment. `PublishJob` records every publish from before it starts until the change has been seen on the live page: the row is written **before** GitHub is touched, so a process that dies mid-publish leaves a `COMMITTING` row the next boot asks GitHub about rather than a mystery — either the commit landed and the state is `RECONCILIATION_REQUIRED` with the sha on it, or nothing happened and it says so. After the commit the job carries the public address, a distinctive string the change put on the page and the file's hash; the scheduler looks at the live page on a backoff from twenty seconds out to five minutes, and settles on `COMPLETED` with how long the host took or `VERIFY_FAILED` with the page still showing the old version. The editor shows that line under the publish notice, so "published" stops meaning "committed". `services/websitePublishJobs.ts`; `checks/websitePublishVerify.ts` covers the deciding with no database, `checks/websitePublishJobs.ts` the rows and the clock with an isolated one.

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
npx tsx checks/websitePublishVerify.ts
npx tsx checks/websiteClientWorkspace.ts
npx tsx checks/githubApp.ts
npx tsx checks/websiteResponsive.ts
npx tsx checks/websitePreviewRuntime.ts
npx tsx checks/websiteStructure.ts
npx tsx checks/websiteEditorComplete.ts
npx tsx checks/websitePublishing.ts
npx tsx checks/websiteAccess.ts --database
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
