/**
 * Plain-English explanations for the editor's inspector, shown on hover.
 *
 * Keyed by the words on screen, not by a control's code, so a label gets its tip
 * wherever it is drawn and no control has to opt in: `EditorTips` matches a
 * `<label>` (or a row label) by its text, and an option inside a labelled group
 * by `Group/Option` — `Display/In-blk` is the "In-blk" button under Display.
 *
 * Written for a business owner editing their own site, not a developer. Say what
 * it does to the page; name the CSS only where a designer will look for it.
 */
export const EDITOR_TIPS: Record<string, string> = {
  // Layout
  Display: "How the element sits on the page: as a block on its own line, in a line with text, or as a flex or grid box that arranges what is inside it.",
  "Display/Block": "Block: takes the full width and starts on a new line.",
  "Display/Flex": "Flex: lines up what is inside in a row or a column, with control over spacing and alignment.",
  "Display/In-blk": "Inline block: sits in a line with text, like a word, but keeps its own width, height and padding.",
  "Display/In-flx": "Inline flex: a flex box that sits in a line with text instead of taking the full width.",
  Direction: "Whether the items inside run across in a row or down in a column.",
  Wrap: "Whether items move onto a new line when they run out of room, or stay on one line and squeeze.",
  "Justify content": "How the items inside are spread along the main direction: packed at the start, centred, at the end, or spaced out.",
  "Align items": "How the items inside line up across the box — for a row, that is top, middle or bottom.",
  "Align content": "How the lines of wrapped items are spaced when there is more than one line.",
  "Justify items": "How each item sits inside its grid cell, left to right.",
  "Align self": "Overrides Align items for this one element inside its flex or grid parent.",
  Gaps: "Space between the items inside a flex or grid box. The space around the outside is Padding.",
  "Column gap": "Space between columns.",
  Columns: "The grid's columns: how many, or their sizes. “1fr 1fr” is two equal columns.",
  Rows: "The grid's rows: how many, or their sizes.",
  "Auto flow": "Where items go when they are not placed by hand: filling rows, or filling columns. “Dense” back-fills gaps.",
  "Flex size": "How this item grows or shrinks inside a flex box.",
  Grow: "How much of the spare room this item takes inside a flex box. 0 takes none; 1 shares it out.",
  Shrink: "Whether this item may get smaller than its size when room runs out. 0 never shrinks.",
  Basis: "The item's starting size inside a flex box, before it grows or shrinks.",
  Order: "Moves the item earlier or later inside its flex or grid box without changing the page's code. Lower comes first.",
  "Custom order": "A number: lower comes first inside the flex or grid box.",

  // Size and spacing
  Margin: "Space outside the element's edge, pushing its neighbours away.",
  Padding: "Space inside the element's edge, between the border and the content.",
  "Min width": "The element never gets narrower than this.",
  "Max width": "The element never gets wider than this — useful to keep text lines readable.",
  "Min height": "The element is never shorter than this.",
  "Max height": "The element is never taller than this; anything more follows Overflow.",
  "Aspect ratio": "Keeps width and height in a fixed proportion, such as 16:9, whatever the screen size.",
  "Custom ratio": "Width / height, for example 4 / 3.",
  Overflow: "What happens when the content is bigger than the box.",
  "Overflow/Visible": "Visible: content spills out past the edge.",
  "Overflow/Hidden": "Hidden: anything past the edge is cut off.",
  "Overflow/Auto": "Auto: a scrollbar appears when the content does not fit.",
  "Object fit": "How a picture or video fills its frame. Cover fills it and crops the edges; Contain shows all of it and may leave space; Fill stretches it.",

  // Position
  Position: "Static follows the page normally. Relative nudges it from its normal place. Absolute pins it inside the nearest positioned parent. Fixed pins it to the screen. Sticky scrolls with the page until it reaches an edge, then stays.",
  "Z-index": "Stacking order when elements overlap: a higher number sits on top. Only works when Position is not Static.",
  "Anchor offset": "Space kept above this element when a link jumps to it — room for a sticky header.",

  // Typography
  "Font weight": "How thick the letters are. 400 is normal, 700 is bold.",
  "Line height": "The space each line of text takes, so how far apart the lines are.",
  "Letter spacing": "Extra space between letters.",
  "Word spacing": "Extra space between words.",
  "Text transform": "Changes capitals without retyping: UPPERCASE, lowercase, or Capitalize Each Word.",
  "Line decoration": "A line drawn under, over or through the text.",
  "Stroke width": "An outline drawn around each letter.",
  "Stroke color": "The colour of the outline around each letter.",
  "Add text stroke": "Draw an outline around each letter.",

  // Effects
  Opacity: "How see-through the element is: 100% is solid, 0% invisible (it still takes up its space).",
  "Border radius": "How rounded the corners are.",
  "Box shadow": "A shadow drawn around the element's box.",
  Spread: "How far the shadow grows beyond the element before it starts to fade.",
  "Shadow position": "Outside the box, or inside it (inset) like a pressed-in edge.",
  "Blend mode": "How the element's colours mix with what is behind it, like layer modes in a photo editor.",
  Filters: "Effects on the element itself: blur, brightness, contrast, greyscale and so on.",
  "Backdrop filters": "Effects on whatever is behind the element, such as a frosted-glass blur. Needs a see-through background to show.",
  Clipping: "Where the background stops: under the border, inside the padding, or only behind the content.",
  Transform: "Move, rotate, scale or slant the element. The layout around it does not move.",
  "Transform settings": "Where it turns from and how deep 3D effects look.",
  Perspective: "How strong 3D effects look. Smaller numbers feel closer and more dramatic.",
  "Perspective origin X": "Where the viewer looks from for 3D effects, left to right.",
  "Perspective origin Y": "Where the viewer looks from for 3D effects, top to bottom.",
  "Origin X": "The point the element rotates and scales around, left to right.",
  "Origin Y": "The point the element rotates and scales around, top to bottom.",
  "Origin Z": "The point the element rotates around, towards or away from you.",
  Transitions: "Lets changes — a hover colour, say — fade smoothly instead of switching at once.",
  "Transition type": "Which changes animate smoothly.",

  // Background
  "Layer attachment": "Scroll moves the picture with the page. Fixed keeps it still while the page scrolls over it.",
  "Layer size": "Cover fills the area and crops; Contain shows the whole picture.",
  "Layer repeat": "Whether a small picture is tiled to fill the area.",
  Overlay: "A colour laid over the background picture, often to make text on it easier to read.",

  // Interactions
  Trigger: "What starts the animation: scrolling it into view, hovering, clicking, or always.",
  "Trigger on": "What starts the animation: scrolling it into view, hovering, clicking, or always.",
  Easing: "The speed curve: steady, or easing in and out so it feels natural.",
  Delay: "How long to wait before it starts.",
  Duration: "How long it takes.",
  "Relative to": "Viewport measures from the visible screen; Page measures from the top of the whole page.",
  "Parallax strength": "How much slower or faster this moves than the page as you scroll.",
  "Visible on": "Which screen sizes show this element. Hidden ones stay in the page, only not shown.",

  // Settings
  "HTML tag": "What the element is in the page's code — h1, p, section… It matters to search engines and screen readers.",
  ID: "A unique name for this element. A link to #name jumps straight to it.",
  Preload: "How much of the video the browser downloads before anyone presses play. None saves data; Auto starts faster.",
  "Button style": "Styles your site's designer already made for buttons. Each one swaps the button's look; None removes the style. Hover one to see it.",
};

export function editorTip(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(EDITOR_TIPS, key) ? EDITOR_TIPS[key] : undefined;
}
