# Website editor implementation

The editor supports imported or repository-backed HTML pages and a separate static JSX/TSX source workflow. It does not yet provide a running React project canvas or arbitrary framework editing.

## Available workflows

The visual sidebar includes a searchable Layers tree in document order, expand/collapse controls, changed/error filters, keyboard navigation and selection breadcrumbs. Filtering preserves ancestor context so nested elements remain understandable.

- **Sites:** connect a public address and optional GitHub repository, scan existing pages, or import HTML files (up to 2 MB). Additional pages can be imported into an existing site. JavaScript app shells without rendered content are refused with a source-editor explanation.
- **Visual editing:** select page content or parent containers; edit text, links, images, and design controls. Layout controls cover flex/grid, dimensions, constraints, spacing, position, stacking, image fitting, gradients, typography, colours, borders and effects. CSS units and expressions are retained. Image replacements update the canvas immediately and discard the old `srcset` candidates.
- **Responsive styling:** Desktop edits base styles; Tablet edits overrides at 1024px and below; Phone edits overrides at 640px and below. Phones inherit tablet values until explicitly overridden. The canvas uses 1280/820/390px viewports with zoom; changing widths preserves the frame and pending edits. Clear one property or all overrides to inherit again. The full device map travels through undo, draft recovery, conflict resolution, version restore, export and publish review. A shared browser/server sanitizer and renderer keep live and exported media rules consistent.
- **Page structure:** drag Layers or use Move up/down to reorder editable siblings, duplicate static blocks, and remove elements. Copies can be edited independently before publishing. Actions save a revision-checked document checkpoint, retain prior content/style changes in review, and support server-side undo/redo. Persistent `data-dw-node` identities prevent positional edits from moving to another element. Clients cannot submit raw document checkpoints. Concurrent writes and full-source hash checks protect changes made by another editor or developer.
- **Drafts:** autosave with revision checks, conflict resolution, undo/redo, and per-user tab recovery for unsaved changes. Saving a draft does not publish. Failed saves retain local changes. Publish review binds the draft revision to the current source hash.
- **Assets:** upload PNG/JPEG/WebP/GIF images, choose them from a site library, include referenced images in the same repository commit, or embed them in downloaded HTML. Uploads and previews require site access. Replacing an image clears its old `srcset` so it cannot keep showing the previous picture.
- **Settings:** site details, colours, fonts, optional AI suggestions and brand voice. Fonts must already be loaded by the website. Only internal administrators with website management rights can change the repository connection associated with the OS's shared GitHub credentials.
- **Team:** assign existing accounts as viewer, editor, reviewer, publisher, developer or manager. External accounts only see assigned sites. Membership changes are audited; concurrent changes cannot remove the last active manager. Account creation/invitation remains with the OS account administrator.
- **Publishing:** review changes, commit to the configured branch, view versions, restore a version into a draft or publish a rollback. Rollback review shows content, links, base/device styling, button variants and tab targets that differ from the current source. Per-page database locks reject simultaneous publishes. The GitHub adapter compares expected content against the exact parent commit and never force-updates a branch. A newer draft saved during a publish is preserved.
- **AI:** an optional proposal panel scoped to one selected field or the page. Suggestions include the unsaved draft, pass the editor validator and existing budget checks, and require explicit application into the draft. The assistant never publishes. No paid model calls were made during implementation checks.
- **Source files:** browse JSX/TSX inside the site's configured repository folder, edit literal native-element text and existing `href`/`src`/`alt` strings, review a byte-preserving change, download source, or publish with both source and publish permission. Full-file hashes reject stale edits. Dynamic values, custom component props, class names and component structure remain code-controlled. Unsupported or ambiguous fields are explained. Source code is parsed, never executed.

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
npx tsx checks/websiteResponsive.ts
npx tsx checks/websitePreviewRuntime.ts
npx tsx checks/websiteStructure.ts
npx tsx checks/websiteEditorComplete.ts
npx tsx checks/websitePublishing.ts
npx tsx checks/websiteAccess.ts --database
```

`websiteBuilder.ts` exercises the existing live-source fallback against a local fixture; run it with `NODE_ENV=development` and `DEV_NO_AUTH=true`. Permission checks authenticate real sessions independently of that bypass. GitHub/source/AI checks use local responders or validated fixture plans and make no external writes or model calls.

The responsive suite covers 73 core cases, and the real API suite covers device and structural drafts, concurrent edits, review/export, restoration and removal. `websiteStructure.ts` checks stable identities, independent copy editing, undo/redo and stale-source protection. `websitePreviewRuntime.ts` executes the actual nonce picker script against a controlled DOM double to check message origins, live media rules, image replacement and viewer controls. It does not render CSS or replace browser verification. Stored draft additions are backward compatible; editor core version is now 3.

The assembled client builds successfully. Interactive browser and visual verification remain outstanding: the computer-use inventory had no available browser and automatic approval review blocked a headless Chrome launch. A build alone does not establish visual correctness.
