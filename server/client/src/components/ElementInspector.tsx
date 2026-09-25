import { useMemo, useState } from "react";
import { CssValueField, UnitPillSelector } from "./CssValueField";
import {
  ALIGN_ICONS, BORDER_STYLES, CASES, COLOURS, ColourField, DIRECTION_ICONS, DISPLAY_ICONS, EXTRA_LABEL, EXTRA_SEED,
  FONTS, IconChoice, IconToggle, JUSTIFY_ICONS, NumberField, PaletteContext, Row, SIDES, Section, Segmented,
  SelectField, SubBlock, WEIGHTS, expandBox, parseStyle, readShadow, readTransform, toNumber, writeStyle, type Extra,
} from "./InspectorControls";
import {
  ORIGIN_LABEL, ORIGIN_TITLE, PROPERTY_OWNER, SECTION_TITLE, elementCapabilities, inspectorSections, inspectorValue,
  isBrowserDefault, meaningfulValue, positionControls, readableValue,
  type Device, type ElementFacts, type InspectorValue, type SectionKey,
} from "../lib/elementInspector";

/**
 * One contextual inspector, in place of a layout panel and a style panel that
 * both edited the same string.
 *
 * The question this answers is "what can reasonably be changed about the thing
 * that is selected", not "which CSS properties does Dakyworld know how to
 * edit". So an image is never offered a line height, a heading is never offered
 * grid columns, flex-child controls appear only when the parent is actually a
 * flex container, and the offsets under Position appear only once the element
 * is positioned. Every property has exactly one section that owns it — see
 * `PROPERTY_OWNER`, and the check that no two visible sections can claim the
 * same one.
 *
 * Two rules run through all of it:
 *
 * **Every control shows the value that is really governing the element**, from
 * the site's own stylesheet if that is where it comes from, with a word saying
 * so. The panel this replaces showed an empty box marked "As designed" for a
 * heading the site renders at 72px, which is both less useful and less true.
 *
 * **Looking at an element never writes anything.** The effective value is
 * displayed, not stored; a control only reports a change when somebody changes
 * it. Otherwise opening a page would put a computed copy of the browser's
 * opinion of every property into the draft, and publish it.
 */

export type InspectorSource = {
  /** The element's own `style` attribute in the page's HTML, as it was read. */
  sourceStyle: string;
  /** This draft's desktop styling, when a smaller viewport is being edited. */
  baseStyle: string;
  /** What the browser says the element renders as, at the active viewport. */
  computed: Record<string, string>;
};

export function ElementInspector({
  simple = false,
  tab,
  facts,
  device,
  style,
  source,
  palette,
  fonts,
  readOnly,
  sitePublicUrl,
  resolveImagePreview,
  backgroundImageFallbackUrl,
  onChange,
  onCommit,
  onReset,
  onTextColour,
  onPickBackgroundImage,
  onSetBackgroundImageUrl,
  content,
}: {
  simple?: boolean;
  tab?: "content" | "layout" | "style";
  facts: ElementFacts;
  device: Device;
  /** The draft's declarations for the active viewport. */
  style: string | undefined;
  source: InspectorSource;
  palette?: string[];
  fonts?: string[];
  readOnly?: boolean;
  sitePublicUrl?: string;
  resolveImagePreview?: (url: string) => string;
  backgroundImageFallbackUrl?: string;
  onChange: (next: string) => void;
  /** Called when a continuous gesture ends, so history records one step. */
  onCommit?: () => void;
  /** Put the whole element back as the website has it. */
  onReset: () => void;
  /** A selected text range owns its colour before the element does. */
  onTextColour?: (colour: string) => boolean;
  /** Opens the asset library / upload dialog to set `background-image` on the selected element. */
  onPickBackgroundImage?: () => void;
  /** Optional callback when background image URL is changed so child/pseudo bg layers also sync. */
  onSetBackgroundImageUrl?: (url: string) => void;
  /** The content editor, which the page owns; drawn as the first section. */
  content?: React.ReactNode;
}) {
  const disabled = !!readOnly;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [gapsLinked, setGapsLinked] = useState(true);
  const [widthUnit, setWidthUnit] = useState<"px" | "%" | "vw">("px");
  const [minHeightUnit, setMinHeightUnit] = useState<"px" | "vh">("px");
  const [gapUnit, setGapUnit] = useState<"px" | "%" | "rem">("px");
  const [paddingUnit, setPaddingUnit] = useState<"px" | "%" | "em" | "rem">("px");
  const [marginUnit, setMarginUnit] = useState<"px" | "%" | "em" | "rem">("px");
  /**
   * Which groups are open, and only where somebody has said otherwise.
   *
   * The default is worked out rather than fixed: a group is open if it is one of
   * the few nearly every edit starts from, or if this element already has
   * something set in it. A collapsed Typography on a heading whose font the site
   * changed is a panel hiding the answer somebody opened it for.
   */
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const toggleSection = (key: SectionKey) => setOpenSections((current) => ({ ...current, [key]: !isOpen(key) }));

  const declarations = useMemo(() => expandBox(expandBox(parseStyle(style), "padding"), "margin"), [style]);
  const sourceDeclarations = useMemo(() => expandBox(expandBox(parseStyle(source.sourceStyle), "padding"), "margin"), [source.sourceStyle]);
  const baseDeclarations = useMemo(() => expandBox(expandBox(parseStyle(source.baseStyle), "padding"), "margin"), [source.baseStyle]);

  const swatches = palette?.length ? palette.map((value) => ({ label: value, value })) : COLOURS;

  // Display and position come from the draft the moment they are changed rather
  // than waiting for the frame to be re-measured, so choosing Flex reveals the
  // flex controls in the same tick that the page rearranges.
  const capabilities = elementCapabilities({
    ...facts,
    display: declarations.display ?? facts.display,
    position: declarations.position ?? facts.position,
  });

  const LAYOUT_SECTION_KEYS: SectionKey[] = [
    "layout",
    "flexContainer",
    "gridContainer",
    "flexChild",
    "gridChild",
    "size",
  ];

  const shown = new Set(
    inspectorSections(capabilities).filter((section) => {
      if (!tab) return !simple || section === "content";
      if (tab === "content") return section === "content";
      if (tab === "layout") return LAYOUT_SECTION_KEYS.includes(section);
      if (tab === "style") {
        if (facts.kind === "container") {
          return section !== "content" && !LAYOUT_SECTION_KEYS.includes(section);
        }
        return section !== "content";
      }
      return true;
    })
  );
  if ((tab === "content" || (tab === "layout" && facts.kind === "container")) && content) shown.add("content");
  if (tab === "layout" && facts.kind === "container") {
    shown.add("background");
  }
  if (tab === "style") {
    shown.add("background");
    shown.add("border");
    shown.add("spacing");
    shown.add("position");
    if (facts.kind !== "container") {
      shown.add("size");
    }
  }

  const value = (property: string): InspectorValue =>
    inspectorValue(property, {
      computed: source.computed[property],
      source: sourceDeclarations[property],
      override: declarations[property],
      base: baseDeclarations[property],
      device,
    });

  const set = (property: string, next: string) => {
    if (property === "color" && next && onTextColour?.(next)) return;
    const updated = { ...declarations };
    if (next) updated[property] = next;
    else delete updated[property];
    onChange(writeStyle(updated));
  };
  const clear = (property: string) => {
    set(property, "");
    onCommit?.();
  };

  /** Every property this section owns, so a group can say whether it carries one. */
  const sectionProperties = (section: SectionKey) =>
    Object.keys(PROPERTY_OWNER).filter((property) => {
      const owner = PROPERTY_OWNER[property]!;
      return Array.isArray(owner) ? owner.includes(section) : owner === section;
    });

  const sectionChanged = (section: SectionKey) => sectionProperties(section).some((property) => value(property).overridden);
  // Anything the panel would put a value in front of somebody for. A browser
  // default nobody chose is not a reason to open a group; the site's own 780px
  // max width is.
  const sectionHasValue = (section: SectionKey) => sectionProperties(section).some((property) => meaningfulValue(value(property)));

  /**
   * Groups that open on their own.
   *
   * Every one of these is either what somebody came to change, or a group that
   * is only drawn at all because it is relevant — a Position section exists here
   * only for an element that is positioned, so opening it shut would be hiding
   * the answer to the question that produced it.
   */
  const ALWAYS_OPEN: SectionKey[] = ["content", "image", "layout", "flexContainer", "gridContainer", "flexChild", "gridChild", "position", "typography", "background", "size", "spacing", "border"];
  const isOpen = (section: SectionKey) => openSections[section] ?? (ALWAYS_OPEN.includes(section) || sectionHasValue(section));

  /** The rail on the right of every row: where the value came from, and back. */
  const rail = (property: string) => (
    <Origin value={value(property)} palette={swatches} disabled={disabled} onReset={() => clear(property)} />
  );

  /**
   * A free CSS value — a length, a track list, an expression the site uses.
   *
   * `short` is what the row is called on screen where the full name does not fit
   * sixty-two pixels; the control keeps the full one as its accessible name, so
   * a screen reader is never handed the abbreviation.
   */
  const Text = ({ property, label, short }: { property: string; label: string; short?: string }) => (
    <Row
      label={short ?? label}
      rail={rail(property)}
      control={
        <CssValueField property={property} label={label} bare value={value(property).effective} disabled={disabled} onChange={(next) => set(property, next)} />
      }
    />
  );

  /** A fixed set of choices, always including whatever the site already uses. */
  const Choice = ({ property, label, options }: { property: string; label: string; options: string[] | { label: string; value: string }[] }) => {
    const current = value(property);
    const list = (options as (string | { label: string; value: string })[]).map((option) =>
      typeof option === "string" ? { label: option, value: option } : option,
    );
    const effective = current.effective.trim();
    if (effective && !list.some((option) => option.value === effective)) list.unshift({ label: effective, value: effective });
    // Nothing is set and nothing was measured. Without this the browser shows
    // the first option, which reads as a choice somebody made.
    if (!effective) list.unshift({ label: "As designed", value: "" });
    return (
      <Row
        label={label}
        rail={rail(property)}
        control={<SelectField label={label} bare value={effective} disabled={disabled} options={list} onChange={(next) => { set(property, next); onCommit?.(); }} />}
      />
    );
  };

  /**
   * The same, drawn.
   *
   * Only where the choices are few and each one is a picture of itself — a row
   * against a column, children pushed apart against children in the middle.
   * Anything with more options than fit stays a menu rather than becoming a
   * puzzle, and a value the site set that has no picture falls back to one too,
   * because a control that cannot show the current value is worse than a menu.
   */
  const Pictures = ({ property, label, icons, options }: { property: string; label: string; icons: Record<string, React.ReactNode>; options: string[] }) => {
    const effective = value(property).effective.trim();
    const drawable = options.filter((option) => icons[option]);
    if (effective && !drawable.includes(effective)) return <Choice property={property} label={label} options={options} />;
    return (
      <Row
        label={label}
        rail={rail(property)}
        control={
          <IconChoice
            label={label}
            value={effective}
            disabled={disabled}
            options={drawable.map((option) => ({ value: option, title: option, icon: icons[option] }))}
            onChange={(next) => {
              set(property, next);
              onCommit?.();
            }}
          />
        }
      />
    );
  };

  /**
   * Two values that belong together on one line — width and height, the two
   * gaps, a pair of offsets.
   *
   * Each keeps its own well and its own letter, and the rail says where they
   * came from once. "Mixed" is not a hedge: two halves of a pair really can come
   * from different places, and saying "Website" over a width the site set and a
   * height somebody changed would be false about half of it.
   */
  const Pair = ({ label, first, second }: { label: string; first: { property: string; label: string; prefix: string }; second: { property: string; label: string; prefix: string } }) => {
    // An empty label keeps the column, so a second pair under the first lines up
    // with it rather than shifting left by sixty-two pixels.
    const left = value(first.property);
    const right = value(second.property);
    const same = left.origin === right.origin && left.overridden === right.overridden;
    return (
      <Row
        label={label}
        rail={
          same ? (
            rail(first.property)
          ) : (
            <span
              data-origin={`${first.property}+${second.property}`}
              title={`${first.label}: ${ORIGIN_TITLE[left.origin]} ${second.label}: ${ORIGIN_TITLE[right.origin]}`}
              className={`font-sans text-[11px] uppercase tracking-[.06em] ${left.overridden || right.overridden ? "text-blue" : "text-faint"}`}
            >
              Mixed
            </span>
          )
        }
        control={
          <>
            {[first, second].map((side) => (
              <CssValueField
                key={side.property}
                property={side.property}
                label={side.label}
                prefix={side.prefix}
                bare
                value={value(side.property).effective}
                disabled={disabled}
                onChange={(next) => set(side.property, next)}
              />
            ))}
          </>
        }
      />
    );
  };

  const Colour = ({ property, label }: { property: string; label: string }) => (
    <Row
      label={label}
      rail={rail(property)}
      control={
        <ColourField
          label={label}
          bare
          value={value(property).effective}
          allowNone
          disabled={disabled}
          onChange={(next) => set(property, next)}
          onCommit={onCommit}
        />
      }
    />
  );

  const decoration = value("text-decoration").effective;
  const fontOptions = [...FONTS.filter((font) => font.value), ...(fonts ?? []).filter((face) => !FONTS.some((font) => font.value === face)).map((face) => ({ label: face, value: face }))];

  const SideField = ({ property, side, unitOverride }: { property: "padding" | "margin"; side: (typeof SIDES)[number]; unitOverride: string }) => {
    const current = value(`${property}-${side}`);
    return (
      <div className="relative min-w-0">
        <CssValueField
          property={`${property}-${side}`}
          label={`${property} ${side}`}
          bare
          unitOverride={unitOverride}
          hideUnitSelector
          value={current.effective}
          disabled={disabled}
          onChange={(next) => set(`${property}-${side}`, next)}
        />
        {current.overridden && !disabled && (
          <button
            type="button"
            aria-label={`Reset ${property}-${side}`}
            title={`Changed here. Put ${property} ${side} back to the website's own styling.`}
            onClick={() => clear(`${property}-${side}`)}
            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-blue"
          />
        )}
      </div>
    );
  };

  /**
   * Padding and margin, drawn as the box they are, with the unit selector (PX, %, EM, REM) at the top.
   */
  const box = (property: "padding" | "margin") => {
    const activeUnit = property === "padding" ? paddingUnit : marginUnit;
    const setActiveUnit = property === "padding" ? setPaddingUnit : setMarginUnit;
    return (
      <div className="pt-1">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[.06em] text-muted">{property}</span>
          <UnitPillSelector
            units={["px", "%", "em", "rem"]}
            value={activeUnit}
            disabled={disabled}
            onChange={(nextU) => {
              const u = nextU as "px" | "%" | "em" | "rem";
              setActiveUnit(u);
              const updated = { ...declarations };
              let changed = false;
              for (const s of SIDES) {
                const key = `${property}-${s}`;
                const existing = updated[key];
                if (existing) {
                  const num = toNumber(existing);
                  if (num !== null) {
                    updated[key] = `${num}${u}`;
                    changed = true;
                  }
                }
              }
              if (changed) {
                onChange(writeStyle(updated));
                onCommit?.();
              }
            }}
          />
        </div>
        <div className="grid grid-cols-[1fr_28px_1fr] items-center gap-1">
          <div />
          <SideField property={property} side="top" unitOverride={activeUnit} />
          <div />
          <SideField property={property} side="left" unitOverride={activeUnit} />
          <span aria-hidden className="mx-auto h-4 w-5 rounded border border-dashed border-line-strong" />
          <SideField property={property} side="right" unitOverride={activeUnit} />
          <div />
          <SideField property={property} side="bottom" unitOverride={activeUnit} />
          <div />
        </div>
      </div>
    );
  };

  const position = (declarations.position ?? source.computed.position ?? "static").trim();
  const { offsets, zIndex } = positionControls(position);

  // The website's own border is editable here when the browser reports one — a
  // computed shorthand only comes back when all four sides agree. `0px none` is
  // what an element with no border computes to, and is not one.
  const border = declarations.border ?? source.computed.border ?? "";
  const parsedBorder = /^(-?[\d.]+)px\s+(\w+)\s+(.+)$/.exec(border.trim());
  const borderParts = parsedBorder && Number(parsedBorder[1]) > 0 && parsedBorder[2] !== "none" ? parsedBorder : null;

  const siteShadow = !isBrowserDefault("box-shadow", source.computed["box-shadow"] ?? "") ? source.computed["box-shadow"] : "";
  const extras = (Object.keys(EXTRA_LABEL) as Extra[]).filter((key) => declarations[key] !== undefined);
  const missingExtras = (Object.keys(EXTRA_LABEL) as Extra[]).filter((key) => declarations[key] === undefined);

  // Whatever a developer wrote that no section here owns. Shown rather than
  // silently carried, so nobody wonders where their own styling went.
  const untouched = Object.entries(declarations).filter(([property]) => !PROPERTY_OWNER[property]);

  return (
    <PaletteContext.Provider value={swatches}>
      <div className={disabled ? "pointer-events-none opacity-50" : ""}>
        {shown.has("content") && content && <Section name="content" title={SECTION_TITLE.content}>{content}</Section>}

        {shown.has("image") && (
          <Section name="image" title={SECTION_TITLE.image} open={isOpen("image")} changed={sectionChanged("image")} onToggle={() => toggleSection("image")}>
            <Choice property="object-fit" label="Fit" options={["cover", "contain", "fill", "none", "scale-down"]} />
            <Text property="object-position" label="Focal point" />
          </Section>
        )}

        {tab === "layout" ? (
          <Section
            name="layout"
            title="Container"
            open={isOpen("layout")}
            changed={sectionChanged("layout") || sectionChanged("flexContainer") || sectionChanged("size")}
            onToggle={() => toggleSection("layout")}
          >
            {(() => {
              const effDisplay = (declarations.display ?? source.computed.display ?? facts.display ?? "flex").trim();
              const layoutType = effDisplay.includes("grid") ? "grid" : effDisplay.includes("flex") ? "flex" : "block";
              const rawMaxWidth = (declarations["max-width"] ?? source.computed["max-width"] ?? "").trim();
              const contentWidthMode = rawMaxWidth && rawMaxWidth !== "none" && rawMaxWidth !== "100%" ? "boxed" : "full";
              const rawWidth = (declarations.width ?? source.computed.width ?? "").trim();
              const parsedWidthNum = toNumber(rawWidth) ?? (contentWidthMode === "boxed" ? toNumber(rawMaxWidth) ?? 1140 : 100);
              const rawMinHeight = (declarations["min-height"] ?? source.computed["min-height"] ?? "").trim();
              const parsedMinHeightNum = toNumber(rawMinHeight);
              const effDirection = (declarations["flex-direction"] ?? source.computed["flex-direction"] ?? "row").trim();
              const effJustify = (declarations["justify-content"] ?? source.computed["justify-content"] ?? "flex-start").trim();
              const effAlign = (declarations["align-items"] ?? source.computed["align-items"] ?? "stretch").trim();
              const effWrap = (declarations["flex-wrap"] ?? source.computed["flex-wrap"] ?? "nowrap").trim();
              const colGapNum = toNumber(declarations["column-gap"] ?? declarations.gap ?? source.computed["column-gap"] ?? "");
              const rowGapNum = toNumber(declarations["row-gap"] ?? declarations.gap ?? source.computed["row-gap"] ?? "");

              return (
                <div className="space-y-3.5 py-1">
                  {/* Container Layout */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-ink-2">Container Layout</span>
                    <select
                      disabled={disabled}
                      value={layoutType}
                      onChange={(e) => {
                        set("display", e.target.value);
                        onCommit?.();
                      }}
                      className="h-7 w-36 rounded-lg border border-line bg-white px-2 text-[11px] font-medium text-ink outline-none focus:border-blue"
                    >
                      <option value="flex">Flexbox</option>
                      <option value="grid">Grid</option>
                      <option value="block">Block</option>
                    </select>
                  </div>

                  {/* Content Width */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-ink-2">Content Width</span>
                    <select
                      disabled={disabled}
                      value={contentWidthMode}
                      onChange={(e) => {
                        const updated = { ...declarations };
                        if (e.target.value === "boxed") {
                          updated["max-width"] = "1140px";
                          updated["margin-left"] = "auto";
                          updated["margin-right"] = "auto";
                        } else {
                          updated["max-width"] = "100%";
                          updated.width = "100%";
                        }
                        onChange(writeStyle(updated));
                        onCommit?.();
                      }}
                      className="h-7 w-36 rounded-lg border border-line bg-white px-2 text-[11px] font-medium text-ink outline-none focus:border-blue"
                    >
                      <option value="boxed">Boxed</option>
                      <option value="full">Full Width</option>
                    </select>
                  </div>

                  {/* Width slider + input */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-ink-2">Width</span>
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-muted">
                        {(["px", "%", "vw"] as const).map((u) => (
                          <button
                            key={u}
                            type="button"
                            onClick={() => setWidthUnit(u)}
                            className={`rounded px-1 py-0.5 uppercase transition ${
                              widthUnit === u ? "bg-blue/10 text-blue" : "hover:text-ink"
                            }`}
                          >
                            {u}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <input
                        type="range"
                        disabled={disabled}
                        min={widthUnit === "px" ? 200 : 10}
                        max={widthUnit === "px" ? 1600 : 100}
                        value={Math.min(widthUnit === "px" ? 1600 : 100, Math.max(0, Math.round(parsedWidthNum)))}
                        onChange={(e) => {
                          const val = `${e.target.value}${widthUnit}`;
                          if (contentWidthMode === "boxed" && widthUnit === "px") {
                            set("max-width", val);
                          } else {
                            set("width", val);
                          }
                        }}
                        onMouseUp={() => onCommit?.()}
                        className="h-1 flex-1 cursor-pointer accent-blue"
                      />
                      <input
                        type="number"
                        disabled={disabled}
                        value={Math.round(parsedWidthNum) || ""}
                        placeholder="Auto"
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          if (!raw) {
                            set("width", "");
                          } else {
                            const val = `${raw}${widthUnit}`;
                            if (contentWidthMode === "boxed" && widthUnit === "px") {
                              set("max-width", val);
                            } else {
                              set("width", val);
                            }
                          }
                        }}
                        onBlur={() => onCommit?.()}
                        className="h-7 w-16 rounded-lg border border-line bg-white px-2 text-right font-mono text-[11px] text-ink outline-none focus:border-blue"
                      />
                    </div>
                  </div>

                  {/* Min Height slider + input */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-ink-2">Min Height</span>
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-muted">
                        {(["px", "vh"] as const).map((u) => (
                          <button
                            key={u}
                            type="button"
                            onClick={() => setMinHeightUnit(u)}
                            className={`rounded px-1 py-0.5 uppercase transition ${
                              minHeightUnit === u ? "bg-blue/10 text-blue" : "hover:text-ink"
                            }`}
                          >
                            {u}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <input
                        type="range"
                        disabled={disabled}
                        min={0}
                        max={minHeightUnit === "vh" ? 100 : 1000}
                        value={Math.min(minHeightUnit === "vh" ? 100 : 1000, Math.max(0, Math.round(parsedMinHeightNum ?? 0)))}
                        onChange={(e) => set("min-height", `${e.target.value}${minHeightUnit}`)}
                        onMouseUp={() => onCommit?.()}
                        className="h-1 flex-1 cursor-pointer accent-blue"
                      />
                      <input
                        type="number"
                        disabled={disabled}
                        value={parsedMinHeightNum !== null ? Math.round(parsedMinHeightNum) : ""}
                        placeholder="0"
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          set("min-height", raw ? `${raw}${minHeightUnit}` : "");
                        }}
                        onBlur={() => onCommit?.()}
                        className="h-7 w-16 rounded-lg border border-line bg-white px-2 text-right font-mono text-[11px] text-ink outline-none focus:border-blue"
                      />
                    </div>
                    <p className="text-[10px] italic text-muted">To achieve full height Container use 100vh.</p>
                  </div>

                  {/* Items section */}
                  <div className="border-t border-line pt-3">
                    <div className="mb-2.5 text-[11px] font-bold text-ink">Items</div>

                    {/* Direction */}
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-ink-2">Direction</span>
                      <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-line bg-white">
                        {([
                          { value: "row", label: "→", title: "Row (horizontal)" },
                          { value: "column", label: "↓", title: "Column (vertical)" },
                          { value: "row-reverse", label: "←", title: "Row reversed" },
                          { value: "column-reverse", label: "↑", title: "Column reversed" },
                        ] as const).map((item) => {
                          const active = effDirection === item.value;
                          return (
                            <button
                              key={item.value}
                              type="button"
                              disabled={disabled}
                              title={item.title}
                              onClick={() => {
                                const updated = { ...declarations, display: layoutType === "block" ? "flex" : effDisplay, "flex-direction": item.value };
                                onChange(writeStyle(updated));
                                onCommit?.();
                              }}
                              className={`flex h-7 w-8 items-center justify-center border-r border-line last:border-r-0 text-xs font-semibold transition ${
                                active ? "bg-ink text-white" : "text-ink-2 hover:bg-sunken"
                              }`}
                            >
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Justify Content */}
                    <div className="mb-3 space-y-1.5">
                      <span className="block text-[11px] font-medium text-ink-2">Justify Content</span>
                      <div className="grid grid-cols-6 overflow-hidden rounded-lg border border-line bg-white">
                        {(["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"] as const).map((val) => {
                          const active = effJustify === val;
                          return (
                            <button
                              key={val}
                              type="button"
                              disabled={disabled}
                              title={val}
                              onClick={() => {
                                const updated = { ...declarations, display: layoutType === "block" ? "flex" : effDisplay, "justify-content": val };
                                onChange(writeStyle(updated));
                                onCommit?.();
                              }}
                              className={`flex h-7 items-center justify-center border-r border-line last:border-r-0 transition ${
                                active ? "bg-ink text-white" : "text-ink-2 hover:bg-sunken"
                              }`}
                            >
                              {JUSTIFY_ICONS[val]}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Align Items */}
                    <div className="mb-3 space-y-1.5">
                      <span className="block text-[11px] font-medium text-ink-2">Align Items</span>
                      <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-line bg-white">
                        {(["flex-start", "center", "flex-end", "stretch"] as const).map((val) => {
                          const active = effAlign === val;
                          return (
                            <button
                              key={val}
                              type="button"
                              disabled={disabled}
                              title={val}
                              onClick={() => {
                                const updated = { ...declarations, display: layoutType === "block" ? "flex" : effDisplay, "align-items": val };
                                onChange(writeStyle(updated));
                                onCommit?.();
                              }}
                              className={`flex h-7 items-center justify-center border-r border-line last:border-r-0 transition ${
                                active ? "bg-ink text-white" : "text-ink-2 hover:bg-sunken"
                              }`}
                            >
                              {ALIGN_ICONS[val]}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Gaps */}
                    <div className="mb-3 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-ink-2">Gaps</span>
                        <UnitPillSelector
                          units={["px", "%", "rem"]}
                          value={gapUnit}
                          disabled={disabled}
                          onChange={(nextU) => {
                            const u = nextU as "px" | "%" | "rem";
                            setGapUnit(u);
                            const updated = { ...declarations };
                            if (colGapNum !== null) updated["column-gap"] = `${colGapNum}${u}`;
                            if (rowGapNum !== null) updated["row-gap"] = `${rowGapNum}${u}`;
                            onChange(writeStyle(updated));
                            onCommit?.();
                          }}
                        />
                      </div>
                      <div className="flex items-start gap-1.5">
                        <div className="flex-1">
                          <input
                            type="number"
                            disabled={disabled}
                            min={0}
                            value={colGapNum !== null ? Math.round(colGapNum) : ""}
                            placeholder="0"
                            onChange={(e) => {
                              const raw = e.target.value.trim();
                              const val = raw ? `${raw}${gapUnit}` : "";
                              const updated = { ...declarations };
                              if (val) updated["column-gap"] = val;
                              else delete updated["column-gap"];
                              if (gapsLinked) {
                                if (val) updated["row-gap"] = val;
                                else delete updated["row-gap"];
                              }
                              onChange(writeStyle(updated));
                            }}
                            onBlur={() => onCommit?.()}
                            className="h-7 w-full rounded-l-lg border border-line bg-white px-2 text-center font-mono text-[11px] text-ink outline-none focus:border-blue"
                          />
                          <span className="mt-0.5 block text-center text-[10px] text-muted">Column</span>
                        </div>
                        <div className="flex-1">
                          <input
                            type="number"
                            disabled={disabled}
                            min={0}
                            value={rowGapNum !== null ? Math.round(rowGapNum) : ""}
                            placeholder="0"
                            onChange={(e) => {
                              const raw = e.target.value.trim();
                              const val = raw ? `${raw}${gapUnit}` : "";
                              const updated = { ...declarations };
                              if (val) updated["row-gap"] = val;
                              else delete updated["row-gap"];
                              if (gapsLinked) {
                                if (val) updated["column-gap"] = val;
                                else delete updated["column-gap"];
                              }
                              onChange(writeStyle(updated));
                            }}
                            onBlur={() => onCommit?.()}
                            className="h-7 w-full border-y border-r border-line bg-white px-2 text-center font-mono text-[11px] text-ink outline-none focus:border-blue"
                          />
                          <span className="mt-0.5 block text-center text-[10px] text-muted">Row</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setGapsLinked((prev) => !prev)}
                          title={gapsLinked ? "Unlink Column & Row gaps" : "Link Column & Row gaps"}
                          className={`flex h-7 w-8 items-center justify-center rounded-r-lg border border-line text-xs transition ${
                            gapsLinked ? "bg-ink text-white" : "bg-white text-muted hover:text-ink"
                          }`}
                        >
                          🔗
                        </button>
                      </div>
                    </div>

                    {/* Wrap */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-ink-2">Wrap</span>
                        <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-white">
                          {([
                            { value: "nowrap", label: "No Wrap", icon: "|→" },
                            { value: "wrap", label: "Wrap", icon: "|↩" },
                          ] as const).map((item) => {
                            const active = effWrap === item.value;
                            return (
                              <button
                                key={item.value}
                                type="button"
                                disabled={disabled}
                                title={item.label}
                                onClick={() => {
                                  const updated = { ...declarations, display: layoutType === "block" ? "flex" : effDisplay, "flex-wrap": item.value };
                                  onChange(writeStyle(updated));
                                  onCommit?.();
                                }}
                                className={`flex h-7 w-12 items-center justify-center border-r border-line last:border-r-0 text-[11px] font-semibold transition ${
                                  active ? "bg-ink text-white" : "text-ink-2 hover:bg-sunken"
                                }`}
                              >
                                {item.icon}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <p className="text-[10px] italic leading-relaxed text-muted">
                        Items within the container can stay in a single line (No wrap), or break into multiple lines (Wrap).
                      </p>
                    </div>

                    {layoutType === "grid" && (
                      <div className="mt-3 space-y-2 border-t border-line pt-2.5">
                        <Text property="grid-template-columns" label="Columns" />
                        <Text property="grid-template-rows" label="Rows" />
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </Section>
        ) : (
          <>
            {shown.has("layout") && (
              <Section name="layout" title={SECTION_TITLE.layout} open={isOpen("layout")} changed={sectionChanged("layout")} onToggle={() => toggleSection("layout")}>
                <Pictures property="display" label="Display" icons={DISPLAY_ICONS} options={["block", "flex", "grid", "inline-block", "none"]} />
              </Section>
            )}

            {shown.has("flexContainer") && (
              <Section name="flexContainer" title={SECTION_TITLE.flexContainer} open={isOpen("flexContainer")} changed={sectionChanged("flexContainer")} onToggle={() => toggleSection("flexContainer")}>
                <Pictures property="flex-direction" label="Direction" icons={DIRECTION_ICONS} options={["row", "column", "row-reverse", "column-reverse"]} />
                <Choice property="flex-wrap" label="Wrap" options={["nowrap", "wrap", "wrap-reverse"]} />
                <Pictures property="justify-content" label="Spread" icons={JUSTIFY_ICONS} options={["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"]} />
                <Pictures property="align-items" label="Align" icons={ALIGN_ICONS} options={["stretch", "flex-start", "center", "flex-end", "baseline"]} />
                <Pair label="Gap" first={{ property: "row-gap", label: "Row gap", prefix: "R" }} second={{ property: "column-gap", label: "Column gap", prefix: "C" }} />
              </Section>
            )}

            {shown.has("gridContainer") && (
              <Section name="gridContainer" title={SECTION_TITLE.gridContainer} open={isOpen("gridContainer")} changed={sectionChanged("gridContainer")} onToggle={() => toggleSection("gridContainer")}>
                <Text property="grid-template-columns" label="Columns" />
                <Text property="grid-template-rows" label="Rows" />
                <Choice property="justify-content" label="Spread" options={["start", "center", "end", "space-between", "space-around", "space-evenly"]} />
                <Choice property="align-items" label="Align" options={["stretch", "start", "center", "end", "baseline"]} />
                <div className="grid grid-cols-2 gap-1.5">
                  <Text property="row-gap" label="Row gap" />
                  <Text property="column-gap" label="Column gap" />
                </div>
              </Section>
            )}

            {shown.has("size") && (
              <Section name="size" title={SECTION_TITLE.size} open={isOpen("size")} changed={sectionChanged("size")} onToggle={() => toggleSection("size")}>
                <Pair label="Size" first={{ property: "width", label: "Width", prefix: "W" }} second={{ property: "height", label: "Height", prefix: "H" }} />
                <Text property="max-width" label="Max width" />
              </Section>
            )}
          </>
        )}

        {shown.has("flexChild") && (
          <Section name="flexChild" title={SECTION_TITLE.flexChild} open={isOpen("flexChild")} changed={sectionChanged("flexChild")} onToggle={() => toggleSection("flexChild")}>
            <Choice property="align-self" label="Align self" options={["auto", "stretch", "flex-start", "center", "flex-end", "baseline"]} />
            <Pair label="Grow" first={{ property: "flex-grow", label: "Grow", prefix: "G" }} second={{ property: "flex-shrink", label: "Shrink", prefix: "S" }} />
          </Section>
        )}

        {shown.has("gridChild") && (
          <Section name="gridChild" title={SECTION_TITLE.gridChild} open={isOpen("gridChild")} changed={sectionChanged("gridChild")} onToggle={() => toggleSection("gridChild")}>
            <Text property="grid-column" label="Column" />
            <Text property="grid-row" label="Row" />
            <Choice property="align-self" label="Align self" options={["auto", "stretch", "start", "center", "end", "baseline"]} />
          </Section>
        )}

        {shown.has("spacing") && (
          <Section name="spacing" title={SECTION_TITLE.spacing} open={isOpen("spacing")} changed={sectionChanged("spacing")} onToggle={() => toggleSection("spacing")}>
            {box("padding")}
            {box("margin")}
          </Section>
        )}

        {shown.has("typography") && (
          <Section name="typography" title={SECTION_TITLE.typography} open={isOpen("typography")} changed={sectionChanged("typography")} onToggle={() => toggleSection("typography")}>
            <Choice property="font-family" label="Font" options={fontOptions} />
            <Text property="font-size" label="Size" />
            <Colour property="color" label="Colour" />
            <Choice property="font-weight" label="Weight" options={WEIGHTS.filter((weight) => weight.value)} />

            <Row
              label="Style"
              control={
                <div className="flex flex-1 gap-1">
              <IconToggle
                on={value("font-style").effective === "italic"}
                title="Italic"
                disabled={disabled}
                onClick={() => {
                  set("font-style", value("font-style").effective === "italic" ? "normal" : "italic");
                  onCommit?.();
                }}
              >
                <span className="font-serif italic">I</span>
              </IconToggle>
              <IconToggle
                on={decoration.includes("underline")}
                title="Underline"
                disabled={disabled}
                onClick={() => {
                  set("text-decoration", decoration.includes("underline") ? decoration.replace("underline", "").trim() || "none" : `${decoration.replace("none", "")} underline`.trim());
                  onCommit?.();
                }}
              >
                <span className="font-serif underline">U</span>
              </IconToggle>
              <IconToggle
                on={decoration.includes("line-through")}
                title="Strikethrough"
                disabled={disabled}
                onClick={() => {
                  set(
                    "text-decoration",
                    decoration.includes("line-through") ? decoration.replace("line-through", "").trim() || "none" : `${decoration.replace("none", "")} line-through`.trim(),
                  );
                  onCommit?.();
                }}
              >
                <span className="font-serif line-through">S</span>
              </IconToggle>
                  <div className="flex-1" />
                </div>
              }
            />

            <Row
              label="Align"
              rail={rail("text-align")}
              control={
                <Segmented
                  value={value("text-align").effective}
                  disabled={disabled}
                  onChange={(next) => {
                    set("text-align", next);
                    onCommit?.();
                  }}
                  options={[
                    { value: "left", title: "Left", label: "Left" },
                    { value: "center", title: "Centre", label: "Centre" },
                    { value: "right", title: "Right", label: "Right" },
                    { value: "justify", title: "Justify", label: "Justify" },
                  ]}
                />
              }
            />

            <Text property="line-height" label="Leading" />
            <Text property="letter-spacing" label="Tracking" />
            <Choice property="text-transform" label="Case" options={CASES.filter((option) => option.value)} />
          </Section>
        )}

        {shown.has("background") && (
          <Section name="background" title={SECTION_TITLE.background} open={isOpen("background")} changed={sectionChanged("background")} onToggle={() => toggleSection("background")}>
            <Colour property="background-color" label="Background" />
            {(() => {
              const extractUrl = (...candidates: (string | undefined | null)[]) => {
                for (const c of candidates) {
                  if (!c || c === "none") continue;
                  const trimmed = c.trim();
                  const match = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(trimmed);
                  if (match && match[1]) return match[1].trim();
                  if (/^(https?:|\/|data:image\/)/i.test(trimmed)) return trimmed;
                }
                return "";
              };
              const bgUrl = extractUrl(
                declarations["background-image"],
                declarations.background,
                source.computed["background-image"],
                source.computed.background,
                backgroundImageFallbackUrl
              );
              const resolvedBgUrl = (() => {
                if (!bgUrl) return "";
                if (resolveImagePreview) return resolveImagePreview(bgUrl);
                if (/^(https?:|data:|blob:|\/api\/)/i.test(bgUrl)) return bgUrl;
                if (sitePublicUrl) {
                  try {
                    return new URL(bgUrl, sitePublicUrl).href;
                  } catch {
                    return bgUrl;
                  }
                }
                return bgUrl;
              })();

              const applyBackgroundUrl = (nextUrl: string) => {
                if (!nextUrl) {
                  set("background-image", "none");
                  onSetBackgroundImageUrl?.("");
                } else {
                  const updated = {
                    ...declarations,
                    "background-image": `url('${nextUrl.replace(/['"\\]/g, "")}')`,
                    "background-size": declarations["background-size"] || "cover",
                    "background-position": declarations["background-position"] || "center",
                  };
                  onChange(writeStyle(updated));
                  onSetBackgroundImageUrl?.(nextUrl);
                }
              };

              return (
                <div className="mt-3 space-y-3 border-t border-line pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-ink">Choose Image</span>
                    {bgUrl && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          applyBackgroundUrl("");
                          onCommit?.();
                        }}
                        className="rounded-md border border-line bg-white px-2 py-0.5 text-[10px] font-semibold text-muted transition hover:border-red/40 hover:text-red"
                        title="Remove background image"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {/* Elementor-style large visual Choose Image preview box */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!disabled && onPickBackgroundImage) onPickBackgroundImage();
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && !disabled && onPickBackgroundImage) {
                        e.preventDefault();
                        onPickBackgroundImage();
                      }
                    }}
                    className="group relative h-36 w-full cursor-pointer overflow-hidden rounded-xl border border-line bg-sunken shadow-2xs transition hover:border-blue"
                  >
                    {resolvedBgUrl ? (
                      <img
                        src={resolvedBgUrl}
                        alt="Container background preview"
                        className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                      />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted">
                        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-white text-base shadow-2xs">
                          🖼
                        </span>
                        <span className="text-[11px] font-semibold text-ink-2">Click to Choose Image</span>
                        <span className="text-[10px] text-muted">From HTML Page Media or Upload</span>
                      </div>
                    )}

                    <div className=" inset-x-0 bottom-0 absolute bg-ink/75 py-1.5 text-center text-[11px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                      Choose Image
                    </div>
                  </div>

                  {/* Image Resolution / Size & Position */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-ink-2">Image Resolution</span>
                      <select
                        disabled={disabled}
                        value={declarations["background-size"] ?? source.computed["background-size"] ?? "cover"}
                        onChange={(e) => {
                          set("background-size", e.target.value);
                          onCommit?.();
                        }}
                        className="h-7 w-36 rounded-lg border border-line bg-white px-2 text-[11px] font-medium text-ink outline-none focus:border-blue"
                      >
                        <option value="cover">Full (Cover)</option>
                        <option value="contain">Contain</option>
                        <option value="auto">Original (Auto)</option>
                        <option value="100% 100%">Stretch (100%)</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-ink-2">Position</span>
                      <select
                        disabled={disabled}
                        value={declarations["background-position"] ?? source.computed["background-position"] ?? "center"}
                        onChange={(e) => {
                          set("background-position", e.target.value);
                          onCommit?.();
                        }}
                        className="h-7 w-36 rounded-lg border border-line bg-white px-2 text-[11px] font-medium text-ink outline-none focus:border-blue"
                      >
                        <option value="center">Center Center</option>
                        <option value="top">Top Center</option>
                        <option value="bottom">Bottom Center</option>
                        <option value="left">Center Left</option>
                        <option value="right">Center Right</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <span className="block text-[10px] font-medium text-muted">Image Link / URL</span>
                      <input
                        type="text"
                        disabled={disabled}
                        placeholder="Paste image URL (/assets/... or https://...)"
                        value={bgUrl}
                        onChange={(event) => applyBackgroundUrl(event.target.value.trim())}
                        onBlur={() => onCommit?.()}
                        className="w-full rounded-lg border border-line bg-white px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-blue"
                      />
                    </div>
                  </div>
                </div>
              );
            })()}
          </Section>
        )}

        {shown.has("border") && (
          <Section name="border" title={SECTION_TITLE.border} open={isOpen("border")} changed={sectionChanged("border")} onToggle={() => toggleSection("border")}>
            {borderParts ? (
              <SubBlock
                title="Border"
                onRemove={() => {
                  set("border", "none");
                  onCommit?.();
                }}
              >
                <div className="flex gap-1.5">
                  <NumberField
                    label="Width"
                    unit="px"
                    value={Number(borderParts[1])}
                    min={0}
                    placeholder="1"
                    onChange={(next) => set("border", `${next ?? 0}px ${borderParts[2]} ${borderParts[3]}`)}
                    onCommit={onCommit}
                  />
                  <SelectField
                    label="Style"
                    value={borderParts[2]!}
                    disabled={disabled}
                    onChange={(next) => {
                      set("border", `${borderParts[1]}px ${next} ${borderParts[3]}`);
                      onCommit?.();
                    }}
                    options={BORDER_STYLES.map((option) => ({ value: option, label: option }))}
                  />
                </div>
                <ColourField
                  label="Colour"
                  value={borderParts[3]!}
                  disabled={disabled}
                  onChange={(next) => set("border", `${borderParts[1]}px ${borderParts[2]} ${next}`)}
                  onCommit={onCommit}
                />
              </SubBlock>
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  set("border", "1px solid #08101F");
                  onCommit?.();
                }}
                className="w-full rounded-xl border border-dashed border-line py-2 text-[11px] font-semibold text-muted transition hover:border-blue hover:text-blue"
              >
                + Add border
              </button>
            )}
            <Text property="border-radius" label="Corner radius" />
          </Section>
        )}

        {shown.has("effects") && (
          <Section name="effects" title={SECTION_TITLE.effects} open={isOpen("effects")} changed={sectionChanged("effects")} onToggle={() => toggleSection("effects")}>
            <Row
              label="Opacity"
              rail={rail("opacity")}
              control={
                <NumberField
                  label="Opacity"
                  bare
                  value={toNumber(value("opacity").effective)}
                  step={0.05}
                  min={0}
                  max={1}
                  placeholder="1"
                  onChange={(next) => set("opacity", next === null ? "" : String(next))}
                  onCommit={onCommit}
                />
              }
            />
            {extras.includes("box-shadow") ? (
              <Shadow property="box-shadow" declarations={declarations} disabled={disabled} onSet={set} onCommit={onCommit} />
            ) : siteShadow ? (
              <div className="rounded-xl bg-cream/70 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                The website already gives this a shadow — <span className="font-mono">{siteShadow}</span>. Adding one here replaces it.
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    set("box-shadow", EXTRA_SEED["box-shadow"]);
                    onCommit?.();
                  }}
                  className="ml-1 border-b border-dashed border-line text-ink transition hover:border-blue hover:text-blue"
                >
                  Replace it
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  set("box-shadow", EXTRA_SEED["box-shadow"]);
                  onCommit?.();
                }}
                className="w-full rounded-xl border border-dashed border-line py-2 text-[11px] font-semibold text-muted transition hover:border-blue hover:text-blue"
              >
                + Add shadow
              </button>
            )}
          </Section>
        )}

        {shown.has("position") && (
          <Section name="position" title={SECTION_TITLE.position} open={isOpen("position")} changed={sectionChanged("position")} onToggle={() => toggleSection("position")}>
            <Choice property="position" label="Position" options={["static", "relative", "absolute", "fixed", "sticky"]} />
            {/* Exactly the offsets this position obeys, and no others: a sticky
                element ignores left and right, so it is offered neither. */}
            {offsets.includes("right") && (
              <>
                <Pair label="Offset" first={{ property: "top", label: "top", prefix: "T" }} second={{ property: "left", label: "left", prefix: "L" }} />
                <Pair label="" first={{ property: "bottom", label: "bottom", prefix: "B" }} second={{ property: "right", label: "right", prefix: "R" }} />
              </>
            )}
            {!offsets.includes("right") && offsets.includes("top") && (
              <Pair label="Offset" first={{ property: "top", label: "top", prefix: "T" }} second={{ property: "bottom", label: "bottom", prefix: "B" }} />
            )}
            {zIndex && <Text property="z-index" label="Stack order" short="Stack" />}
          </Section>
        )}

        {/* -------------------------------------------------------- advanced */}
        {!simple && tab !== "content" && <Section
          name="advanced"
          title={SECTION_TITLE.advanced}
          open={showAdvanced}
          changed={sectionChanged("advanced")}
          onToggle={() => setShowAdvanced((was) => !was)}
        >
          <div className="space-y-1">
              {!shown.has("position") && (
                <Choice property="position" label="Position" options={["static", "relative", "absolute", "fixed", "sticky"]} />
              )}
              <Choice property="overflow" label="Overflow" options={["visible", "hidden", "auto", "scroll"]} />
              <Choice property="box-sizing" label="Sizing model" options={["border-box", "content-box"]} />
              <Pair label="Minimum" first={{ property: "min-width", label: "Min width", prefix: "W" }} second={{ property: "min-height", label: "Min height", prefix: "H" }} />
              <Text property="max-height" label="Max height" />
              {capabilities.flexChild && <Text property="order" label="Order" />}
              {capabilities.gridChild && <Choice property="justify-self" label="Justify self" options={["auto", "stretch", "start", "center", "end"]} />}
              {!zIndex && <Text property="z-index" label="Stack order" short="Stack" />}
              <Text property="background-image" label="Gradient" />
              <p className="text-[11px] leading-relaxed text-muted">
                A linear-gradient or radial-gradient. Photographs are replaced through the picture control.
              </p>

              {extras.filter((key) => key !== "box-shadow").map((key) => {
                if (key === "filter") {
                  return (
                    <SubBlock key={key} title="Filter" onRemove={() => clear("filter")}>
                      <input
                        className="h-8 w-full rounded-xl border border-line bg-white px-2 font-mono text-[11px] text-ink outline-none focus:border-blue"
                        value={declarations.filter ?? ""}
                        placeholder="blur(2px) grayscale(.4)"
                        disabled={disabled}
                        onChange={(event) => set("filter", event.target.value)}
                        onBlur={() => onCommit?.()}
                      />
                    </SubBlock>
                  );
                }
                if (key === "transform") {
                  const t = readTransform(declarations.transform);
                  const write = (patch: Partial<typeof t>) => {
                    const next = { ...t, ...patch };
                    set("transform", `translate(${next.x}px, ${next.y}px) rotate(${next.rotate}deg) scale(${next.scaleX}, ${next.scaleY})`);
                  };
                  return (
                    <SubBlock key={key} title="Transform" onRemove={() => clear("transform")}>
                      <div className="grid grid-cols-2 gap-1.5">
                        <NumberField label="X" unit="px" value={t.x} placeholder="0" onChange={(next) => write({ x: next ?? 0 })} onCommit={onCommit} />
                        <NumberField label="Y" unit="px" value={t.y} placeholder="0" onChange={(next) => write({ y: next ?? 0 })} onCommit={onCommit} />
                        <NumberField label="Rotate" unit="°" value={t.rotate} placeholder="0" onChange={(next) => write({ rotate: next ?? 0 })} onCommit={onCommit} />
                        <NumberField
                          label="Scale"
                          value={t.scaleX}
                          step={0.05}
                          placeholder="1"
                          onChange={(next) => write({ scaleX: next ?? 1, scaleY: next ?? 1 })}
                          onCommit={onCommit}
                        />
                      </div>
                    </SubBlock>
                  );
                }
                return <Shadow key={key} property="text-shadow" declarations={declarations} disabled={disabled} onSet={set} onCommit={onCommit} />;
              })}

              {missingExtras.length > 0 && (
                <div className="pt-1 text-[11px] text-muted">
                  Add:{" "}
                  {missingExtras.map((key, index) => (
                    <span key={key}>
                      {index > 0 && " · "}
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          set(key, EXTRA_SEED[key]);
                          onCommit?.();
                        }}
                        className="border-b border-dashed border-line text-ink transition hover:border-blue hover:text-blue"
                      >
                        {EXTRA_LABEL[key]}
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {untouched.length > 0 && (
                <div className="rounded-xl bg-cream/70 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                  <span className="font-semibold text-muted">Also on this element, left alone:</span>{" "}
                  <span className="font-mono">{untouched.map(([property, declaration]) => `${property}: ${declaration}`).join("; ")}</span>
                </div>
              )}

              {style && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onReset();
                    onCommit?.();
                  }}
                  className="text-[11px] text-muted underline-offset-2 transition hover:text-ink hover:underline"
                >
                  Put this element back as the website has it
                </button>
              )}
          </div>
        </Section>}
        {simple && !tab && <p className="px-3 py-3 text-xs text-muted">For layout, spacing and detailed styling, enable Designer controls in More.</p>}
      </div>
    </PaletteContext.Provider>
  );
}

/**
 * Where the value in the control beside this came from, and the way back.
 *
 * A default nobody chose — `z-index: auto` on a static element — is not
 * announced at all: the panel is a description of what governs this element,
 * and that governs nothing. Reset names the value it is going back to only when
 * the page's own HTML says what that is; anywhere else it would have to guess,
 * because the frame is already rendering the override.
 */
function Origin({
  value,
  palette,
  disabled,
  onReset,
}: {
  value: InspectorValue;
  palette: { label: string; value: string }[];
  disabled: boolean;
  onReset: () => void;
}) {
  if (!meaningfulValue(value)) return null;
  const readable = readableValue(value.property, value.effective, palette);
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        data-origin={value.property}
        title={`${ORIGIN_TITLE[value.origin]}${readable ? ` Now: ${readable}.` : ""}`}
        className={`font-sans text-[11px] uppercase tracking-[.06em] ${value.overridden ? "text-blue" : "text-faint"}`}
      >
        {ORIGIN_LABEL[value.origin]}
      </span>
      {value.overridden && !disabled && (
        <button
          type="button"
          onClick={onReset}
          title={value.source ? `Put this back to the website's ${value.source}` : "Put this back to the website's own styling"}
          aria-label={`Reset ${value.property}`}
          className="text-[11px] leading-none text-muted transition hover:text-ink"
        >
          ↺
        </button>
      )}
    </span>
  );
}

/** A shadow, as four numbers and a colour rather than a CSS string. */
function Shadow({
  property,
  declarations,
  disabled,
  onSet,
  onCommit,
}: {
  property: "box-shadow" | "text-shadow";
  declarations: Record<string, string>;
  disabled: boolean;
  onSet: (property: string, value: string) => void;
  onCommit?: () => void;
}) {
  const spread = property === "box-shadow";
  const shadow = readShadow(declarations[property], spread);
  const write = (patch: Partial<typeof shadow>) => {
    const next = { ...shadow, ...patch };
    onSet(
      property,
      spread ? `${next.x}px ${next.y}px ${next.blur}px ${next.spread}px ${next.colour}` : `${next.x}px ${next.y}px ${next.blur}px ${next.colour}`,
    );
  };
  return (
    <SubBlock
      title={spread ? "Shadow" : "Text shadow"}
      onRemove={() => {
        onSet(property, "none");
        onCommit?.();
      }}
    >
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label="X" unit="px" value={shadow.x} placeholder="0" onChange={(next) => write({ x: next ?? 0 })} onCommit={onCommit} />
        <NumberField label="Y" unit="px" value={shadow.y} placeholder="0" onChange={(next) => write({ y: next ?? 0 })} onCommit={onCommit} />
        <NumberField label="Blur" unit="px" value={shadow.blur} min={0} placeholder="0" onChange={(next) => write({ blur: next ?? 0 })} onCommit={onCommit} />
        {spread && <NumberField label="Spread" unit="px" value={shadow.spread} placeholder="0" onChange={(next) => write({ spread: next ?? 0 })} onCommit={onCommit} />}
      </div>
      <ColourField label="Colour" value={shadow.colour} disabled={disabled} onChange={(next) => write({ colour: next })} onCommit={onCommit} />
    </SubBlock>
  );
}
