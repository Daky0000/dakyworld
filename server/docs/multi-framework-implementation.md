# Multi-Framework JSX Source Editing Implementation Plan

## Problem

The current JSX adapter (`repo/server/src/services/website/jsx.ts`) only supports **native HTML JSX elements** (e.g., `<h1>`, `<p>`, `<a>`). It explicitly rejects custom React components (`<Hero />`, `<Card />`) at line 154 with an "unsupported" issue:

```ts
if (!/^[a-z][a-z0-9]*$/.test(tag)) { 
  issue(opening, "unsupported", `Props and direct text of <${tag}> need a component-specific adapter.`); 
  return true; 
}
```

This means **Next.js App Router pages** (`.tsx` files that use components like `<Hero title="..." />`, `<Layout>`, etc.) cannot have their source text edited in-place. The user's stated goal is: **enable editing of Next.js app/pages router source pages through the HTML visual editor, with edits mapping back to JSX/TSX literals.**

## Architecture Overview

The editor works by:
1. **Discovering** editable fields from source JSX/TSX (via `discoverJsxFields`)
2. **Rendering** those fields into HTML preview (via `mapJsxFieldsToHtml`)
3. **Accepting edits** in the preview
4. **Applying** edits back to source (via `applyJsxValues`)

The gap is step 1: `discoverJsxFields` rejects component elements. We need a "component adapter" that reads `data-dw-field` markers on component props and exposes them as editable fields.

---

## Implementation Steps

### 1. Add Component Prop Discovery to `jsx.ts`

**File**: `repo/server/src/services/website/jsx.ts`

**Current behavior** (line 148-154): The `inspect()` function returns `true` early for capitalized tags but issues an "unsupported" warning without scanning attributes.

**What to change**:
- In `inspect()`, for capitalized component tags, still scan for `data-dw-field` markers and editable attributes (src, href, alt, title).
- Add each marked prop as a `JsxField` with `kind: "text"` for string props.
- Do NOT attempt to introspect deeply typed props (no TS type resolution). Only accept **static string literals**.
- If a component has exactly **one** `data-dw-field`-marked prop with a string literal value → expose as editable with `confidence: "explicit"`.
- If a component has **two or more** marked props → issue an `ambiguous` warning (read-only). The marker alone is insufficient for disambiguation.
- If a component has **zero** marked props but passes structure checks → issue `ambiguous` with a message like: "Component needs a data-dw-field marker on one prop to be editable."

**Why**: This lets `<Hero data-dw-field="hero.title" title="Hello" />` expose `title` as an editable field. The marker disambiguates which prop is editable.

### 2. Update `mapJsxFieldsToHtml` for Component Fields

**File**: `repo/server/src/services/website/jsx.ts`, function `mapJsxFieldsToHtml` (line 324)

**Current behavior**: Requires `field.tag === sourceField.tag` for matching. Component fields have tags like `Hero` that won't match HTML preview elements like `h1` or `div`.

**What to change**:
- When `sourceField` has a `marker`, skip the tag-equality check (`field.tag !== sourceField.tag`).
- Match solely on marker + property + value.
- If no marker, fall back to current behavior (tag + value).
- This allows `<Hero title="Hello" />` → HTML renders `<h1>Hello</h1>` → mapped back via marker `hero.title`.

**Why**: Component elements render to arbitrary HTML elements (a `<Hero>` component renders `<h1>` in HTML). The marker is the only reliable bridge.

### 3. Handle Component Fields in `applyJsxValues`

**File**: `repo/server/src/services/website/jsx.ts`, function `applyJsxValues` (line 264)

**Current behavior**: Rediscover after edits, verify round-trip. Component fields with markers should already work since they're regular `JsxField` objects with `start`/`end` offsets.

**What to verify**:
- Ensure `encode()` handles `"jsx-text"` encoding for component prop string values correctly (it should, since it's just the literal value splice).
- Ensure the round-trip check at line 297-301 works for component fields (rediscover + compare values).

**Likely no changes needed** — the discovery and apply pipeline is generic. But test with component syntax.

### 4. Style Markers (Decision C — Not Yet Implemented)

**File**: `repo/server/src/services/website/jsx.ts`

**What to implement**:
- Read `data-dw-style="styleName"` attributes on elements.
- Extract the `styleName` as a style key for the field.
- Expose this in the `JsxField` type (e.g., `styleKey?: string`).
- This allows components/elements to carry CSS class/style annotations that the visual editor can modify.

**Why**: Enables style-driven field identification and inline style editing for both HTML and JSX.

### 5. Structure Reordering Integration

**File**: `repo/server/src/services/website/structure.ts`

**Current state**: `structureControls()` reads fields via `readPage(source)` (HTML parser). It uses `parseHtml` and `walk`.

**What to implement**:
- Add a parallel `structureControlsJsx()` function that uses the TypeScript AST to find JSX elements (including components).
- For component elements, use `data-dw-node` markers for persistent identity (same pattern as `identifyFields` at line 46).
- Support `remove`, `duplicate`, `before`, `after` actions on JSX component blocks.
- Apply changes as atomic splices on the source string (same as `changeStructure` does for HTML).

**Why**: Structure changes (reorder, remove, duplicate) need to work in JSX source the same way they work in HTML.

### 6. Publish Path Integration

**File**: `repo/server/src/services/website/site.ts` (around line 610-655, `publishSourcePage`)

**What to implement**:
- Before publishing, call `applyJsxValues` to write all JSX field edits back to source.
- If component fields exist, ensure the HTML preview was built by rendering the JSX (not hand-written HTML).
- Handle the `$document` snapshot: when publishing, the `$document` key in field values may contain a rendered HTML override. Strip this and write back to the original `.tsx` source.
- Call `changeStructure` equivalent for JSX before `applyJsxValues` if structure reordering happened.

### 7. Framework Detection & Routing

**File**: `repo/server/src/services/website/index.ts` or routes

**What to implement**:
- Detect `.tsx`/`.jsx` source files vs `.html` files.
- Route JSX files through `discoverJsxFields` / `applyJsxValues` / `mapJsxFieldsToHtml`.
- Route HTML files through existing `readPage` / `applyValues` / regions pipeline.
- Maintain a unified `Field`/`SiteField` interface that both adapters satisfy.

### 8. Test Coverage

**File**: `repo/server/checks/`

Create `websiteJsxComponents.ts`:
- Test component with single `data-dw-field` prop → editable field discovered.
- Test component with multiple marked props → `ambiguous` issue.
- Test component with no markers → `ambiguous` issue with guidance message.
- Test `mapJsxFieldsToHtml` matches component fields by marker only.
- Test `applyJsxValues` round-trips component prop changes correctly.
- Test style markers (`data-dw-style`) are extracted.
- Test structure reordering on JSX (remove, duplicate, move).

---

## Key Files

| File | Change |
|------|--------|
| `repo/server/src/services/website/jsx.ts` | Component prop discovery, marker-only mapping, style markers |
| `repo/server/src/services/website/structure.ts` | JSX structure controls (duplicate/reorder/remove) |
| `repo/server/src/services/website/site.ts` | Publish path: apply JSX edits before commit |
| `repo/server/src/services/website/index.ts` | Export new functions, unified field interface |
| `repo/server/checks/websiteJsxComponents.ts` | New test file |

## Recommended Further Upgrades

### 1. Framework Plugin System

Instead of hardcoding `.jsx`/`.tsx` adapters, create a plugin interface:

```ts
interface FrameworkAdapter {
  detect(filePath: string, source: string): boolean;
  discoverFields(source: string, filePath: string): JsxDiscovery | HtmlDiscovery;
  applyValues(source: string, ...): string;
  buildPreview?(source: string, ...): string;
}
```

This makes adding Vue, Svelte, Astro, etc. trivial by dropping in a new adapter module.

### 2. Source Map Integration

Use TypeScript's source map output to generate reliable source↔HTML mappings for complex expressions. This reduces reliance on manual `data-dw-field` markers in well-structured code.

### 3. Lazy / Incremental Field Resolution

Currently `discoverJsxFields` parses the entire AST. For large source files, add incremental discovery — only scan regions that have changed since the last discovery (identified by source hash comparison). Cache decoded literal values.

### 4. Cross-File Field References

Track fields across multiple source files (e.g., a layout component + a page component). Allow editing props on `<Layout>` that are defined in a separate file from where they are rendered.

### 5. Expression Safety Guard

When a component prop contains `{someVar}` instead of a string literal, provide a clear error message rather than a generic `ambiguous`:

```
"Edit this prop in source code — the value is sourced from a variable, not a string literal."
```

### 6. Hot Path Optimization — `decodeLiterals`

The `decodeLiterals` function in `jsx.ts` uses `ts.transpileModule`, which is expensive. Cache decoded values by source hash to avoid re-transpiling on every discovery call when the source hasn't changed.

### 7. Component Children as Rich Text

Extend beyond single-prop editing:

```jsx
<Card data-dw-field="card.content">
  <h2>Title</h2>
  <p>Body text</p>
</Card>
```

Add a `content` kind to `JsxFieldKind` that supports multi-line JSX children. The HTML preview renders these children; edits write back to the JSX expression children list.

---

## Design Decisions (from work state)

- **A (component prop mapping)**: Implemented — single `data-dw-field` on a component prop → editable. Two+ → `ambiguous`.
- **C (style markers)**: Decided, not coded — add `data-dw-style` extraction.
- **B (structure reorder)**: Decided, not coded — JSX structure controls via `parse.ts`/`walk` API.
- **D (render-fallback CTA)**: Already in `WebsiteEditor.tsx:1214-1231`.

## Verification

1. `npx tsx check.ts` (or repo's check command) — all checks green
2. `tsc --noEmit -p tsconfig.checks.json` — type check clean
3. New `websiteJsxComponents` check file passes with 20+ assertions
4. Manual: edit a `<Hero data-dw-field="hero.title" title="…" />` component prop in browser → source `.tsx` file updates correctly