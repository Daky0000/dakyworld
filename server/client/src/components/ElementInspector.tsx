import { useMemo, useState } from "react";
import { CssValueField } from "./CssValueField";
import {
  ALIGN_ICONS, BORDER_STYLES, CASES, COLOURS, ColourField, DIRECTION_ICONS, DISPLAY_ICONS, EXTRA_LABEL, EXTRA_SEED,
  FONTS, IconChoice, IconToggle, JUSTIFY_ICONS, Lines, NumberField, PaletteContext, Row, SIDES, Section, Segmented,
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
  onChange,
  onCommit,
  onReset,
  onTextColour,
  content,
}: {
  simple?: boolean;
  tab?: "content" | "style";
  facts: ElementFacts;
  device: Device;
  /** The draft's declarations for the active viewport. */
  style: string | undefined;
  source: InspectorSource;
  palette?: string[];
  fonts?: string[];
  readOnly?: boolean;
  onChange: (next: string) => void;
  /** Called when a continuous gesture ends, so history records one step. */
  onCommit?: () => void;
  /** Put the whole element back as the website has it. */
  onReset: () => void;
  /** A selected text range owns its colour before the element does. */
  onTextColour?: (colour: string) => boolean;
  /** The content editor, which the page owns; drawn as the first section. */
  content?: React.ReactNode;
}) {
  const disabled = !!readOnly;
  const [showAdvanced, setShowAdvanced] = useState(false);
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
  const shown = new Set(inspectorSections(capabilities).filter(section => tab ? (tab === "content" ? section === "content" : section !== "content") : (!simple || section === "content")));

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
  const ALWAYS_OPEN: SectionKey[] = ["content", "image", "layout", "flexContainer", "gridContainer", "flexChild", "gridChild", "position", "typography"];
  const isOpen = (section: SectionKey) => openSections[section] ?? (tab ? section === "typography" : (ALWAYS_OPEN.includes(section) || sectionHasValue(section)));

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
              className={`font-mono text-[9px] uppercase tracking-[.08em] ${left.overridden || right.overridden ? "text-blue" : "text-faint"}`}
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

  const SideField = ({ property, side }: { property: "padding" | "margin"; side: (typeof SIDES)[number] }) => {
    const current = value(`${property}-${side}`);
    return (
      <div className="relative min-w-0">
        <CssValueField
          property={`${property}-${side}`}
          label={`${property} ${side}`}
          bare
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
   * Padding and margin, drawn as the box they are.
   *
   * Four fields in a row labelled top, right, bottom and left are a list of four
   * numbers somebody has to read; the same four arranged around a centre are the
   * thing itself. The dashed square in the middle stands for the element, and a
   * side that has been changed carries a dot rather than a word — there is no
   * room for four origin labels, and the tooltip carries what the word would say.
   */
  const box = (property: "padding" | "margin") => (
    <div className="pt-0.5">
      <div className="mb-1 text-[10px] uppercase tracking-[.06em] text-muted">{property}</div>
      <div className="grid grid-cols-[1fr_28px_1fr] items-center gap-1">
        <div />
        <SideField property={property} side="top" />
        <div />
        <SideField property={property} side="left" />
        <span aria-hidden className="mx-auto h-4 w-5 rounded border border-dashed border-line-strong" />
        <SideField property={property} side="right" />
        <div />
        <SideField property={property} side="bottom" />
        <div />
      </div>
    </div>
  );

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

        {shown.has("size") && (
          <Section name="size" title={SECTION_TITLE.size} open={isOpen("size")} changed={sectionChanged("size")} onToggle={() => toggleSection("size")}>
            <Pair label="Size" first={{ property: "width", label: "Width", prefix: "W" }} second={{ property: "height", label: "Height", prefix: "H" }} />
            <Text property="max-width" label="Max width" />
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
                    { value: "left", title: "Left", label: <Lines widths={[10, 6, 8]} align="start" /> },
                    { value: "center", title: "Centre", label: <Lines widths={[10, 6, 8]} align="center" /> },
                    { value: "right", title: "Right", label: <Lines widths={[10, 6, 8]} align="end" /> },
                    { value: "justify", title: "Justify", label: <Lines widths={[10, 10, 10]} align="start" /> },
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
              <div className="rounded-xl bg-cream/70 px-2.5 py-2 text-[10px] leading-relaxed text-muted">
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
              <p className="text-[10px] leading-relaxed text-muted">
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
                <div className="rounded-xl bg-cream/70 px-2.5 py-2 text-[10px] leading-relaxed text-muted">
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
        className={`font-mono text-[9px] uppercase tracking-[.08em] ${value.overridden ? "text-blue" : "text-faint"}`}
      >
        {ORIGIN_LABEL[value.origin]}
      </span>
      {value.overridden && !disabled && (
        <button
          type="button"
          onClick={onReset}
          title={value.source ? `Put this back to the website's ${value.source}` : "Put this back to the website's own styling"}
          aria-label={`Reset ${value.property}`}
          className="text-[10px] leading-none text-muted transition hover:text-ink"
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
