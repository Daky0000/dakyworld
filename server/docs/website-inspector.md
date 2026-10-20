# The inspector: General · Style · Interactions

What the properties panel offers for every element the Website Builder can
select, and how each control is stored and published.

Built 11 Oct 2026 on the model of Elementor's V4 (atomic) panel, from two
reference notes Dan wrote on its **Div block** and on the eight elements of a
test page. Those notes covered Flexbox, Div block, Heading, Paragraph, Button,
Video and Image. This document covers those and **every other element this
editor can select** — links, icons, lists, quotes, captions, table cells,
audio, forms, embeds and the page's own title — by the same principles.

The mechanism notes (why it is built the way it is, and the traps) are in
[docs/claude/13-website-builder.md](../../docs/claude/13-website-builder.md)
under "The inspector".

---

## 1. The big picture

Every element has the same three tabs.

| Tab | Shared across all elements? | Notes |
|---|---|---|
| **General** | **Partly.** A **Content** section that depends on the element, then a **Settings** section that is the same short list for everything. | This is the only place elements differ. |
| **Style** | **Yes, identical.** | Nine sections, same controls. A control that does not apply simply has no effect. What does depend on the element is only what has to: flex controls once it is a flex container, a *Flex child* group once its parent is one, offsets once it is positioned. |
| **Interactions** | **Yes, identical.** | The same trigger, effect and timing editor. |

So: **one universal Style and Interactions system, and a small per-element
General schema.** Before this, a container had a fourth tab (Layout) and Style
was tailored per element; both are gone.

### The elements

The editor does not have a widget library: it reads a hand-built page and
names what it finds. These are the things it can select.

| Element (panel name) | Editor kind | HTML it is read from |
|---|---|---|
| Container | `container` | `div`, `section`, `header`, `footer`, `article`, `aside`, `nav`, `main`, also `ul`, `ol`, `figure` |
| Page body | `container` | `body` |
| Heading | `text` / `richtext` | `h1`–`h6` |
| Paragraph / text | `text` / `richtext` | `p`, `span`, `div` with words of its own |
| List item, quote, caption, label, table cell | `text` / `richtext` | `li`, `blockquote`, `figcaption`, `label`, `td`, `th`, `dt`, `dd` |
| Link | `link` | `a` standing on its own (a link inside a sentence is part of the sentence) |
| Button | `button` | `a` or `button` styled as a button |
| Image | `image` | `img` |
| Icon | `icon` | inline `svg`, an icon `img`, an icon-font glyph |
| Video / Audio | `unsupported` + player | `video`, `audio` |
| Preserved element | `unsupported` | `form`, `iframe`, `canvas`, custom elements (`<my-widget>`) |
| Page title / description | `text` | `<title>`, `<meta name="description">` — no element on the page |

---

## 2. GENERAL tab

### 2a. Content (depends on the element)

| Element | Content controls | How they work |
|---|---|---|
| **Container** | *(nothing of its own)* · **Elements inside** list · **+ Add item** on a repeatable list · **Carousel / ticker items** on a ticker | A container holds other elements. The list jumps to a child. A repeatable list (`data-dw-repeatable`) can be given another item; a ticker's items are edited as a list. Its layout, background and spacing are in Style. |
| **Heading** | **Text** (or type on the page) | Inline rich text: double-click on the canvas types into the real heading. Highlight words for bold, italic, colour and links. |
| **Paragraph / text, list item, quote, caption, label, table cell** | **Text** | The same inline editor. |
| **Link** | **Words on the link** | The label. Where it goes is Settings → Link. |
| **Button** | **Button text** · **Button style** · **Icon** (add, replace, remove, which side) | The style is one of the site's own button styles, never a typed class. Hovering a style chip names the class and shows a sample measured in the preview, because the label is only the class's suffix ("B", "O"). |
| **Image** | Picture preview (click to set the **focal point**) · **Replace / Upload / Media library** · **Image URL** · **Alt text** · **Crop & focal point** | Replacing keeps the picture's box. Fit, size and opacity are in Style. |
| **Icon** | Icon picker: a library icon or an image | Swapped whole; its drawing is never edited. |
| **Video** | **Video file** · **Upload video** · **Start time** · **End time** · **Autoplay** · **Play on mobile** (only with Autoplay) · **Mute** · **Loop** · **Player controls** · **Allow download** · **Preload** (Auto / Metadata / None) · **Poster image** · **Apply** | Each maps to an HTML5 attribute: `autoplay`, `playsinline`, `muted`, `loop`, `controls`, `controlslist="nodownload"`, `preload`, `poster`. Start and end become a media fragment on the address (`#t=5,20`). Turning Autoplay on mutes it too, because browsers only start a muted video on their own. **Upload video** stores an MP4 or WebM file with the site's media (judged by its bytes; a `.mov` or `.mkv` is refused with the reason, because most browsers cannot play it) and puts its address in Video file, up to 1 GB on every plan (pictures keep the plan's own limit; both count against its storage), sent in 8 MB pieces past 10 MB. When the canvas cannot load the file the panel names it and says why. The switches are gathered and sent together with **Apply**: one reload of the page, one edit off the plan's allowance. On the canvas, the first click selects a player and the next ones reach its own controls. |
| **Audio** | The same without Play on mobile and Poster | |
| **Preserved element** (form, embed, canvas, custom element) | A note saying it is kept byte for byte | Its inside belongs to its code. Style, Interactions, ID and attributes still apply to the element itself. |
| **Page title / description** | **Text** | Stored in the document's head; shown after a reload or a publish. No Settings: there is no element. |

### 2b. Settings (the same list for everything)

| Setting | Container | Heading | Paragraph / text | List item, quote, caption, cell | Link | Button | Image | Icon | Video / Audio | Preserved |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **HTML tag** ¹ | Div, Section, Header, Footer, Article, Aside, Nav | H1–H6 | p, span, div | fixed | fixed | fixed | — | — | — | — |
| **Link** | wraps the block | wraps the words | wraps the words | wraps the words | its own + new tab | its own + new tab ² | wraps the picture | — ³ | — | — |
| **ID** ¹ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Attributes** ¹ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Display conditions** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

¹ Shown with **Designer controls** on (account menu).
² A `<button>` element has no link: it goes where the page's script sends it.
³ Link the block or button around the icon.

Two things have no Settings at all: the **page title and description**, which
have no element on the page, and the **page body**, whose markup is the page's
own. Inside a **shared element** that is linked across pages, the tag, ID and
attributes are locked so every copy stays the same; words, link and style still
change for all of them. On a page built from **framework source files**, markup
is changed in the code.

How each one works:

- **HTML tag.** Renames the element within its own family. A family, never a
  free choice: a list item outside a list or a `<p>` around a block is broken
  HTML that a browser silently repairs into a different page. `main` is never
  offered as a target (a page has one). `ul`, `ol`, `figure`, `li`, table
  cells, quotes, links and buttons keep their tag. Semantic only — it looks the
  same unless the site's CSS styles that tag.
- **Link.** A destination with the site's own pages offered as you type. Words,
  pictures and containers that are not links are wrapped in one; clearing the
  field or *Remove link* unwraps them. Nothing that sits inside a link, or holds
  a link, button or form, can be wrapped in another. *Open in a new tab* always
  writes `rel="noopener"` with it.
- **ID.** The HTML `id`: letters, digits, `-` and `_`, starting with a letter.
  Refused when another element on the page has it. An element with an ID
  cannot be duplicated, because an ID has to be unique.
- **Attributes.** `key="value"` pairs from an allowlist: `title`, `lang`, `dir`,
  `role`, `tabindex`, `hidden`, `translate`, `aria-*`, `data-*` and microdata
  (`itemprop`, `itemscope`, `itemtype`, `itemid`). **Refused, by name and with
  the reason:** `on*` event handlers (script), `class` (the design system's),
  `style` (the Style tab's), `href` / `target` / `rel` (Link's), `src` and other
  addresses (the picture, video and link controls'), `data-dw-*` (the editor's),
  and `data-` names some libraries run as code (`data-hx-*`, `data-on*`…).
- **Display conditions.** Three switches: Desktop, Tablet, Phone. Off means the
  element is not shown at that width (`display: none` there). There are no
  rules about dates, roles or signed-in visitors: a page here is a file, not an
  app, and there is nothing on the server to decide them.

---

## 3. STYLE tab (identical for every element)

Sections, top to bottom. Every value can be set per screen size (Desktop,
Tablet ≤ 1024px, Phone ≤ 640px) and, for the look under the pointer, in the
**Hover** state beside **Normal**.

| Section | Controls |
|---|---|
| **Layout** | **Display**: Block, Flex, In-blk, In-flx; *More…*: Grid, Inline grid, Inline, Flow root, None. **With Flex:** Direction (4), Justify content (6), Align items (4), Gaps (column / row, linkable), Wrap (3), Align content (once it wraps). **With Grid:** Columns and Rows (a number makes that many equal tracks, anything else is written as typed), Gaps, Justify items, Align items, Auto flow. |
| ↳ *Flex child* (parent is flex) | Align self · Order (First / Last / Custom) · Flex size (Grow / Shrink / Custom: grow, shrink, basis) |
| ↳ *Grid child* (parent is grid) | Column · Row · Align self |
| **Spacing** | Margin and Padding: four sides each, linkable, with a unit. |
| **Size** | Width, Height, Min width, Min height, Max width, Max height · Overflow (Visible / Hidden / Auto). *Show more:* Aspect ratio (Auto, 1/1, 4/3, 3/4, 16/9, 9/16, 3/2, 2/3, Custom) · Object fit · Object position. |
| **Position** | Position (Static / Relative / Absolute / Fixed / Sticky) · Top / Right / Bottom / Left offsets (once not static) · Z-index · Anchor offset (`scroll-margin-top`). |
| **Typography** | Font family · Font weight (100–900) · Font size · Text align (Start / Center / End / Justify) · Text color. *Show more:* Line height · Letter spacing · Word spacing · Columns (+ column gap) · Line decoration · Text transform · Direction (LTR / RTL) · Font style · Text stroke. |
| **Background** | **Overlay** layers, stacked (Image: picture, position, repeat, size, attachment · Gradient: stops on a bar, flip, linear angle or radial position · Color) · **Color** (the base colour) · **Clipping** (Full element / Padding edges / Content edges / Text). |
| **Border** | Border width (one value, or *Adjust borders* per side) · Border color · Border type (None, Solid, Dashed, Dotted, Double, Groove, Ridge, Inset, Outset) · Border radius (one value, or *Adjust corners*). |
| **Effects** | Blend mode · Opacity · **Box shadow** (stackable: colour, Outset / Inset, horizontal, vertical, blur, spread; presets) · **Transform** (stackable: Move / Scale / Rotate / Skew, X Y Z; settings: origin, children perspective) · **Transitions** (property + duration) · **Filters** · **Backdrop filters** (blur, brightness, contrast, grayscale, invert, saturate, sepia, hue rotate, drop shadow). |
| **Custom CSS** ¹ | `element.style { … }`: declarations for this element that no control above owns. |

Conventions:

| Pattern | What it does |
|---|---|
| **Dot beside a label** | Filled blue: changed in this draft — press it to put back what the page had. Grey: set on this element in the page's own HTML. Ring: handed down from a wider screen. |
| **Empty box, grey number** | "As the website has it"; the number is what the page really renders. |
| **Number + unit** | PX, %, EM, REM, VW, VH, CH and *fx* — any value typed as CSS (`auto`, `calc(…)`, `min(…)`). A number changes the page as it is typed; anything else is written when the box is left, so half a `calc(` is never saved. Drag the ⇔ to scrub; Shift moves ten at a time. |
| **Link icon** | Linked: one value for every side. Unlinked: each side on its own. |
| **Row of buttons** | One of a short list; press the chosen one again to clear it. The value in force is outlined even when it comes from the stylesheet. |
| **+ on a row** | Adds a stacked value. Each reads as one line, opens into its editor, and can be removed. A value the rows cannot express (a `matrix()`, a `calc()` shadow) is shown as written, never rewritten. |
| **Show more / less** | The properties fewer people need. |

What is **Desktop only**, because a tablet or phone rule can carry less: picture
layers in Background, Text stroke, and Clipping → Text.

On Tablet and Phone, an element with changes for that size only shows one line
above the sections — "2 changes for phones only" — with **Reset**, which drops
them all and goes back to what the wider screen hands down. Desktop has no such
line: the device switch in the bar already says which size is being edited.

**What typography reaches inside an element.** The same on every screen size:

| Selected | Font size · Line height · Letter spacing · Word spacing | Weight · Style · Colour · Decoration · Family · Transform |
|---|---|---|
| A **text element** — heading, paragraph, button, link, list item: its children are all words (`span`, `strong`, `a`, an icon…) | Reach **every word inside**, even one whose class gives it a size of its own, from the widest screen that sets them. A word with its own setting keeps it. | Inherited the ordinary way. Bold words stay bold, links keep their colour and underline, a coloured accent word keeps its colour. |
| A **container** — section, div, card | Inherited the ordinary way: a heading or paragraph inside keeps its own size. | Inherited the ordinary way. |

On a page built from framework source files, whether an element is a text
element is decided by its tag, and its words are reached from a Tablet or Phone
size only. Superscripts and subscripts keep their smaller size.

A Desktop value is written as the element's inline style, so a rule in the
website's own stylesheet marked `!important` still wins over it (the canvas
shows the same). A Tablet or Phone value wins over such a rule.

---

## 4. INTERACTIONS tab (identical for every element)

Empty state: *Animate elements with Interactions* and **Create an interaction**.
Each interaction is a line — "On page load: Fade In" — with **Play**, **Remove**,
and a **Details** and a **Settings** tab.

| Control | Options | Meaning |
|---|---|---|
| **Trigger** | Page load · Scroll into view · While scrolling · On hover · On click · Continuously | What starts it. One interaction per trigger; page load and scroll into view are both the entrance and share a place. |
| **Effect** | Fade · Slide · Scale · Blur · Flip · Custom; *attention:* Pulse, Float, Bounce, Shake, Wiggle, Spin; *while scrolling:* Parallax; *on click:* Press, Pop, Flash | The animation. |
| **Type** | In · Out | Arrive or leave. Not for attention effects. |
| **Direction** | From top / bottom / left / right | Optional for Fade, required for Slide. |
| **Repeat** | a number · infinite | Page load, hover and click. |
| **Duration**, **Delay** | milliseconds | |
| **Easing** | Smooth, Ease In, Ease In Out, Ease Out, Back In, Back In Out, Back Out, Linear | |
| **Start / End / Relative to** | 0–100% · Viewport or Page | While scrolling only: the stretch of the scroll the effect runs across. |
| **Custom effect** | From / To: Opacity, Scale X Y, Move X Y Z, Rotate X Y Z, Skew X Y | The two states of your own effect. |
| **Trigger on** (Settings) | Desktop · Tablet · Phone | Switch a screen size off to keep the element still there. |

How they play, and the limits that follow from adding **no script** to a page:

- **Page load** plays once loaded. **Scroll into view** and **While scrolling**
  follow the scroll in browsers with scroll-linked animation; elsewhere an
  entrance plays on load and a scroll effect leaves the element as it is.
- **On hover** plays while the pointer is over the element and stops when it
  leaves. For a colour or a lift under the pointer, use Style → Hover instead.
- **On click** plays while the element is pressed; a link or button keeps it
  until something else is clicked. A click cannot start a long animation on its
  own afterwards — that needs code the page does not carry.
- Visitors who have asked their device for **reduced motion** get none of it.

---

## 5. Where this differs from Elementor, on purpose

| Elementor V4 | Here | Why |
|---|---|---|
| Classes area, states per class | No classes; **Normal / Hover** in Style | The page's classes are the site's design system. Styling is one inline declaration on the element that was selected. |
| Per-element base styles (a Button is blue with 12/24 padding) | None | The base is the site's own stylesheet, shown as the placeholder. |
| Display conditions: role, date, device… | Screen sizes only | Pages are static files. |
| Any attribute | An allowlist | An editor's guest must not be able to run script on the site's visitors. |
| Image **Resolution** (WordPress sizes) | — | There is one file. |
| Video **Select / Upload** | By address | The media library holds pictures. |
| Fonts: Google library | The site's fonts and system stacks | A new typeface is a site-wide decision (Theme). |
| Global variables | Brand presets (Saved style) | |
| Interactions run by a script | CSS only | No script is ever added to a customer's page. Hence the click and scroll limits above. |
| Custom CSS: any rule scoped to the element | Declarations only | Selectors, pictures, quotes and script are not written into a public page. |

---

## 6. Data model

| What | Where it is stored | Published as |
|---|---|---|
| Content (words, link, picture, alt, button style, icon) | `draft.values[fieldId]` — only what changed, with what the page said at the time | A splice at recorded offsets; nothing else in the file moves |
| Style, Desktop | `draft.values[fieldId].style` | The element's inline `style` |
| Style, Tablet / Phone | `draft.values[fieldId].responsive` | `data-dw-style` token + generated media rules |
| A text element's sizes reaching its words | Derived: the inline style and the overrides | One `:where([token]) :not(…)` rule per size, from the widest screen that sets it; a Desktop size gives a text element its token |
| Hover state | `--dw-hover-*` in the inline style | Fixed `:hover` rules reading them |
| Settings: tag, ID, attributes, video | A structure change (`kind: "settings"`) folded into the draft document | The tag renamed, attributes written; field identities pinned with `data-dw-node` |
| Display conditions | `display: none` in the base style or a screen-size override | As style |
| Interactions | `--dw-enter*`, `--dw-loop*`, `--dw-scroll*`, `--dw-onhover*`, `--dw-onclick*` in the inline style | Fixed keyframes and one layered `animation` rule in the page's interaction stylesheet |

Where the code is:

| Part | File |
|---|---|
| Tabs and wiring | `client/src/pages/WebsiteEditor.tsx` |
| General → Settings, video | `client/src/components/WebsiteElementSettings.tsx` |
| Style tab | `client/src/components/WebsiteStyleTab.tsx`, `StyleControls.tsx`, `lib/websiteStyleValues.ts` |
| Hover state | `client/src/components/WebsiteHoverPanel.tsx` |
| Interactions | `client/src/components/WebsiteInteractionsPanel.tsx`, `lib/websiteMotion.ts` |
| What may be written as markup | `src/shared/websiteElementSettings.ts` |
| Writing markup | `src/services/website/structure.ts` (`applyElementSettings`) |
| The animation rules | `src/shared/websiteInteraction.ts` |
| Every control, as a table | `src/services/website/propertyInventory.ts` |

What holds it:

| Check | Holds |
|---|---|
| `checks/websiteElementSettings.ts` | Tag families, a retag keeping every field id, the attribute allowlist and each refusal, unique IDs, video attributes |
| `checks/websiteInspector.ts` | List values as rows and back, shorthands expanded only when touched, the interaction model, and that the server keeps every value the panel writes |
| `checks/websiteInteractions.ts` | The published rules and what survives sanitising |
| `checks/websitePropertyAudit.ts` | The inventory, and that the tabs are the same for every element |
| `checks/browser/inspector.mjs` | What the Style tab draws for each kind of element |
| `checks/browser/inspectorTabs.mjs` | The three tabs through the real editor, asserting the computed page |
| `checks/browser/motionRules.mjs` | What a browser computes from the published animation rules |
| `checks/browser/stylePanel.mjs` | Style controls changing the page, saving, resetting, undoing |

---

## 7. Adding an element later

1. Decide how the page is read into it (`regions.ts`) — its kind, its tag, what
   its Content is.
2. Give it a **Content** block in the General tab. Nothing else is per element.
3. If its tag may change, add its family to `tagOptions`. If it has attributes
   of its own (as a player does), add them to the allowlist with a rule per
   value, and draw them as typed controls rather than as free attributes.
4. Settings, Style and Interactions come with it. Do not tailor them: the point
   of this panel is that it is the same everywhere.
