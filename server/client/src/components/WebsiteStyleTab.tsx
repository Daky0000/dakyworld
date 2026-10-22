import { useEffect, useRef, useState } from "react";
import { ColorCodeInput, parseStyle, writeStyle } from "./InspectorControls";
import { ImagePositionControl } from "./ImagePositionControl";
import { SHADOW_PRESETS } from "./InspectorDesign";
import {
  Buttons, ColourProp, ICON, Linked, More, Num, NumberProp, Pick, Repeater, Select, SizeField, StyleSection,
  allowedAt, originOf, readable, useTyped, writeProperty, type Choice, type Device, type StyleCtx,
} from "./StyleControls";
import {
  FILTERS, TRANSITION_GROUPS, filterSummary, layerSummary, readBackground, readFilters, readGradient, readShadows, readTransforms,
  readTransitions, shadowSummary, transformSummary, writeBackground, writeFilters, writeGradient, writeShadows, writeTransforms,
  writeTransitions, type BackgroundLayer, type FilterItem, type Gradient, type Shadow, type TransformItem,
} from "../lib/websiteStyleValues";

/**
 * The Style tab: the same nine sections for every element, in the order the
 * page builder this follows uses — Layout, Spacing, Size, Position, Typography,
 * Background, Border, Effects and Custom CSS.
 *
 * It used to be tailored per element, so a heading was never offered an image
 * fit. Dan asked on 11 Oct 2026 for one panel that is the same everywhere, the
 * way Elementor's is: a control that does not apply simply has no effect, and
 * typography on a container is inherited by the words inside it, which is
 * useful. What still depends on the element is only what has to — the flex
 * controls appear once it is a flex container, the flex-child section once its
 * parent is one, and the offsets once it is positioned.
 *
 * Every control writes one inline declaration on the selected element, routed
 * by the editor to the desktop style or to the tablet/phone override. A field
 * left blank is the website's own value, which is shown as the placeholder.
 */

export type StyleFacts = { kind: string; tag: string; display: string; parentDisplay: string; position: string };

type Props = {
  style: string;
  /** What the page's HTML says at this screen size, for the dots. */
  sourceStyle: string;
  /** What a wider screen hands down; empty on desktop. */
  inheritedStyle: string;
  computed: Record<string, string>;
  facts: StyleFacts;
  device: Device;
  fonts?: string[];
  readOnly: boolean;
  /** Designer controls: Custom CSS is shown only then. */
  designer: boolean;
  onChange: (style: string, commit?: boolean) => void;
  onCommit: () => void;
  /** Opens the media library; the chosen address is handed to `apply`. */
  onPickImage?: (apply: (url: string) => void) => void;
  resolveImage?: (url: string) => string;
  /** The element can carry a background video the publish can store (an Elementor container). */
  videoBackground?: boolean;
};

const SIDE_NAMES = ["Top", "Right", "Bottom", "Left"];
const SIDES = ["top", "right", "bottom", "left"];
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];

const isFlex = (display: string) => /(?:^|-)flex$/.test(display.trim());
const isGrid = (display: string) => /(?:^|-)grid$/.test(display.trim());

export function WebsiteStyleTab(props: Props) {
  const { style, sourceStyle, inheritedStyle, computed, facts, device, readOnly, designer, onChange, onCommit } = props;
  const raw = parseStyle(style);
  const c: StyleCtx = {
    map: readable(raw),
    raw,
    source: readable(parseStyle(sourceStyle)),
    inherited: readable(parseStyle(inheritedStyle)),
    computed,
    device,
    readOnly,
    set: (property, value, commit) => onChange(writeStyle(writeProperty(raw, property, value)), commit),
    setMany: (patch, commit) => {
      let next = raw;
      for (const [property, value] of Object.entries(patch)) next = writeProperty(next, property, value);
      onChange(writeStyle(next), commit);
    },
    commit: onCommit,
  };
  const changed = (properties: string[]) => originOf(c, properties) === "changed";
  const effective = (property: string) => (c.map[property] ?? c.inherited[property] ?? computed[property] ?? "").trim();

  return (
    <fieldset disabled={readOnly} className="dx-style">
      {/* No line naming the screen size: the device switch in the bar says it
          (removed on purpose 12 Oct 2026). What earns a line is something to
          act on — overrides that only this screen size has, and a way to drop them. */}
      {device !== "desktop" && Object.keys(raw).length > 0 && (
        <div className="dx-fl dx-overrides">
          <span className="dx-hint">{Object.keys(raw).length} {Object.keys(raw).length === 1 ? "change" : "changes"} for {device === "tablet" ? "tablets" : "phones"} only</span>
          <button type="button" className="dx-rs" aria-label={`Reset ${device} overrides`} onClick={() => onChange("", true)}>Reset</button>
        </div>
      )}
      <LayoutSection c={c} facts={facts} effective={effective} changed={changed} />
      <SpacingSection c={c} changed={changed} />
      <SizeSection c={c} facts={facts} changed={changed} />
      <PositionSection c={c} effective={effective} changed={changed} />
      <TypographySection c={c} facts={facts} fonts={props.fonts ?? []} effective={effective} changed={changed} />
      <BackgroundSection c={c} changed={changed} onPickImage={props.onPickImage} resolveImage={props.resolveImage} videoBackground={props.videoBackground} />
      <BorderSection c={c} effective={effective} changed={changed} />
      <EffectsSection c={c} changed={changed} />
      {designer && <CustomCssSection c={c} onChange={onChange} />}
    </fieldset>
  );
}

type SectionProps = { c: StyleCtx; changed: (properties: string[]) => boolean };

/* ---------------------------------------------------------------- layout */

const DISPLAY_BUTTONS: Choice[] = [
  { value: "block", label: "Block" },
  { value: "flex", label: "Flex" },
  { value: "inline-block", label: "In-blk" },
  { value: "inline-flex", label: "In-flx" },
];
const DISPLAY_MORE: Choice[] = [
  { value: "grid", label: "Grid" },
  { value: "inline-grid", label: "Inline grid" },
  { value: "inline", label: "Inline" },
  { value: "flow-root", label: "Flow root" },
  { value: "none", label: "None (hidden)" },
];
const DIRECTIONS: Choice[] = [
  { value: "row", label: "Row", icon: ICON.arrowRight },
  { value: "column", label: "Column", icon: ICON.arrowDown },
  { value: "row-reverse", label: "Reversed row", icon: ICON.arrowLeft },
  { value: "column-reverse", label: "Reversed column", icon: ICON.arrowUp },
];
const JUSTIFY: Choice[] = [
  { value: "flex-start", label: "Start", icon: ICON.justifyStart },
  { value: "center", label: "Center", icon: ICON.justifyCenter },
  { value: "flex-end", label: "End", icon: ICON.justifyEnd },
  { value: "space-between", label: "Space between", icon: ICON.justifyBetween },
  { value: "space-around", label: "Space around", icon: ICON.justifyAround },
  { value: "space-evenly", label: "Space evenly", icon: ICON.justifyEvenly },
];
const ALIGN: Choice[] = [
  { value: "flex-start", label: "Start", icon: ICON.alignStart },
  { value: "center", label: "Center", icon: ICON.alignCenter },
  { value: "flex-end", label: "End", icon: ICON.alignEnd },
  { value: "stretch", label: "Stretch", icon: ICON.alignStretch },
];
const WRAPS: Choice[] = [
  { value: "nowrap", label: "No wrap", icon: ICON.wrapNo },
  { value: "wrap", label: "Wrap", icon: ICON.wrap },
  { value: "wrap-reverse", label: "Reversed wrap", icon: ICON.wrapReverse },
];
const ALIGN_CONTENT: Choice[] = ["flex-start", "center", "flex-end", "space-between", "space-around", "stretch"].map((value) => ({
  value,
  label: { "flex-start": "Start", center: "Center", "flex-end": "End", "space-between": "Space between", "space-around": "Space around", stretch: "Stretch" }[value]!,
}));
const GRID_ALIGN: Choice[] = [
  { value: "start", label: "Start", icon: ICON.alignStart },
  { value: "center", label: "Center", icon: ICON.alignCenter },
  { value: "end", label: "End", icon: ICON.alignEnd },
  { value: "stretch", label: "Stretch", icon: ICON.alignStretch },
];

function LayoutSection({ c, facts, effective, changed }: SectionProps & { facts: StyleFacts; effective: (property: string) => string }) {
  const display = effective("display") || facts.display || "block";
  const parent = facts.parentDisplay ?? "";
  const own = c.map.display;
  const more = own && DISPLAY_MORE.some((option) => option.value === own) ? own : "";
  const wraps = ["wrap", "wrap-reverse"].includes(effective("flex-wrap"));
  const props = ["display", "flex-direction", "justify-content", "align-items", "align-content", "flex-wrap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-auto-flow", "justify-items", "align-self", "order", "flex-grow", "flex-shrink", "flex-basis", "grid-column", "grid-row"];
  return (
    <StyleSection name="layout" title="Layout" open={facts.kind === "container"} changed={changed(props)} summary={DISPLAY_BUTTONS.concat(DISPLAY_MORE).find((option) => option.value === display)?.label ?? display}>
      <div className="dx-f">
        <Buttons c={c} label="Display" property="display" options={DISPLAY_BUTTONS} />
        <select
          className="dx-more-sel"
          aria-label="More display options"
          disabled={c.readOnly}
          value={more}
          onChange={(event) => c.set("display", event.target.value || null, true)}
        >
          <option value="">More…</option>
          {DISPLAY_MORE.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      {isFlex(display) && (
        <>
          <Buttons c={c} label="Direction" property="flex-direction" options={DIRECTIONS} />
          <Buttons c={c} label="Justify content" property="justify-content" options={JUSTIFY} />
          <Buttons c={c} label="Align items" property="align-items" options={ALIGN} />
          <Linked c={c} label="Gaps" props={["column-gap", "row-gap"]} names={["Column", "Row"]} units={["px", "%", "em", "rem", "vw", "vh"]} min={0} linkTitle="Link column and row gaps" />
          <Buttons c={c} label="Wrap" property="flex-wrap" options={WRAPS} />
          {wraps && <Select c={c} label="Align content" property="align-content" options={ALIGN_CONTENT} />}
        </>
      )}

      {isGrid(display) && (
        <>
          <GridTracks c={c} label="Columns" property="grid-template-columns" />
          <GridTracks c={c} label="Rows" property="grid-template-rows" />
          <Linked c={c} label="Gaps" props={["column-gap", "row-gap"]} names={["Column", "Row"]} units={["px", "%", "em", "rem", "vw", "vh"]} min={0} linkTitle="Link column and row gaps" />
          <Buttons c={c} label="Justify items" property="justify-items" options={GRID_ALIGN} />
          <Buttons c={c} label="Align items" property="align-items" options={GRID_ALIGN} />
          <Select c={c} label="Auto flow" property="grid-auto-flow" options={[{ value: "row", label: "Row" }, { value: "column", label: "Column" }, { value: "row dense", label: "Row, dense" }, { value: "column dense", label: "Column, dense" }]} />
        </>
      )}

      {isFlex(parent) && <FlexChild c={c} />}

      {isGrid(parent) && (
        <>
          <div className="dx-sub">Grid child</div>
          <TextProp c={c} label="Column" property="grid-column" placeholder="span 2" />
          <TextProp c={c} label="Row" property="grid-row" placeholder="span 1" />
          <Buttons c={c} label="Align self" property="align-self" options={GRID_ALIGN} />
        </>
      )}
    </StyleSection>
  );
}

function FlexChild({ c }: { c: StyleCtx }) {
  const order = c.map.order;
  const orderMode = order === "-9999" ? "first" : order === "9999" ? "last" : order !== undefined ? "custom" : "";
  const [customOrder, setCustomOrder] = useState(orderMode === "custom");
  const grow = c.map["flex-grow"];
  const shrink = c.map["flex-shrink"];
  const sizeMode = grow === undefined && shrink === undefined && c.map["flex-basis"] === undefined ? "" : grow === "1" && shrink === "1" && c.map["flex-basis"] === undefined ? "grow" : grow === "0" && shrink === "1" && c.map["flex-basis"] === undefined ? "shrink" : "custom";
  const [customSize, setCustomSize] = useState(sizeMode === "custom");
  return (
    <>
      <div className="dx-sub">Flex child</div>
      <Buttons c={c} label="Align self" property="align-self" options={ALIGN} />
      <Buttons
        c={c}
        label="Order"
        property="order"
        value={customOrder ? "custom" : orderMode || undefined}
        options={[{ value: "first", label: "First" }, { value: "last", label: "Last" }, { value: "custom", label: "Custom" }]}
        write={(next) => {
          setCustomOrder(next === "custom");
          if (next === "first") c.set("order", "-9999", true);
          else if (next === "last") c.set("order", "9999", true);
          else if (next === null) c.set("order", null, true);
        }}
      />
      {(customOrder || orderMode === "custom") && <NumberProp c={c} label="Custom order" property="order" />}
      <Buttons
        c={c}
        label="Flex size"
        property="flex-grow"
        value={customSize ? "custom" : sizeMode || undefined}
        options={[{ value: "grow", label: "Grow" }, { value: "shrink", label: "Shrink" }, { value: "custom", label: "Custom" }]}
        write={(next) => {
          setCustomSize(next === "custom");
          if (next === "grow") c.setMany({ "flex-grow": "1", "flex-shrink": "1", "flex-basis": null, flex: null }, true);
          else if (next === "shrink") c.setMany({ "flex-grow": "0", "flex-shrink": "1", "flex-basis": null, flex: null }, true);
          else if (next === null) c.setMany({ "flex-grow": null, "flex-shrink": null, "flex-basis": null, flex: null }, true);
        }}
      />
      {(customSize || sizeMode === "custom") && (
        <div className="dx-g3">
          <NumberProp c={c} label="Grow" property="flex-grow" min={0} />
          <NumberProp c={c} label="Shrink" property="flex-shrink" min={0} />
          <SizeField c={c} label="Basis" property="flex-basis" units={["px", "%", "em", "rem", "vw"]} />
        </div>
      )}
    </>
  );
}

/** A free value — a grid line, a track list — typed as CSS, and written once the box is left. */
function TextProp({ c, label, property, placeholder }: { c: StyleCtx; label: string; property: string; placeholder?: string }) {
  const box = useTyped(c.map[property] ?? "", (raw) => c.set(property, raw.trim() || null), c.commit);
  return (
    <div className="dx-f">
      <div className="dx-fl"><label>{label}</label></div>
      <div className="dx-inp">
        <input type="text" aria-label={label} disabled={c.readOnly} placeholder={c.computed[property] && c.computed[property] !== "auto" ? c.computed[property] : placeholder} {...box} />
      </div>
    </div>
  );
}

/** Columns or rows: a number makes that many equal tracks, anything else is written as typed. */
function GridTracks({ c, label, property }: { c: StyleCtx; label: string; property: string }) {
  const current = c.map[property] ?? "";
  const equal = /^repeat\(\s*(\d+)\s*,\s*(?:minmax\(0,\s*1fr\)|1fr)\s*\)$/.exec(current);
  const rendered = (c.computed[property] ?? "").trim();
  const count = rendered && rendered !== "none" ? rendered.split(/\s+(?![^(]*\))/).length : 0;
  const box = useTyped(
    equal ? equal[1]! : current,
    (raw) => {
      const typed = raw.trim();
      if (!typed) return c.set(property, null);
      c.set(property, /^\d+$/.test(typed) ? `repeat(${Math.max(1, Math.min(24, Number(typed)))}, minmax(0, 1fr))` : typed);
    },
    c.commit,
  );
  return (
    <div className="dx-f">
      <div className="dx-fl"><label>{label}</label><span className="dx-hint">{equal ? "equal" : current ? "custom" : count ? `${count} now` : ""}</span></div>
      <div className="dx-inp">
        <input type="text" aria-label={label} disabled={c.readOnly} placeholder={count ? String(count) : "1"} {...box} />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- spacing */

function SpacingSection({ c, changed }: SectionProps) {
  const margin = SIDES.map((side) => `margin-${side}`);
  const padding = SIDES.map((side) => `padding-${side}`);
  const px = (property: string) => Math.round(Number.parseFloat(c.map[property] ?? c.computed[property] ?? "0") || 0);
  return (
    <StyleSection name="spacing" title="Spacing" open={false} changed={changed([...margin, ...padding])} summary={`${px("margin-top")} · ${px("padding-top")}`}>
      <Linked c={c} label="Margin" props={margin} names={SIDE_NAMES} units={["px", "%", "em", "rem", "vw", "vh"]} linkTitle="Link margin" />
      <Linked c={c} label="Padding" props={padding} names={SIDE_NAMES} units={["px", "%", "em", "rem", "vw", "vh"]} min={0} linkTitle="Link padding" />
    </StyleSection>
  );
}

/* ------------------------------------------------------------------ size */

const RATIOS = ["1/1", "4/3", "3/4", "16/9", "9/16", "3/2", "2/3"];

function SizeSection({ c, facts, changed }: SectionProps & { facts: StyleFacts }) {
  const props = ["width", "height", "min-width", "min-height", "max-width", "max-height", "overflow", "aspect-ratio", "object-fit", "object-position"];
  const ratio = (c.map["aspect-ratio"] ?? "").replace(/\s+/g, "");
  const customRatio = ratio && ratio !== "auto" && !RATIOS.includes(ratio);
  const media = facts.kind === "image" || ["img", "video", "picture", "iframe", "svg"].includes(facts.tag);
  const units = ["px", "%", "em", "rem", "vw", "vh", "ch"];
  return (
    <StyleSection name="size" title="Size" open={media} changed={changed(props)} summary={c.map.width ?? (c.computed.width ? `${Math.round(Number.parseFloat(c.computed.width))}px` : "Auto")}>
      <div className="dx-g2">
        <SizeField c={c} label="Width" property="width" units={units} min={0} />
        <SizeField c={c} label="Height" property="height" units={units} min={0} />
        <SizeField c={c} label="Min width" property="min-width" units={units} min={0} />
        <SizeField c={c} label="Min height" property="min-height" units={units} min={0} />
        <SizeField c={c} label="Max width" property="max-width" units={units} min={0} />
        <SizeField c={c} label="Max height" property="max-height" units={units} min={0} />
      </div>
      <Buttons c={c} label="Overflow" property="overflow" options={[{ value: "visible", label: "Visible" }, { value: "hidden", label: "Hidden" }, { value: "auto", label: "Auto" }]} />
      <More name={media ? "size-media" : "size"} defaultOpen={media}>
        <Select
          c={c}
          label="Aspect ratio"
          property="aspect-ratio"
          value={customRatio ? "custom" : ratio}
          options={[{ value: "auto", label: "Auto" }, ...RATIOS.map((value) => ({ value, label: value })), { value: "custom", label: "Custom" }]}
          write={(next) => c.set("aspect-ratio", next === "custom" ? c.map["aspect-ratio"] && customRatio ? c.map["aspect-ratio"]! : "5 / 4" : next, true)}
        />
        {customRatio && <TextProp c={c} label="Custom ratio" property="aspect-ratio" placeholder="5 / 4" />}
        <Select c={c} label="Object fit" property="object-fit" options={[{ value: "fill", label: "Fill" }, { value: "cover", label: "Cover" }, { value: "contain", label: "Contain" }, { value: "none", label: "None" }, { value: "scale-down", label: "Scale down" }]} />
        <ImagePositionControl value={c.map["object-position"] ?? c.computed["object-position"]} device={c.device} disabled={c.readOnly} onChange={(next) => c.set("object-position", next || null)} onCommit={c.commit} />
      </More>
    </StyleSection>
  );
}

/* -------------------------------------------------------------- position */

function PositionSection({ c, effective, changed }: SectionProps & { effective: (property: string) => string }) {
  const position = effective("position") || "static";
  const props = ["position", "top", "right", "bottom", "left", "z-index", "scroll-margin-top"];
  return (
    <StyleSection name="position" title="Position" open={position !== "static"} changed={changed(props)} summary={position}>
      <Select c={c} label="Position" property="position" options={[{ value: "static", label: "Static" }, { value: "relative", label: "Relative" }, { value: "absolute", label: "Absolute" }, { value: "fixed", label: "Fixed" }, { value: "sticky", label: "Sticky" }]} />
      {position !== "static" && (
        <div className="dx-g2">
          {SIDES.map((side, index) => <SizeField key={side} c={c} label={SIDE_NAMES[index]!} aria={`${SIDE_NAMES[index]} offset`} property={side} units={["px", "%", "em", "rem", "vw", "vh"]} />)}
        </div>
      )}
      <NumberProp c={c} label="Z-index" property="z-index" />
      <SizeField c={c} label="Anchor offset" property="scroll-margin-top" units={["px", "em", "rem", "vh"]} />
      <p className="dx-hint">Anchor offset is the space kept above this element when a link jumps to it — room for a sticky header.</p>
    </StyleSection>
  );
}

/* ------------------------------------------------------------ typography */

const WEIGHTS: Choice[] = [
  ["100", "100 Thin"], ["200", "200 Extra light"], ["300", "300 Light"], ["400", "400 Normal"], ["500", "500 Medium"],
  ["600", "600 Semi bold"], ["700", "700 Bold"], ["800", "800 Extra bold"], ["900", "900 Black"],
].map(([value, label]) => ({ value: value!, label: label! }));
const SYSTEM_FONTS: Choice[] = [
  { value: "system-ui, sans-serif", label: "System sans" },
  { value: "Georgia, serif", label: "Georgia (serif)" },
  { value: "ui-monospace, monospace", label: "Monospace" },
];
const TEXT_ALIGN: Choice[] = [
  { value: "start", label: "Align start", icon: ICON.textLeft },
  { value: "center", label: "Align center", icon: ICON.textCenter },
  { value: "end", label: "Align end", icon: ICON.textRight },
  { value: "justify", label: "Justify", icon: ICON.textJustify },
];

const fontCss = (name: string) => (/[\s]/.test(name) && !/[,"']/.test(name) ? `"${name}"` : name);
const firstFamily = (value: string) => (value.split(",")[0] ?? "").replace(/["']/g, "").trim();

function TypographySection({ c, facts, fonts, effective, changed }: SectionProps & { facts: StyleFacts; fonts: string[]; effective: (property: string) => string }) {
  const props = ["font-family", "font-weight", "font-size", "text-align", "color", "line-height", "letter-spacing", "word-spacing", "column-count", "column-gap", "text-decoration", "text-decoration-line", "text-transform", "direction", "font-style", "-webkit-text-stroke"];
  const family = c.map["font-family"];
  const siteFonts: Choice[] = Array.from(new Set([...fonts, firstFamily(effective("font-family"))].filter(Boolean))).map((name) => ({ value: fontCss(name), label: name }));
  const align = c.map["text-align"];
  const decoration = (c.map["text-decoration-line"] ?? c.map["text-decoration"] ?? "").split(/\s+/).find((part) => ["none", "underline", "line-through", "overline"].includes(part));
  const columns = Number(c.map["column-count"] ?? 0);
  const stroke = c.map["-webkit-text-stroke"];
  const strokeParts = /^(-?\d*\.?\d+)px\s+(.+)$/.exec(stroke ?? "");
  const text = facts.kind !== "image" && facts.kind !== "container" && facts.kind !== "icon";
  return (
    <StyleSection name="typography" title="Typography" open={text} changed={changed(props)} summary={`${firstFamily(effective("font-family")) || "Font"} · ${Math.round(Number.parseFloat(effective("font-size")) || 0)}px`}>
      <Select
        c={c}
        label="Font family"
        property="font-family"
        value={family ?? ""}
        options={[{ group: "This website", options: siteFonts }, { group: "System", options: SYSTEM_FONTS }]}
        placeholder={`Default (${firstFamily(c.inherited["font-family"] ?? c.computed["font-family"] ?? "") || "inherited"})`}
      />
      <Select c={c} label="Font weight" property="font-weight" options={WEIGHTS} />
      <SizeField c={c} label="Font size" property="font-size" units={["px", "em", "rem", "vw", "%"]} min={0} />
      <Buttons c={c} label="Text align" property="text-align" value={align === "left" ? "start" : align === "right" ? "end" : align} options={TEXT_ALIGN} />
      <ColourProp c={c} label="Text color" property="color" />
      <More name="typography">
        <SizeField c={c} label="Line height" property="line-height" units={["", "px", "em", "rem", "%"]} min={0} />
        <SizeField c={c} label="Letter spacing" property="letter-spacing" units={["px", "em", "rem"]} />
        <SizeField c={c} label="Word spacing" property="word-spacing" units={["px", "em", "rem"]} />
        <NumberProp c={c} label="Columns" property="column-count" min={1} max={12} />
        {columns > 1 && <SizeField c={c} label="Column gap" property="column-gap" units={["px", "em", "rem", "%"]} min={0} />}
        <Buttons
          c={c}
          label="Line decoration"
          property="text-decoration"
          value={decoration}
          options={[{ value: "none", label: "None", icon: ICON.none }, { value: "underline", label: "Underline", icon: <u>U</u> }, { value: "line-through", label: "Line-through", icon: <s>S</s> }, { value: "overline", label: "Overline", icon: <span style={{ textDecoration: "overline" }}>O</span> }]}
          write={(next) => c.setMany({ "text-decoration": next, "text-decoration-line": null }, true)}
        />
        <Buttons c={c} label="Text transform" property="text-transform" options={[{ value: "none", label: "None", icon: ICON.none }, { value: "capitalize", label: "Capitalize", icon: <span>Aa</span> }, { value: "uppercase", label: "Uppercase", icon: <span>AA</span> }, { value: "lowercase", label: "Lowercase", icon: <span>aa</span> }]} />
        <Buttons c={c} label="Direction" property="direction" options={[{ value: "ltr", label: "Left to right", icon: <span>LTR</span> }, { value: "rtl", label: "Right to left", icon: <span>RTL</span> }]} />
        <Buttons c={c} label="Font style" property="font-style" options={[{ value: "normal", label: "Normal", icon: <span>N</span> }, { value: "italic", label: "Italic", icon: <i>I</i> }]} />
        <div className="dx-f" title={allowedAt(c.device, "-webkit-text-stroke") ? undefined : "Set on Desktop: this one can't change by screen size."}>
          <div className="dx-fl">
            <label>Text stroke</label>
            {!stroke && <button type="button" className="dx-add" aria-label="Add text stroke" disabled={c.readOnly || !allowedAt(c.device, "-webkit-text-stroke")} onClick={() => c.set("-webkit-text-stroke", "1px #000000", true)}>+</button>}
            {stroke && <button type="button" className="dx-rs" disabled={c.readOnly} onClick={() => c.set("-webkit-text-stroke", null, true)}>Remove</button>}
          </div>
          {stroke && (
            <div className="dx-g2">
              <Num label="Stroke width" unit="px" value={strokeParts ? Number(strokeParts[1]) : 1} min={0} onChange={(next) => c.set("-webkit-text-stroke", `${next}px ${strokeParts?.[2] ?? "#000000"}`)} onCommit={c.commit} disabled={c.readOnly} />
              <ColorCodeInput label="Stroke color" className="dx-cbtn" value={strokeParts?.[2] ?? "#000000"} disabled={c.readOnly} onChange={(next) => c.set("-webkit-text-stroke", `${strokeParts?.[1] ?? 1}px ${next || "#000000"}`)} onCommit={c.commit} />
            </div>
          )}
        </div>
      </More>
    </StyleSection>
  );
}

/* ------------------------------------------------------------ background */

const POSITIONS = ["center center", "center left", "center right", "top center", "top left", "top right", "bottom center", "bottom left", "bottom right"];
const titleCase = (value: string) => value.replace(/\b\w/g, (letter) => letter.toUpperCase());

/** The browser's own defaults, which say nothing about a background and are left out of a copy. */
const BACKGROUND_DEFAULTS: Record<string, string> = { "background-size": "auto", "background-position": "0% 0%", "background-repeat": "repeat", "background-attachment": "scroll" };

/**
 * The background the page really shows, when the element's own style sets
 * none: a page builder's or a framework's stylesheet draws it. Read from the
 * frame, so it is what the visitor sees — a picture, a gradient, both.
 */
function siteBackground(c: StyleCtx): BackgroundLayer[] | null {
  const image = c.computed["background-image"] ?? "";
  if (!image || image === "none" || c.computed["--dw-site-bg-source"] === "img") return null;
  const map: Record<string, string> = { "background-image": image };
  for (const [property, fallback] of Object.entries(BACKGROUND_DEFAULTS)) {
    const value = c.computed[property];
    if (value && value !== fallback && c.computed["--dw-site-bg-source"] === "self") map[property] = value;
  }
  return readBackground(map)?.layers ?? null;
}

function BackgroundSection({ c, changed, onPickImage, resolveImage, videoBackground }: SectionProps & { onPickImage?: (apply: (url: string) => void) => void; resolveImage?: (url: string) => string; videoBackground?: boolean }) {
  const read = readBackground(c.raw);
  const layers = read?.layers ?? null;
  const color = read?.color ?? c.map["background-color"] ?? "";
  const ownBackground = Boolean(layers?.length || c.map.background || c.map["background-image"]);
  const fromSite = !ownBackground ? siteBackground(c) : null;
  const video = c.map["--dw-bg-video"] ?? "";
  const siteVideo = c.computed["--dw-site-bg-video"] ?? "";
  const [videoDraft, setVideoDraft] = useState(video);
  const [videoProblem, setVideoProblem] = useState<string | null>(null);
  const saveVideo = () => {
    const next = videoDraft.trim();
    if (next && !/^https:\/\/\S+$/.test(next) && !/^\/?assets\/dw\/\S+$/.test(next)) { setVideoProblem("Use an https:// address — a video file, YouTube or Vimeo."); return; }
    setVideoProblem(null);
    if (next !== video) c.set("--dw-bg-video", next || null, true);
  };
  const write = (next: BackgroundLayer[], nextColor = color, commit = true) => c.setMany(writeBackground(next, nextColor), commit);
  const clip = c.map["background-clip"] ?? "";
  const props = ["background", "background-image", "background-color", "background-position", "background-size", "background-repeat", "background-attachment", "background-clip"];
  const imagesHere = allowedAt(c.device, "background-image", "url(x)");
  const swap = (from: number, to: number) => {
    if (!layers) return;
    const next = [...layers];
    [next[from], next[to]] = [next[to]!, next[from]!];
    write(next);
  };
  return (
    <StyleSection name="background" title="Background" open={false} changed={changed([...props, "--dw-bg-video"])} summary={video || siteVideo ? "Video" : layers?.length ? `${layers.length} layer${layers.length === 1 ? "" : "s"}` : fromSite?.length ? `${fromSite.length} from the website` : color || "None"}>
      {fromSite && fromSite.length > 0 && (
        <div className="dx-f">
          <div className="dx-fl"><label>On this website</label></div>
          {fromSite.map((layer, index) => (
            <div key={index} className="dx-crow">
              <span
                className="block h-8 w-12 shrink-0 rounded-md border border-white/10 bg-cover bg-center"
                aria-hidden="true"
                style={layer.kind === "image" ? { backgroundImage: `url("${layer.url.replace(/"/g, "")}")` } : layer.kind === "gradient" ? { backgroundImage: writeGradient(layer.gradient) } : { backgroundColor: layer.color }}
              />
              <span className="min-w-0 flex-1 truncate" title={layer.kind === "image" ? layer.url : undefined}>{layerSummary(layer)}</span>
            </div>
          ))}
          <p className="dx-hint">Drawn by the site's own styling{c.computed["--dw-site-bg-source"] === "inside" ? ", on a layer inside this element" : ""}. Edit copies it here, where you can change the picture, the gradient or their order.</p>
          <button type="button" className="dx-btn dx-soft" disabled={c.readOnly} onClick={() => write(fromSite, color)}>Edit this background</button>
        </div>
      )}
      <Repeater<BackgroundLayer>
        label="Overlay"
        items={layers}
        summary={layerSummary}
        unreadable={c.map.background ?? c.map["background-image"]}
        onClear={() => write([], color)}
        disabled={c.readOnly}
        addLabel="Add background layer"
        onAdd={() => write([{ kind: "color", color: "rgba(0,0,0,0.2)", position: "", size: "", repeat: "", attachment: "" }, ...(layers ?? [])])}
        onRemove={(index) => layers && write(layers.filter((_, at) => at !== index))}
        onMove={(index, by) => swap(index, index + by)}
        editor={(layer, index) => (
          <LayerEditor
            layer={layer}
            readOnly={c.readOnly}
            imagesHere={imagesHere}
            onPickImage={onPickImage}
            resolveImage={resolveImage}
            onChange={(next, commit = true) => layers && write(layers.map((each, at) => (at === index ? next : each)), color, commit)}
            onCommit={c.commit}
          />
        )}
      />
      {(videoBackground || video) && c.device === "desktop" && (
        <div className="dx-f">
          <div className="dx-fl"><label>Video</label></div>
          <input
            type="url"
            aria-label="Background video address"
            className="dx-inp"
            value={videoDraft}
            placeholder={siteVideo || "None — paste a video, YouTube or Vimeo address"}
            disabled={c.readOnly}
            onChange={(event) => setVideoDraft(event.target.value)}
            onBlur={saveVideo}
            onKeyDown={(event) => { if (event.key === "Enter") saveVideo(); }}
          />
          {videoProblem && <p className="dx-err">{videoProblem}</p>}
          <p className="dx-hint">Plays behind this container, muted and looping. The pictures above show while it loads{siteVideo && !video ? "; the current video is shown as the placeholder" : ""}.</p>
        </div>
      )}
      {!videoBackground && !video && siteVideo && (
        <p className="dx-hint">This background is a video element inside the block. Select the video itself to change its file.</p>
      )}
      {!imagesHere && <p className="dx-hint">Pictures are set on Desktop. A colour or gradient layer added here replaces the Desktop layers on this screen size rather than sitting on top of them.</p>}
      <div className="dx-f">
        <div className="dx-fl"><label>Color</label></div>
        <ColorCodeInput label="Background color" className="dx-cbtn" value={color} placeholder={c.computed["background-color"] && c.computed["background-color"] !== "rgba(0, 0, 0, 0)" ? c.computed["background-color"] : "None"} disabled={c.readOnly} onChange={(next) => layers ? write(layers, next, false) : c.set("background-color", next || null)} onCommit={c.commit} />
      </div>
      <Select
        c={c}
        label="Clipping"
        property="background-clip"
        value={clip}
        options={[{ value: "border-box", label: "Full element" }, { value: "padding-box", label: "Padding edges" }, { value: "content-box", label: "Content edges" }, ...(allowedAt(c.device, "-webkit-background-clip", "text") ? [{ value: "text", label: "Text" }] : [])]}
        write={(next) => {
          if (next === "text") c.setMany({ "background-clip": "text", "-webkit-background-clip": "text", "-webkit-text-fill-color": "transparent" }, true);
          else c.setMany({ "background-clip": next, "-webkit-background-clip": null, "-webkit-text-fill-color": null }, true);
        }}
      />
    </StyleSection>
  );
}

function LayerEditor({
  layer,
  readOnly,
  imagesHere,
  onPickImage,
  resolveImage,
  onChange,
  onCommit,
}: {
  layer: BackgroundLayer;
  readOnly: boolean;
  imagesHere: boolean;
  onPickImage?: (apply: (url: string) => void) => void;
  resolveImage?: (url: string) => string;
  onChange: (next: BackgroundLayer, commit?: boolean) => void;
  onCommit: () => void;
}) {
  const [tab, setTab] = useState<BackgroundLayer["kind"]>(layer.kind);
  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const base = { position: layer.position, size: layer.size, repeat: layer.repeat, attachment: layer.attachment };
  const gradient: Gradient = layer.kind === "gradient" ? layer.gradient : { type: "linear", angle: 180, position: "center", stops: [{ color: layer.kind === "color" ? layer.color : "#3157FF", at: 0 }, { color: "#B8FF3D", at: 100 }] };
  return (
    <div className="dx-stack">
      <Pick<BackgroundLayer["kind"]>
        label="Layer type"
        value={tab}
        options={[{ value: "image", label: "Image" }, { value: "gradient", label: "Gradient" }, { value: "color", label: "Color" }]}
        onChange={(next) => {
          setTab(next);
          if (next === "gradient" && layer.kind !== "gradient") onChange({ ...base, kind: "gradient", gradient });
          if (next === "color" && layer.kind !== "color") onChange({ ...base, kind: "color", color: layer.kind === "gradient" ? layer.gradient.stops[0]?.color ?? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.2)" });
        }}
        disabled={readOnly}
      />
      {tab === "image" && (
        <>
          {!imagesHere && <p className="dx-hint">Choose pictures on Desktop.</p>}
          {layer.kind === "image" && layer.url && <div className="dx-thumb" style={{ backgroundImage: `url("${(resolveImage ? resolveImage(layer.url) : layer.url).replace(/"/g, "")}")` }} />}
          <div className="dx-g2">
            <button type="button" className="dx-btn dx-soft" disabled={readOnly || !imagesHere || !onPickImage} onClick={() => onPickImage?.((url) => onChange({ ...base, kind: "image", url, size: base.size || "cover", position: base.position || "center center", repeat: base.repeat || "no-repeat" }))}>
              {layer.kind === "image" ? "Replace image" : "Choose image"}
            </button>
          </div>
          <div className="dx-f">
            <div className="dx-fl"><label>Image URL</label></div>
            <div className="dx-inp">
              <input
                type="text"
                aria-label="Layer image URL"
                disabled={readOnly || !imagesHere}
                defaultValue={layer.kind === "image" ? layer.url : ""}
                key={layer.kind === "image" ? layer.url : "none"}
                placeholder="/assets/… or https://…"
                onBlur={(event) => {
                  const url = event.target.value.trim().replace(/['"\\]/g, "");
                  if (!url || (layer.kind === "image" && url === layer.url)) return setUrlProblem(null);
                  // The same test the server applies; anything else it would drop without a word.
                  if (!/^(?:https:\/\/|\/(?!\/))[^\s()]+$/i.test(url)) return setUrlProblem("Use an https address, or a path on this website starting with /.");
                  setUrlProblem(null);
                  onChange({ ...base, kind: "image", url, size: base.size || "cover", position: base.position || "center center", repeat: base.repeat || "no-repeat" });
                }}
              />
            </div>
            {urlProblem && <span className="dx-err" role="alert">{urlProblem}</span>}
          </div>
          {layer.kind === "image" && <ImageLayerFields layer={layer} readOnly={readOnly} onChange={onChange} />}
        </>
      )}
      {tab === "gradient" && layer.kind === "gradient" && <GradientEditor gradient={layer.gradient} readOnly={readOnly} onChange={(next, commit) => onChange({ ...base, kind: "gradient", gradient: next }, commit)} onCommit={onCommit} />}
      {tab === "color" && layer.kind === "color" && (
        <div className="dx-f">
          <div className="dx-fl"><label>Overlay color</label></div>
          <ColorCodeInput label="Overlay color" className="dx-cbtn" value={layer.color} disabled={readOnly} onChange={(next) => next && onChange({ ...base, kind: "color", color: next }, false)} onCommit={onCommit} />
        </div>
      )}
    </div>
  );
}

function ImageLayerFields({ layer, readOnly, onChange }: { layer: BackgroundLayer & { kind: "image" }; readOnly: boolean; onChange: (next: BackgroundLayer, commit?: boolean) => void }) {
  const position = layer.position.trim();
  const preset = POSITIONS.includes(position) ? position : position === "center" || !position ? "center center" : "custom";
  const xy = /^(-?\d*\.?\d+)%\s+(-?\d*\.?\d+)%$/.exec(position);
  const size = layer.size.trim();
  const sizeMode = !size || size === "auto" ? "auto" : size === "cover" || size === "contain" ? size : "custom";
  const [w, h] = sizeMode === "custom" ? size.split(/\s+/) : ["", ""];
  return (
    <>
      <div className="dx-f">
        <div className="dx-fl"><label>Position</label></div>
        <select aria-label="Layer position" disabled={readOnly} value={preset} onChange={(event) => onChange({ ...layer, position: event.target.value === "custom" ? "50% 50%" : event.target.value })}>
          {POSITIONS.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
          <option value="custom">Custom</option>
        </select>
      </div>
      {preset === "custom" && (
        <div className="dx-g2">
          <Num label="X" unit="%" min={0} max={100} value={xy ? Number(xy[1]) : 50} onChange={(next) => onChange({ ...layer, position: `${next}% ${xy ? xy[2] : 50}%` }, false)} disabled={readOnly} />
          <Num label="Y" unit="%" min={0} max={100} value={xy ? Number(xy[2]) : 50} onChange={(next) => onChange({ ...layer, position: `${xy ? xy[1] : 50}% ${next}%` }, false)} disabled={readOnly} />
        </div>
      )}
      <div className="dx-f">
        <div className="dx-fl"><label>Repeat</label></div>
        <Pick label="Layer repeat" value={layer.repeat || "repeat"} options={[{ value: "repeat", label: "Repeat" }, { value: "repeat-x", label: "X" }, { value: "repeat-y", label: "Y" }, { value: "no-repeat", label: "None" }]} onChange={(next) => onChange({ ...layer, repeat: next })} disabled={readOnly} />
      </div>
      <div className="dx-f">
        <div className="dx-fl"><label>Size</label></div>
        <Pick label="Layer size" value={sizeMode} options={[{ value: "auto", label: "Auto" }, { value: "cover", label: "Cover" }, { value: "contain", label: "Contain" }, { value: "custom", label: "Custom" }]} onChange={(next) => onChange({ ...layer, size: next === "custom" ? "50% auto" : next === "auto" ? "" : next })} disabled={readOnly} />
      </div>
      {sizeMode === "custom" && (
        <div className="dx-g2">
          <div className="dx-f"><div className="dx-fl"><label>Width</label></div><div className="dx-inp"><input type="text" aria-label="Layer width" disabled={readOnly} defaultValue={w} key={`w${w}`} onBlur={(event) => onChange({ ...layer, size: `${event.target.value.trim() || "auto"} ${h || "auto"}` })} /></div></div>
          <div className="dx-f"><div className="dx-fl"><label>Height</label></div><div className="dx-inp"><input type="text" aria-label="Layer height" disabled={readOnly} defaultValue={h} key={`h${h}`} onBlur={(event) => onChange({ ...layer, size: `${w || "auto"} ${event.target.value.trim() || "auto"}` })} /></div></div>
        </div>
      )}
      <div className="dx-f">
        <div className="dx-fl"><label>Attachment</label></div>
        <Pick label="Layer attachment" value={layer.attachment === "fixed" ? "fixed" : "scroll"} options={[{ value: "fixed", label: "Fixed" }, { value: "scroll", label: "Scroll" }]} onChange={(next) => onChange({ ...layer, attachment: next === "scroll" ? "" : next })} disabled={readOnly} />
      </div>
    </>
  );
}

/**
 * A gradient as a bar of colour stops: drag a stop along the bar, click it to
 * edit its colour and place, flip reverses them.
 */
function GradientEditor({ gradient, readOnly, onChange, onCommit }: { gradient: Gradient; readOnly: boolean; onChange: (next: Gradient, commit?: boolean) => void; onCommit: () => void }) {
  const [selected, setSelected] = useState(0);
  const bar = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<number | null>(null);
  const stop = gradient.stops[Math.min(selected, gradient.stops.length - 1)]!;
  const index = Math.min(selected, gradient.stops.length - 1);
  const update = (patch: Partial<typeof stop>, commit = false) => onChange({ ...gradient, stops: gradient.stops.map((each, at) => (at === index ? { ...each, ...patch } : each)) }, commit);
  const at = (clientX: number) => {
    const box = bar.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * 100);
  };
  return (
    <div className="dx-stack">
      <div
        ref={bar}
        className="dx-gbar"
        style={{ background: writeGradient({ ...gradient, type: "linear", angle: 90 }) }}
        onPointerDown={(event) => {
          if (readOnly || event.target !== event.currentTarget) return;
          // A click on the bar itself adds a stop there.
          const position = at(event.clientX);
          const next = [...gradient.stops, { color: stop.color, at: position }];
          onChange({ ...gradient, stops: next }, true);
          setSelected(next.length - 1);
        }}
      >
        {gradient.stops.map((each, stopIndex) => (
          <button
            key={stopIndex}
            type="button"
            className="dx-gstop"
            aria-label={`Colour stop ${stopIndex + 1} at ${each.at}%`}
            aria-pressed={stopIndex === index}
            disabled={readOnly}
            style={{ left: `${each.at}%`, background: each.color }}
            onPointerDown={(event) => {
              event.stopPropagation();
              setSelected(stopIndex);
              dragging.current = stopIndex;
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (dragging.current !== stopIndex) return;
              onChange({ ...gradient, stops: gradient.stops.map((candidate, at2) => (at2 === stopIndex ? { ...candidate, at: at(event.clientX) } : candidate)) }, false);
            }}
            onPointerUp={() => {
              if (dragging.current !== null) onCommit();
              dragging.current = null;
            }}
          />
        ))}
      </div>
      <div className="dx-g2">
        <div className="dx-f">
          <div className="dx-fl"><label>Color</label></div>
          <ColorCodeInput label="Stop color" className="dx-cbtn" value={stop.color} disabled={readOnly} onChange={(next) => next && update({ color: next })} onCommit={onCommit} />
        </div>
        <Num label="Stop" unit="%" min={0} max={100} value={stop.at} onChange={(next) => update({ at: next })} onCommit={onCommit} disabled={readOnly} />
      </div>
      <div className="dx-g2">
        <button type="button" className="dx-btn dx-ghost" disabled={readOnly} onClick={() => onChange({ ...gradient, stops: gradient.stops.map((each) => ({ ...each, at: 100 - each.at })) }, true)}>Flip</button>
        <button type="button" className="dx-btn dx-ghost" disabled={readOnly || gradient.stops.length <= 2} onClick={() => { onChange({ ...gradient, stops: gradient.stops.filter((_, at2) => at2 !== index) }, true); setSelected(0); }}>Remove stop</button>
      </div>
      <div className="dx-f">
        <div className="dx-fl"><label>Type</label></div>
        <Pick label="Gradient type" value={gradient.type} options={[{ value: "linear", label: "Linear" }, { value: "radial", label: "Radial" }]} onChange={(next) => onChange({ ...gradient, type: next }, true)} disabled={readOnly} />
      </div>
      {gradient.type === "linear" ? (
        <Num label="Angle" unit="°" value={gradient.angle} onChange={(next) => onChange({ ...gradient, angle: next }, false)} onCommit={onCommit} disabled={readOnly} />
      ) : (
        <div className="dx-f">
          <div className="dx-fl"><label>Position</label></div>
          <select aria-label="Gradient position" disabled={readOnly} value={POSITIONS.includes(gradient.position) ? gradient.position : gradient.position === "center" ? "center center" : gradient.position} onChange={(event) => onChange({ ...gradient, position: event.target.value }, true)}>
            {!POSITIONS.includes(gradient.position) && gradient.position !== "center" && <option value={gradient.position}>{gradient.position}</option>}
            {POSITIONS.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- border */

const BORDER_TYPES: Choice[] = ["none", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"].map((value) => ({ value, label: titleCase(value) }));

function BorderSection({ c, effective, changed }: SectionProps & { effective: (property: string) => string }) {
  const widths = SIDES.map((side) => `border-${side}-width`);
  const corners = CORNERS.map((corner) => `border-${corner}-radius`);
  // A width with no line style draws nothing, so giving a border a width
  // gives it a solid line too unless one is already chosen.
  const styleShown = c.map["border-style"] ?? c.map["border-top-style"] ?? effective("border-top-style");
  const bordered: StyleCtx = {
    ...c,
    set: (property, value, commit) => bordered.setMany({ [property]: value }, commit),
    setMany: (patch, commit) => {
      const widening = Object.entries(patch).some(([property, value]) => widths.includes(property) && value && Number.parseFloat(value) > 0);
      c.setMany(widening && (!styleShown || styleShown === "none") ? { ...patch, "border-style": "solid" } : patch, commit);
    },
  };
  const props = [...widths, "border-color", "border-style", ...corners];
  return (
    <StyleSection name="border" title="Border" open={false} changed={changed(props)} summary={!styleShown || styleShown === "none" ? "None" : `${Math.round(Number.parseFloat(effective("border-top-width")) || 0)}px ${styleShown}`}>
      <Linked c={bordered} label="Border width" props={widths} names={SIDE_NAMES} units={["px", "em", "rem"]} min={0} linkTitle="Adjust borders" />
      <ColourProp c={c} label="Border color" property="border-color" />
      <Select c={c} label="Border type" property="border-style" options={BORDER_TYPES} />
      <Linked c={c} label="Border radius" props={corners} names={["Top left", "Top right", "Bottom right", "Bottom left"]} short={["↖", "↗", "↘", "↙"]} units={["px", "%", "em", "rem"]} min={0} linkTitle="Adjust corners" />
    </StyleSection>
  );
}

/* --------------------------------------------------------------- effects */

const BLEND: Choice[] = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "saturation", "color", "difference", "exclusion", "hue", "luminosity", "soft-light", "hard-light"].map((value) => ({ value, label: titleCase(value.replace("-", " ")) }));

function EffectsSection({ c, changed }: SectionProps) {
  const shadows = readShadows(c.map["box-shadow"]);
  const transforms = readTransforms(c.map.transform);
  const transitions = readTransitions(c.map.transition);
  const filters = readFilters(c.map.filter);
  const backdrop = readFilters(c.map["backdrop-filter"]);
  const [settings, setSettings] = useState(Boolean(c.map["transform-origin"] || c.map.perspective || c.map["perspective-origin"]));
  const props = ["mix-blend-mode", "opacity", "box-shadow", "transform", "transform-origin", "perspective", "perspective-origin", "transition", "filter", "backdrop-filter"];
  const origin = (c.map["transform-origin"] ?? "50% 50% 0px").split(/\s+/);
  const perspectiveOrigin = (c.map["perspective-origin"] ?? "50% 50%").split(/\s+/);
  const pct = (value: string | undefined, fallback: number) => (value && /%$/.test(value) ? Number.parseFloat(value) : value === "left" || value === "top" ? 0 : value === "right" || value === "bottom" ? 100 : fallback);
  return (
    <StyleSection name="effects" title="Effects" open={false} changed={changed(props)} summary={`${Math.round(Number(c.map.opacity ?? c.computed.opacity ?? 1) * 100)}%`}>
      <Select c={c} label="Blend mode" property="mix-blend-mode" options={BLEND} />
      <NumberProp c={c} label="Opacity" property="opacity" min={0} max={100} toCss={(n) => String(Math.round(n) / 100)} fromCss={(css) => String(Math.round(Number(css) * 100))} aria="Opacity" />

      <Repeater<Shadow>
        label="Box shadow"
        items={shadows}
        summary={shadowSummary}
        unreadable={c.map["box-shadow"]}
        onClear={() => c.set("box-shadow", null, true)}
        disabled={c.readOnly}
        extra={
          <select className="dx-preset" aria-label="Shadow preset" disabled={c.readOnly} value="" onChange={(event) => { const preset = SHADOW_PRESETS.find((option) => option.value === event.target.value); if (preset) c.set("box-shadow", preset.css === "none" ? null : preset.css, true); }}>
            <option value="">Presets</option>
            {SHADOW_PRESETS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        }
        onAdd={() => c.set("box-shadow", writeShadows([...(shadows ?? []), { inset: false, x: 0, y: 0, blur: 10, spread: 0, color: "rgba(0,0,0,0.5)" }]), true)}
        onRemove={(index) => shadows && c.set("box-shadow", writeShadows(shadows.filter((_, at) => at !== index)) || null, true)}
        editor={(shadow, index) => {
          const put = (patch: Partial<Shadow>, commit = false) => shadows && c.set("box-shadow", writeShadows(shadows.map((each, at) => (at === index ? { ...each, ...patch } : each))), commit);
          return (
            <div className="dx-stack">
              <div className="dx-f"><div className="dx-fl"><label>Color</label></div><ColorCodeInput label="Shadow color" className="dx-cbtn" value={shadow.color} disabled={c.readOnly} onChange={(next) => next && put({ color: next })} onCommit={c.commit} /></div>
              <Pick label="Shadow position" value={shadow.inset ? "inset" : "outset"} options={[{ value: "outset", label: "Outset" }, { value: "inset", label: "Inset" }]} onChange={(next) => put({ inset: next === "inset" }, true)} disabled={c.readOnly} />
              <div className="dx-g2">
                <Num label="Horizontal" unit="px" value={shadow.x} onChange={(next) => put({ x: next })} onCommit={c.commit} disabled={c.readOnly} />
                <Num label="Vertical" unit="px" value={shadow.y} onChange={(next) => put({ y: next })} onCommit={c.commit} disabled={c.readOnly} />
                <Num label="Blur" unit="px" min={0} value={shadow.blur} onChange={(next) => put({ blur: next })} onCommit={c.commit} disabled={c.readOnly} />
                <Num label="Spread" unit="px" value={shadow.spread} onChange={(next) => put({ spread: next })} onCommit={c.commit} disabled={c.readOnly} />
              </div>
            </div>
          );
        }}
      />

      <Repeater<TransformItem>
        label="Transform"
        items={transforms}
        summary={transformSummary}
        unreadable={c.map.transform}
        onClear={() => c.set("transform", null, true)}
        disabled={c.readOnly}
        extra={<button type="button" className="dx-ib" aria-label="Transform settings" aria-pressed={settings} title="Transform origin and children perspective" disabled={c.readOnly} onClick={() => setSettings(!settings)}>{ICON.settings}</button>}
        onAdd={() => c.set("transform", writeTransforms([...(transforms ?? []), { kind: "move", x: 0, y: 0, z: 0 }]), true)}
        onRemove={(index) => transforms && c.set("transform", writeTransforms(transforms.filter((_, at) => at !== index)) || null, true)}
        editor={(item, index) => {
          const put = (next: TransformItem, commit = false) => transforms && c.set("transform", writeTransforms(transforms.map((each, at) => (at === index ? next : each))), commit);
          const xyz = item.kind !== "skew";
          const unit = item.kind === "move" ? "px" : item.kind === "scale" ? "" : "°";
          const step = item.kind === "scale" ? 0.05 : 1;
          return (
            <div className="dx-stack">
              <Pick
                label="Transform type"
                value={item.kind}
                options={[{ value: "move", label: "Move" }, { value: "scale", label: "Scale" }, { value: "rotate", label: "Rotate" }, { value: "skew", label: "Skew" }]}
                onChange={(kind) => put(kind === "skew" ? { kind, x: 0, y: 0 } : kind === "scale" ? { kind, x: 1, y: 1, z: 1 } : { kind, x: 0, y: 0, z: 0 }, true)}
                disabled={c.readOnly}
              />
              <div className="dx-g3">
                <Num label={`${titleCase(item.kind)} X`} unit={unit} step={step} value={item.x} onChange={(x) => put({ ...item, x } as TransformItem)} onCommit={c.commit} disabled={c.readOnly} />
                <Num label={`${titleCase(item.kind)} Y`} unit={unit} step={step} value={item.y} onChange={(y) => put({ ...item, y } as TransformItem)} onCommit={c.commit} disabled={c.readOnly} />
                {xyz && <Num label={`${titleCase(item.kind)} Z`} unit={unit} step={step} value={(item as { z: number }).z} onChange={(z) => put({ ...item, z } as TransformItem)} onCommit={c.commit} disabled={c.readOnly} />}
              </div>
            </div>
          );
        }}
      />
      {settings && (
        <div className="dx-panel">
          <div className="dx-sub">Transform origin</div>
          <div className="dx-g3">
            <Num label="Origin X" unit="%" value={pct(origin[0], 50)} onChange={(x) => c.set("transform-origin", `${x}% ${pct(origin[1], 50)}% ${Number.parseFloat(origin[2] ?? "0") || 0}px`)} onCommit={c.commit} disabled={c.readOnly} />
            <Num label="Origin Y" unit="%" value={pct(origin[1], 50)} onChange={(y) => c.set("transform-origin", `${pct(origin[0], 50)}% ${y}% ${Number.parseFloat(origin[2] ?? "0") || 0}px`)} onCommit={c.commit} disabled={c.readOnly} />
            <Num label="Origin Z" unit="px" value={Number.parseFloat(origin[2] ?? "0") || 0} onChange={(z) => c.set("transform-origin", `${pct(origin[0], 50)}% ${pct(origin[1], 50)}% ${z}px`)} onCommit={c.commit} disabled={c.readOnly} />
          </div>
          <div className="dx-sub">Children perspective</div>
          <div className="dx-g3">
            <Num label="Perspective" unit="px" min={0} value={Number.parseFloat(c.map.perspective ?? "0") || 0} onChange={(p) => c.set("perspective", p ? `${p}px` : null)} onCommit={c.commit} disabled={c.readOnly} />
            <Num label="Perspective origin X" unit="%" value={pct(perspectiveOrigin[0], 50)} onChange={(x) => c.set("perspective-origin", `${x}% ${pct(perspectiveOrigin[1], 50)}%`)} onCommit={c.commit} disabled={c.readOnly} />
            <Num label="Perspective origin Y" unit="%" value={pct(perspectiveOrigin[1], 50)} onChange={(y) => c.set("perspective-origin", `${pct(perspectiveOrigin[0], 50)}% ${y}%`)} onCommit={c.commit} disabled={c.readOnly} />
          </div>
          <button type="button" className="dx-rs" disabled={c.readOnly} onClick={() => c.setMany({ "transform-origin": null, perspective: null, "perspective-origin": null }, true)}>Reset transform settings</button>
        </div>
      )}

      <Repeater
        label="Transitions"
        items={transitions}
        summary={(item) => `${TRANSITION_GROUPS.flatMap((group) => group.properties).find((option) => option.value === item.property)?.label ?? item.property}: ${item.duration} ms`}
        unreadable={c.map.transition}
        onClear={() => c.set("transition", null, true)}
        disabled={c.readOnly}
        onAdd={() => c.set("transition", writeTransitions([...(transitions ?? []), { property: "all", duration: 200, rest: "" }]), true)}
        onRemove={(index) => transitions && c.set("transition", writeTransitions(transitions.filter((_, at) => at !== index)) || null, true)}
        editor={(item, index) => {
          const put = (patch: Partial<typeof item>, commit = false) => transitions && c.set("transition", writeTransitions(transitions.map((each, at) => (at === index ? { ...each, ...patch } : each))), commit);
          return (
            <div className="dx-stack">
              <div className="dx-f">
                <div className="dx-fl"><label>Type</label></div>
                <select aria-label="Transition type" disabled={c.readOnly} value={item.property} onChange={(event) => put({ property: event.target.value }, true)}>
                  {!TRANSITION_GROUPS.some((group) => group.properties.some((option) => option.value === item.property)) && <option value={item.property}>{item.property}</option>}
                  {TRANSITION_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.properties.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <Num label="Duration" unit="ms" min={0} step={50} value={item.duration} onChange={(duration) => put({ duration })} onCommit={c.commit} disabled={c.readOnly} />
            </div>
          );
        }}
      />

      <FilterList c={c} label="Filters" property="filter" items={filters} />
      <FilterList c={c} label="Backdrop filters" property="backdrop-filter" items={backdrop} />
    </StyleSection>
  );
}

function FilterList({ c, label, property, items }: { c: StyleCtx; label: string; property: string; items: FilterItem[] | null }) {
  return (
    <Repeater<FilterItem>
      label={label}
      items={items}
      summary={filterSummary}
      unreadable={c.map[property]}
      onClear={() => c.set(property, null, true)}
      disabled={c.readOnly}
      addLabel={`Add ${label.toLowerCase().replace(/s$/, "")}`}
      onAdd={() => c.set(property, writeFilters([...(items ?? []), { fn: "blur", value: 4 }]), true)}
      onRemove={(index) => items && c.set(property, writeFilters(items.filter((_, at) => at !== index)) || null, true)}
      editor={(item, index) => {
        const put = (next: FilterItem, commit = false) => items && c.set(property, writeFilters(items.map((each, at) => (at === index ? next : each))), commit);
        const known = FILTERS.find((filter) => filter.fn === item.fn)!;
        return (
          <div className="dx-stack">
            <div className="dx-f">
              <div className="dx-fl"><label>Type</label></div>
              <select
                aria-label={`${label} type`}
                disabled={c.readOnly}
                value={item.fn}
                onChange={(event) => {
                  const fn = event.target.value as FilterItem["fn"];
                  const chosen = FILTERS.find((filter) => filter.fn === fn)!;
                  put(fn === "drop-shadow" ? { fn, x: 2, y: 4, blur: 6, color: "rgba(0,0,0,0.4)" } : ({ fn, value: chosen.initial } as FilterItem), true);
                }}
              >
                {FILTERS.map((filter) => <option key={filter.fn} value={filter.fn}>{filter.label}</option>)}
              </select>
            </div>
            {item.fn === "drop-shadow" ? (
              <>
                <div className="dx-g3">
                  <Num label="X" unit="px" value={item.x} onChange={(x) => put({ ...item, x })} onCommit={c.commit} disabled={c.readOnly} />
                  <Num label="Y" unit="px" value={item.y} onChange={(y) => put({ ...item, y })} onCommit={c.commit} disabled={c.readOnly} />
                  <Num label="Blur" unit="px" min={0} value={item.blur} onChange={(blur) => put({ ...item, blur })} onCommit={c.commit} disabled={c.readOnly} />
                </div>
                <ColorCodeInput label="Drop shadow color" className="dx-cbtn" value={item.color} disabled={c.readOnly} onChange={(color) => color && put({ ...item, color })} onCommit={c.commit} />
              </>
            ) : (
              <div className="dx-sl">
                <div className="dx-fl"><label>{known.label}</label><span>{item.value}{known.unit === "deg" ? "°" : known.unit}</span></div>
                <input type="range" aria-label={`${known.label} amount`} min={known.min} max={known.max} value={item.value} disabled={c.readOnly} onChange={(event) => put({ ...item, value: Number(event.target.value) })} onPointerUp={c.commit} onKeyUp={c.commit} />
              </div>
            )}
          </div>
        );
      }}
    />
  );
}

/* ------------------------------------------------------------ custom CSS */

/** Every property a control above writes. Custom CSS holds everything else. */
const OWNED = new Set([
  "display", "flex-direction", "justify-content", "align-items", "align-content", "flex-wrap", "gap", "row-gap", "column-gap",
  "grid-template-columns", "grid-template-rows", "grid-auto-flow", "justify-items", "align-self", "order", "flex", "flex-grow",
  "flex-shrink", "flex-basis", "grid-column", "grid-row", "margin", "padding", ...SIDES.flatMap((side) => [`margin-${side}`, `padding-${side}`, side, `border-${side}-width`]),
  "inset", "width", "height", "min-width", "min-height", "max-width", "max-height", "overflow", "aspect-ratio", "object-fit", "object-position",
  "position", "z-index", "scroll-margin-top", "font-family", "font-weight", "font-size", "text-align", "color", "line-height", "letter-spacing",
  "word-spacing", "column-count", "text-decoration", "text-decoration-line", "text-transform", "direction", "font-style", "-webkit-text-stroke",
  "background", "background-image", "background-position", "background-size", "background-repeat", "background-attachment", "background-color",
  "background-clip", "-webkit-background-clip", "-webkit-text-fill-color", "border", "border-width", "border-color", "border-style", "border-radius",
  ...CORNERS.map((corner) => `border-${corner}-radius`), "mix-blend-mode", "opacity", "box-shadow", "transform", "transform-origin", "perspective",
  "perspective-origin", "transition", "filter", "backdrop-filter",
]);
const owned = (property: string) => OWNED.has(property) || property.startsWith("--dw-");

/** The same test the server applies, so a declaration that would be dropped is said before it is saved. */
function declarationProblem(property: string, value: string, device: Device): string | null {
  if (!/^(?:--[a-z0-9_-]{1,48}|[a-z-]{2,40})$/i.test(property)) return "not a property name";
  if (property.startsWith("--dw-")) return "reserved for the editor";
  if (/url\s*\(|expression\s*\(|javascript:|[<>`\\]/i.test(value) || (/["']/.test(value) && property !== "font-family")) return "pictures, quotes and script can't be written here";
  if (value.length > 400) return "too long";
  if (!allowedAt(device, property, value)) return "can't change by screen size";
  return null;
}

function CustomCssSection({ c, onChange }: { c: StyleCtx; onChange: (style: string, commit?: boolean) => void }) {
  const others = Object.entries(c.raw).filter(([property]) => !owned(property));
  const text = others.map(([property, value]) => `  ${property}: ${value};`).join("\n");
  const [draft, setDraft] = useState(text);
  const [dropped, setDropped] = useState<string[]>([]);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(text);
  }, [text]);
  const apply = () => {
    editing.current = false;
    const body = draft.replace(/^\s*element\.style\s*\{|\}\s*$/g, "");
    const kept: Record<string, string> = Object.fromEntries(Object.entries(c.raw).filter(([property]) => owned(property)));
    const refused: string[] = [];
    for (const line of body.split(";")) {
      const colon = line.indexOf(":");
      if (colon < 1) { if (line.trim()) refused.push(`${line.trim()} — not a declaration`); continue; }
      const property = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (!value) continue;
      if (owned(property)) { refused.push(`${property} — set it with its control above`); continue; }
      const problem = declarationProblem(property, value, c.device);
      if (problem) refused.push(`${property}: ${value} — ${problem}`);
      else kept[property] = value;
    }
    setDropped(refused);
    onChange(writeStyle(kept), true);
  };
  return (
    <StyleSection name="custom" title="Custom CSS" open={others.length > 0} changed={false} summary={others.length ? `${others.length} rule${others.length === 1 ? "" : "s"}` : ""}>
      <p className="dx-hint">Anything the controls above don't cover. Declarations apply to this element only; selectors, pictures and script are not written.</p>
      <div className="dx-code">
        <span>element.style {"{"}</span>
        <textarea
          aria-label="Custom CSS"
          spellCheck={false}
          disabled={c.readOnly}
          value={draft}
          rows={Math.max(4, draft.split("\n").length + 1)}
          placeholder="  text-shadow: 0 1px 2px #0003;"
          onChange={(event) => { editing.current = true; setDraft(event.target.value); }}
          onBlur={apply}
        />
        <span>{"}"}</span>
      </div>
      {dropped.length > 0 && (
        <div className="dx-note warn" style={{ margin: 0 }}>
          Not saved:
          <ul>{dropped.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      )}
    </StyleSection>
  );
}
