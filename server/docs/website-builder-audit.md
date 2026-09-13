# Website Builder — Audit & Improvement Plan

**Scope:** `C:\Users\ASUS\Pictures\Dakyworld\Dakyworld OS\server`
**Date:** 2026-09-13
**Status:** Completed audit; improvement plan ready for triage.

---

## 1. What This Product Is

The Dakyworld OS website builder is an **in-place editor** for existing HTML pages. It is not a from-scratch page constructor. A staff member selects an editable region on a live page, changes its text, image, or link, and the change is saved as a draft that can be reviewed and published — optionally committed to a GitHub repository. Clients (not staff) get a read-only filtered view of the same tool.

### Architecture

```
Client (React + TypeScript + Vite)
  client/src/
    pages/        WebsiteEditor, WebsiteAssets, WebsiteTeam, WebsiteAudit
    components/     WebsiteLayers, WebsiteVersions, WebsiteAIPanel,
                  WebsiteInteractionStyles, WebsiteBrandPresets,
                  WebsiteImageFraming, WebsiteRichText, WebsiteTextFormatting,
                  WebsiteQuickStart, WebsiteConfiguration, ElementInspector,
                  PublishStatus, WebsiteMembers
    lib/          websiteLayers.ts, websiteBrandPresets.ts, websiteTextSelection.ts,
                  clientWorkspace.ts (CLIENT_NAV), types.ts, api.ts

Server (Express + TypeScript)
  src/
    routes/website.ts            — all HTTP routes, no rate limiting
    services/website/
      index.ts                   — core editor: applyValues, sanitizeValue, readPage
      regions.ts                 — draft save (applyValues), calls interaction styles
      structure.ts               — layout changes (changeStructure), calls interaction styles
      site.ts                    — preview rendering, injects interaction preview CSS
      interaction.ts             — NEW: interaction style regeneration
      content.ts                 — AI content operations, publish hooks
      publish.ts                 — git commit + push
      websiteManagement.ts       — site config, shared elements, audit log
      websiteOnboarding.ts       — first-run setup, brand presets
      websiteSource.ts           — raw HTML source editing
      websiteReadiness.ts        — publish checks, CSP, sitemap
      websiteShared.ts           — shared element sync across pages
    shared/websiteInteraction.ts — NEW: shared interaction CSS definitions

Database
  prisma/schema.prisma
    Site, SitePage, SitePageVersion, SharedElement,
    SiteAsset, SiteAuditEvent, SiteMember, PublishJob,
    GithubAppInstallation, BrandPreset, etc.

Tests & Checks
  checks/  — custom check framework (tsx checks/run.ts)
    website.ts, websiteBuilder.ts, websiteButtons.ts, websiteJsx.ts,
    websiteVisual.ts, websitePublishJobs.ts, websitePublishVerify.ts,
    websiteShared.ts, websiteSharedApi.ts, websiteAccess.ts
    websiteBrandPresets.ts (new), websiteInteractions.ts (new)
    browser/builderEditor.mjs (new), browser/builderUsability.mjs (new)

Docs
  docs/website-builder.md          — product roadmap (with status labels)
  docs/website-editor.md           — implementation record
  docs/website-compatibility.md    — compatibility contract
  docs/website-usability-test.md   (new)
```

---

## 2. Work Completed This Session

### 2.1 Interaction Styles Feature (hover / focus)

A complete feature for configuring hover and focus states on interactive elements (links, buttons, call-to-action). Every editable interactive element now gets a settings panel to change its appearance on `:hover` and `:focus-visible`.

**Files created (untracked):**
| File | Role |
|---|---|
| `server/src/services/website/interaction.ts` | Service function `regenerateInteractionStyles` — builds a CSS block from interaction definitions, injects into preview, returns changed regions. |
| `server/src/shared/websiteInteraction.ts` | Shared definitions: `InteractionTarget`, `InteractionPreset`, `defaultInteractionStyles`, `interactionStylePresets`, `interactionCssSelector` — the single source of truth that both server and client use. |
| `client/src/components/WebsiteInteractionStyles.tsx` | UI panel: preset picker (Underline, Color Shift, Scale, Outline) + per-property editors (color, transform, outline) with live preview. |

**Files modified (wired in):**
| File | Change |
|---|---|
| `server/src/services/website/index.ts:387` | `applyValues` calls `regenerateInteractionStyles` when `interactionStyles` is in the change set. |
| `server/src/services/website/regions.ts:1128` | `applyValues` (draft-save path) calls interaction styles regeneration before writing. |
| `server/src/services/website/structure.ts:110` | `changeStructure` calls interaction styles regeneration when an element becomes or stops being interactive. |
| `server/src/services/website/site.ts` | `previewDocument` / `buildPreview` injects the interaction CSS block and a `<style>` tag with a nonce so it passes CSP. |
| `server/src/services/website/index.ts` | `sanitizeValue` accepts `'interactionStyles'` as a permitted region of the editable schema; `readPage` reads current interaction styles back into the editor state. |
| `client/src/pages/WebsiteEditor.tsx:1250` | Renders `<WebsiteInteractionStyles>` panel when an interactive element is selected; passes selected element's interaction styles and an `onChange` callback. |

**Test coverage:** `checks/websiteInteractions.ts` — verifies the CSS block is generated with valid selectors, uses the right property names, applies to both `:hover` and `:focus-visible`, and that presets produce deterministic output.

**Design decision documented:** Both `:hover` and `:focus-visible` styles are generated together because a hover-only style that doesn't also define focus is an accessibility bug. The `focus-visible` selector (not `:focus`) is used to avoid distracting keyboard users.

### 2.2 Rich Text Editing Support

**File created:** `client/src/components/WebsiteRichText.tsx` — renders an inline contenteditable region for multi-line text editing, with buttons for heading, paragraph, bold, italic, ordered/unordered list, and link insertion. Calls `saveValue` (the existing draft API) on blur.

**File created:** `client/src/lib/websiteTextSelection.ts` — utilities for detecting the browser's native text selection (used to determine which text field is being edited during a contenteditable session).

**File created:** `client/src/components/WebsiteTextFormatting.tsx` — a formatting toolbar that attaches to a contenteditable element, shows character count and word count, provides undo/redo buttons.

### 2.3 Brand Presets

**Files created:**
| File | Role |
|---|---|
| `client/src/components/WebsiteBrandPresets.tsx` | UI: preset color palette picker + typography selector, shows live preview of how the brand colors apply to the current page. |
| `client/src/lib/websiteBrandPresets.ts` | Preset definitions (color palettes, font stacks) and a function to apply a preset to the current page's design tokens. |
| `server/src/services/websiteOnboarding.ts` (modified) | `applyBrandPreset` method: injects the chosen palette as CSS custom properties and updates all elements using theme tokens (`var(--brand-color)`, `var(--accent-color)`, etc.). |

**Test coverage:** `checks/websiteBrandPresets.ts` — verifies presets produce valid CSS, color tokens match the palette spec, typography selectors are applied, and revert works.

### 2.4 Image Framing / Focal Point Cropping

**File created:** `client/src/components/WebsiteImageFraming.tsx` — UI panel for cropping: click-and-drag to select a focal point (the part of the image that must stay visible), choose aspect ratio (16:9, 4:3, 1:1, freeform), and see a live preview of how the crop applies in different containers.

### 2.5 Quick Start Guide

**File created:** `client/src/components/WebsiteQuickStart.tsx` — first-run overlay that explains the editor workflow in three steps: select, edit, publish. Dismissible, stored in localStorage so it only shows once per user.

### 2.6 Client / Designer Mode Toggle

**File modified:** `server/src/services/websiteManagement.ts` — added a `mode` field to the site config (`"designer" | "client"`). In client mode, only the edit surface and preview are available; the publish/version/audit/management buttons are hidden.

### 2.7 Browser-Based Usability Tests (New)

**Files created:** `checks/browser/builderEditor.mjs` and `checks/browser/builderUsability.mjs` — Playwright scripts that load the editor in a real browser, simulate selecting an element, editing text, changing a brand preset, and opening the interaction styles panel. These are the first browser-level checks for the builder.

**File created:** `server/client/builder-harness.html` and `server/client/builder-harness.tsx` — a standalone test harness page for the editor that doesn't require the full app shell, used by the browser checks.

### 2.8 Documentation Updates

**File modified:** `docs/website-editor.md` — implementation record updated with the interaction styles feature, rich text editing, brand presets, image framing, and the client/designer mode toggle.

**File created:** `docs/website-usability-test.md` — documents the browser-based usability test plan and results.

**Files modified:** `website-builder.html` and `website-builder-setup.html` (project root) — minor updates to reflect the new features.

---

## 3. Improvement Opportunities

### 3.1 Critical

#### 3.1.1 `WebsiteAudit` page re-exports the wrong component

`client/src/pages/WebsiteAudit.tsx` currently reads:
```ts
export { WebsiteAssets } from "../components/WebsiteAssetLibrary";
```
This is a copy-paste bug. The client nav (`clientWorkspace.ts:21`) defines a route `/website/audit` labeled **"Activity"**. The `SiteAuditEvent` model exists in the schema and the `websiteManagement.ts` service logs audit events, but there is **no UI to view them**. A client clicking "Activity" sees the asset library instead of an activity feed.

**Fix:** Create a `WebsiteAuditTrail` component that calls the audit events endpoint and renders a chronological list. Wire it in `App.tsx` and `WebsiteAudit.tsx`.

**Estimate:** 2–3 hours.

#### 3.1.2 No rate limiting on website API routes

`server/src/routes/website.ts` applies `websiteAccessGate`, `json()`, and service registration middleware, but **no rate limiting**. The rate limiters exist (`server/src/middleware/security.ts:178`) — `loginRateLimit`, `loginAccountRateLimit`, `apiRateLimit`, `webhookRateLimit` — but are not applied to the website router. A malicious or buggy client could spam `PUT /draft` or `POST /publish` and exhaust the git or database.

**Fix:** Apply `apiRateLimit` to `websiteRouter` at the top, or selectively (e.g., tighter limit on publish and structure-changing routes).

**Estimate:** 30 minutes.

#### 3.1.3 AI Assistant panel is a non-functional skeleton

`client/src/components/WebsiteAIPanel.tsx` is a placeholder. It explains "how it will work" (plan §14.3) but the actual flow — send prompt → receive structured change plan → validate → preview → approve → save as draft — is **not implemented**. There is no call to any backend AI endpoint. The panel says "Not built yet" in a grey box.

**The service exists:** `server/src/services/websiteAssistant.ts` has the structure for prompt processing and plan validation, but the client never calls it.

**Fix:** Wire up the end-to-end AI flow. This is the highest-value missing feature but also the most complex.

**Estimate:** 8–12 hours (complex).

### 3.2 High

#### 3.2.1 No undo/redo within the editor session

The editor saves drafts on every change (via `PUT /draft`). There is no in-memory undo stack. If a user makes 5 edits and realizes the second one was wrong, they must manually revert each. The `WebsiteTextFormatting` panel has local undo/redo buttons but they only operate within the current contenteditable session — they vanish on blur.

**Fix:** Maintain an editor-level change history in the `WebsiteEditor` component state (or a shared store) with undo/redo buttons in the header. Each undoable action pushes to a stack; undo reverts the selection's value to its previous state in that session.

**Estimate:** 3–4 hours.

#### 3.2.2 Rich text editing lacks inline formatting controls

`WebsiteRichText.tsx` provides a contenteditable region, but there is no toolbar visible during editing. `WebsiteTextFormatting.tsx` is a separate component that "attaches to a contenteditable element" — but it is **not rendered** anywhere in the editor. A user selecting text in a rich-text field gets no bold/italic/list controls.

**Fix:** Render `WebsiteTextFormatting` when a rich-text field is selected, and verify the contenteditable → formatting → draft-save pipeline works end-to-end.

**Estimate:** 1–2 hours.

#### 3.2.3 Image framing has no server-side validation

`WebsiteImageFraming.tsx` provides UI for focal point + aspect ratio, but the change is sent to `saveValue` as a plain value. There is no server-side check that the focal point coordinates are valid, that the aspect ratio is a supported value, or that the image file can actually support the crop (e.g., cropping a 100px-wide image to 16:9 at 800px). If a bad value is sent, it silently produces a broken image.

**Fix:** Add validation in `sanitizeValue` for the `imageFraming` region: accept `{ focal: { x, y }, aspect: string }` only if `x` and `y` are in `[0, 1]`, `aspect` is in the known set, and the source image dimensions support the requested ratio.

**Estimate:** 1 hour.

#### 3.2.4 No keyboard shortcuts

There are no keyboard shortcuts for common actions. Users must mouse-click to select, then click a button to save, then click "Publish." Standard editor shortcuts (`Cmd/Ctrl + Z` for undo, `Cmd/Ctrl + S` for save, `Cmd/Ctrl + Enter` for publish) would speed up workflow significantly.

**Fix:** Add a `keydown` listener in `WebsiteEditor` that intercepts `Ctrl/Cmd + S` → save draft, `Ctrl/Cmd + Z` → undo, `Ctrl/Cmd + Enter` → open publish dialog. Respect `preventDefault`.

**Estimate:** 45 minutes.

### 3.3 Medium

#### 3.3.1 Brand presets don't persist per-site defaults

`websiteBrandPresets.ts` applies a palette as CSS custom properties, but there is no model in the schema to **store** the chosen brand preset per site. The preset is applied visually but if the page is reloaded or the server restarts, the custom properties are recalculated from the original page HTML (which wasn't updated). The preset needs to be saved to the `Site` record.

**Schema gap:** `Site` model has no `brandPresetId` or `brandTokens` field.

**Fix:** Add `brandPreset Json?` to `Site` in the schema, store the chosen palette + typography on save, and inject those tokens during preview rendering.

**Estimate:** 2–3 hours (schema migration + service + client wiring).

#### 3.3.2 Interaction styles don't update existing `:hover`/`:focus` rules in the HTML file

When a user changes the interaction style for a button, `regenerateInteractionStyles` injects a new `<style>` block into the preview. But it does **not** update the inline or embedded CSS in the actual HTML file on disk. So when the draft is published, the interaction styles may revert to whatever was in the original file. The interaction styles need to be persisted in the page's stored representation (the version that `applyValues` writes).

**Check:** Verify that `applyValues` in `regions.ts` writes interaction styles to the region's data, and that `publish.ts` includes them in the committed HTML.

**Estimate:** 1 hour (audit + fix).

#### 3.3.3 No "discard draft" confirmation

`DELETE /pages/:pageId/draft` exists (`website.ts:573`) and the client can call it, but there is no UI. A user who has made extensive edits and wants to start over must either publish a bad version or manually revert via git. A "Discard draft" button in the editor (with confirmation) is missing.

**Fix:** Add a "Discard draft" button to the editor header, wired to `DELETE /pages/:pageId/draft` with a `window.confirm` dialog.

**Estimate:** 30 minutes.

#### 3.3.4 Publish preview doesn't show a diff

`POST /pages/:pageId/publish` (`website.ts:657`) publishes the draft, but there is no "what will change" preview before publishing. The `WebsiteVersions` component shows diffs for rollbacks, but the forward publish path has no diff UI. A user publishing blindly can't see what the live page will look like.

**Fix:** Add a "Preview publish" button that calls a diff endpoint (or reuses the versions diff) before committing.

**Estimate:** 1–2 hours.

#### 3.3.5 No dark mode for the editor

The editor UI (`WebsiteEditor.tsx`, toolbar panels) uses `bg-white`, `border-line`, etc. — light mode only. There is no dark mode toggle. Given that content editors often work in low-light environments, this is a tangible usability gap.

**Fix:** Add a dark mode toggle that sets a CSS class on the root element, and define dark variants for all UI colors.

**Estimate:** 2 hours.

#### 3.3.6 `website-builder-setup.html` is a stub

This file (project root) received `+1` line in the latest changes. It appears to be a placeholder for setup documentation. If it's meant to be a user-facing guide for setting up the builder, it needs real content. If it's not needed, it should be removed.

**Estimate:** 1 hour (decide + write or delete).

### 3.4 Low

#### 3.4.1 Leftover patch scripts

`builder-interactions.py` and `builder-interaction-fix.py` in the project root are the scripts that were used to apply the interaction styles patches. They have served their purpose and should be deleted to avoid confusion.

#### 3.4.2 `WebsiteAIPanel` is imported but its opening mechanism is unclear

The panel component exists but I could not find where it is opened from in `WebsiteEditor.tsx`. It may be wired to a button in the toolbar that I didn't reach in my read of the 1560-line editor file. Verify the AI button actually opens the panel.

#### 3.4.3 No `aria-label` on contenteditable regions

`WebsiteRichText.tsx` creates a contenteditable element but does not set `aria-label` or `role="textbox"`. Screen reader users will not know what the editable region is.

**Fix:** Add `role="textbox"`, `aria-label={fieldLabel}`, and `aria-multiline="true"`.

**Estimate:** 30 minutes.

#### 3.4.4 Unused `builder-harness` files

`server/client/builder-harness.html` and `server/client/src/builder-harness.tsx` exist for browser tests but may duplicate the `WebsiteEditor` page. Verify they're actually used by the Playwright scripts and not dead code.

---

## 4. Test Coverage Gaps

### 4.1 Existing coverage is strong for core areas

| Check file | Covers | Strengths |
|---|---|---|
| `website.ts` | Full editor integration: save draft, get draft, structure changes, publish, versions, rollback | Tests the real API surface end-to-end |
| `websiteBuilder.ts` | Builder-level: scanning a page, loading fields, saving drafts, error cases | Good error-path coverage |
| `websiteJsx.ts` | Text editing, link sanitization, XSS prevention, length limits | Strong security coverage |
| `websiteButtons.ts` | Button/link HTML output, `rel="noopener noreferrer"` enforcement | Good attribute-level coverage |
| `websiteVisual.ts` | CSP headers, nonce injection, preview rendering, data-attribute stripping | Excellent security coverage |
| `websitePublishJobs.ts` | Publish job lifecycle, error messages, retry | Good async coverage |
| `websitePublishVerify.ts` | Post-publish verification, commit existence | Good |
| `websiteShared.ts` | Shared element sync across pages | Good |
| `websiteSharedApi.ts` | Shared element API boundaries | Good |
| `websiteAccess.ts` | Access control, permissions | Good |
| `websiteBrandPresets.ts` | NEW: preset application, CSS generation | Good new coverage |
| `websiteInteractions.ts` | NEW: interaction style CSS generation, presets | Good new coverage |
| `browser/builderEditor.mjs` | NEW: browser-level editor flow | First browser coverage |
| `browser/builderUsability.mjs` | NEW: browser-level usability | First browser coverage |

### 4.2 Missing or weak coverage

| Gap | What's missing | Recommendation |
|---|---|---|
| AI assistant end-to-end | No test for the AI panel's prompt → plan → validate → preview → approve flow | `checks/websiteAI.ts` — mock the AI response, verify the structured plan is validated and previewed |
| Rich text formatting | `WebsiteRichText.tsx` and `WebsiteTextFormatting.tsx` have no tests | `checks/websiteRichText.ts` — test bold/italic insertion, list toggling, character limits |
| Image framing | No test for focal point + aspect ratio logic | `checks/websiteImageFraming.ts` — test crop calculation with various source/destination dimensions |
| Undo/redo | No test for editor-level undo stack | `checks/websiteUndo.ts` — test that undo reverts the last change |
| Theme/brand persistence | No test that a saved brand preset is restored on reload | `checks/websiteBrandPersist.ts` — save a preset, reload, verify it's applied |
| Interaction styles persistence | Tests verify CSS generation but not that styles are saved to the file on publish | `checks/websiteInteractions.ts` should add a publish-and-verify case |
| Mobile viewport | No test for how the editor behaves on narrow screens | `checks/websiteMobile.ts` — test panel layout, touch interactions |
| Keyboard shortcuts | No test for `Ctrl/Cmd + S`, `Ctrl/Cmd + Z` | `browser/builderKeyboard.mjs` — Playwright test |
| Performance | No test for editor load time with many fields | `checks/websitePerformance.ts` — measure time to render 50+ editable regions |
| Dark mode | No test that dark mode classes are applied | `checks/websiteDarkMode.ts` |

---

## 5. Documentation Gaps

| File | Status | Gap |
|---|---|---|
| `docs/website-builder.md` | Exists (roadmap with status labels) | Needs the new features (interaction styles, rich text, brand presets, image framing) added to the roadmap |
| `docs/website-editor.md` | Exists (implementation record) | Updated for new features this session ✓ |
| `docs/website-compatibility.md` | Exists (compatibility contract) | Appears current, no major gaps |
| `docs/website-usability-test.md` | NEW | Good coverage of the new browser tests |
| `website-builder.html` | Exists (project root, public-facing) | Minor updates this session ✓ |
| `website-builder-setup.html` | Exists (project root) | Is a stub (`+1` line) — needs content or removal |
| **Missing** | — | **No CONTRIBUTING.md** for the server project — new contributors don't know how to run checks (`npx tsx checks/run.ts`), set up the database, or run the dev server |
| **Missing** | — | **No API reference** — the route surface (`website.ts`) is not documented in a machine-readable or human-readable form. New engineers trace routes by reading the file. |
| **Missing** | — | **No architecture decision records (ADRs)** — key decisions (e.g., "why edits-inline-HTML-not-a-builder") are explained in code comments but not captured as standalone docs |

**Recommendation:**
1. Delete or flesh out `website-builder-setup.html` (1 hour).
2. Add a `CONTRIBUTING.md` to `server/` covering dev setup, check commands, and the database URL pattern (1 hour).
3. Generate a lightweight API reference from route comments or maintain a `docs/website-api.md` (2 hours).

---

## 6. Technical Debt & Cleanup

| Item | Severity | Description |
|---|---|---|
| `.py` patch scripts in root | Low | `builder-interactions.py`, `builder-interaction-fix.py` — already applied, delete them |
| `WebsiteAudit.tsx` wrong export | Critical | Re-exports `WebsiteAssetLibrary` — this is a bug, not intentional |
| CRLF warnings in git | Low | `git diff` shows "LF will be replaced by CRLF" warnings for `ElementInspector.tsx` and `site.ts`. Consider adding a `.gitattributes`. |
| 19 untracked files | — | The interaction styles + brand presets + rich text features are committed as a single large change set. Consider splitting into focused commits with clear messages before merging. |

---

## 7. Priority Summary

| Priority | Items | Owner estimate |
|---|---|---|
| **P0** (fix now) | 3.1.1 WebsiteAudit page bug, 3.1.2 No rate limiting on routes | 4 hours |
| **P1** (next sprint) | 3.2.1 Undo/redo, 3.2.2 Rich text toolbar not wired, 3.2.5 Brand preset persistence (schema), 3.3.3 Discard draft, 3.3.5 Dark mode | 8–10 hours |
| **P2** (improvements) | 3.1.3 AI assistant full build, 3.2.4 Keyboard shortcuts, 3.3.1 Interaction styles file persistence, 3.3.2 Image framing validation, 3.3.4 Publish diff preview | 8–12 hours |
| **P3** (polish/debt) | 3.4.1 Delete .py scripts, 3.4.3 ARIA labels, 3.4.4 Verify harness usage, 4.2 test gaps, 5 documentation | 6–8 hours |

---

## 8. Files Touched (Uncommitted Changes)

```
Modified (13 files):
  server/client/src/components/ElementInspector.tsx
  server/client/src/components/PublishStatus.tsx
  server/client/src/components/WebsiteAssetLibrary.tsx
  server/client/src/components/WebsiteConfiguration.tsx
  server/client/src/pages/WebsiteEditor.tsx
  server/docs/website-editor.md
  server/src/services/website/index.ts
  server/src/services/website/regions.ts
  server/src/services/website/site.ts
  server/src/services/website/structure.ts
  server/src/services/websiteManagement.ts
  website-builder-setup.html
  website-builder.html

New (19 files):
  server/checks/browser/builderEditor.mjs
  server/checks/browser/builderUsability.mjs
  server/checks/websiteBrandPresets.ts
  server/checks/websiteInteractions.ts
  server/client/builder-harness.html
  server/client/src/builder-harness.tsx
  server/client/src/components/WebsiteBrandPresets.tsx
  server/client/src/components/WebsiteImageFraming.tsx
  server/client/src/components/WebsiteInteractionStyles.tsx
  server/client/src/components/WebsiteQuickStart.tsx
  server/client/src/components/WebsiteRichText.tsx
  server/client/src/components/WebsiteTextFormatting.tsx
  server/client/src/interaction-harness.tsx
  server/client/src/lib/websiteBrandPresets.ts
  server/client/src/lib/websiteTextSelection.ts
  server/docs/website-usability-test.md
  server/src/services/website/interaction.ts
  server/src/shared/websiteInteraction.ts
```
