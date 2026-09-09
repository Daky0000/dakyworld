import { useMemo, useState } from "react";
import { CssValueField } from "./CssValueField";
import {
  BORDER_STYLES, CASES, COLOURS, ColourField, EXTRA_LABEL, EXTRA_SEED, FONTS, IconToggle, Lines, NumberField,
  PaletteContext, SIDES, Section, Segmented, SelectField, SubBlock, WEIGHTS, expandBox, parseStyle, readShadow,
  readTransform, toNumber, writeStyle, type Extra,
} from "./InspectorControls";
import {
  ORIGIN_LABEL, ORIGIN_TITLE, PROPERTY_OWNER, SECTION_TITLE, elementCapabilities, inspectorSections, inspectorValue,
  isBrowserDefault, meaningfulValue, positionControls, readableValue,
  type Device, type ElementFacts, type InspectorValue,
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
  content,
}: {
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
  /** The content editor, which the page owns; drawn as the first section. */
  content?: React.ReactNode;
}) {
  const disabled = !!readOnly;
  const [showAdvanced, setShowAdvanced] = useState(false);

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
  const shown = new Set(inspectorSections(capabilities));

  const value = (property: string): InspectorValue =>
    inspectorValue(property, {
      computed: source.computed[property],
      source: sourceDeclarations[property],
      override: declarations[property],
      base: baseDeclarations[property],
      device,
    });

  const set = (property: string, next: string) => {
    const updated = { ...declarations };
    if (next) updated[property] = next;
    else delete updated[property];
    onChange(writeStyle(updated));
  };
  const clear = (property: string) => {
    set(property, "");
    onCommit?.();
  };

  /**
   * A control, with where the value in it came from underneath.
   *
   * The controls carry their own labels — that is the existing design language
   * and it survives a 300px column better than a label above every box — so
   * this adds only the origin line and the way back from an override.
   */
  const Row = ({ property, children }: { property: string; children: React.ReactNode }) => (
    <div className="min-w-0">
      {children}
      <div className="mt-0.5 flex justify-end">
        <Origin value={value(property)} palette={swatches} disabled={disabled} onReset={() => clear(property)} />
      </div>
    </div>
  );

  /** A free CSS value — a length, a track list, an expression the site uses. */
  const Text = ({ property, label }: { property: string; label: string }) => (
    <Row property={property}>
      <CssValueField property={property} label={label} value={value(property).effective} disabled={disabled} onChange={(next) => set(property, next)} />
    </Row>
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
      <Row property={property}>
        <SelectField label={label} value={effective} disabled={disabled} options={list} onChange={(next) => { set(property, next); onCommit?.(); }} />
      </Row>
    );
  };

  const Colour = ({ property, label }: { property: string; label: string }) => (
    <Row property={property}>
      <ColourField
        label={label}
        value={value(property).effective}
        allowNone
        disabled={disabled}
        onChange={(next) => set(property, next)}
        onCommit={onCommit}
      />
    </Row>
  );

  const decoration = value("text-decoration").effective;
  const fontOptions = [...FONTS.filter((font) => font.value), ...(fonts ?? []).filter((face) => !FONTS.some((font) => font.value === face)).map((face) => ({ label: face, value: face }))];

  const box = (property: "padding" | "margin") => (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-[.08em] text-muted">{property}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {SIDES.map((side) => (
          <Row key={side} property={`${property}-${side}`}>
            <CssValueField
              property={`${property}-${side}`}
              label={`${property} ${side}`}
              name={side}
              value={value(`${property}-${side}`).effective}
              disabled={disabled}
              onChange={(next) => set(`${property}-${side}`, next)}
            />
          </Row>
        ))}
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
        {shown.has("content") && content && <Section title={SECTION_TITLE.content}>{content}</Section>}

        {shown.has("image") && (
          <Section title={SECTION_TITLE.image}>
            <Choice property="object-fit" label="Fit" options={["cover", "contain", "fill", "none", "scale-down"]} />
            <Text property="object-position" label="Focal point" />
          </Section>
        )}

        {shown.has("layout") && (
          <Section title={SECTION_TITLE.layout}>
            <Choice property="display" label="Display" options={["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none"]} />
          </Section>
        )}

        {shown.has("flexContainer") && (
          <Section title={SECTION_TITLE.flexContainer}>
            <Choice property="flex-direction" label="Direction" options={["row", "column", "row-reverse", "column-reverse"]} />
            <Choice property="flex-wrap" label="Wrap" options={["nowrap", "wrap", "wrap-reverse"]} />
            <Choice property="justify-content" label="Distribute" options={["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"]} />
            <Choice property="align-items" label="Align" options={["stretch", "flex-start", "center", "flex-end", "baseline"]} />
            <div className="grid grid-cols-2 gap-1.5">
              <Text property="row-gap" label="Row gap" />
              <Text property="column-gap" label="Column gap" />
            </div>
          </Section>
        )}

        {shown.has("gridContainer") && (
          <Section title={SECTION_TITLE.gridContainer}>
            <Text property="grid-template-columns" label="Columns" />
            <Text property="grid-template-rows" label="Rows" />
            <Choice property="justify-content" label="Distribute" options={["start", "center", "end", "space-between", "space-around", "space-evenly"]} />
            <Choice property="align-items" label="Align" options={["stretch", "start", "center", "end", "baseline"]} />
            <div className="grid grid-cols-2 gap-1.5">
              <Text property="row-gap" label="Row gap" />
              <Text property="column-gap" label="Column gap" />
            </div>
          </Section>
        )}

        {shown.has("flexChild") && (
          <Section title={SECTION_TITLE.flexChild}>
            <Choice property="align-self" label="Align self" options={["auto", "stretch", "flex-start", "center", "flex-end", "baseline"]} />
            <div className="grid grid-cols-2 gap-1.5">
              <Text property="flex-grow" label="Grow" />
              <Text property="flex-shrink" label="Shrink" />
            </div>
          </Section>
        )}

        {shown.has("gridChild") && (
          <Section title={SECTION_TITLE.gridChild}>
            <Text property="grid-column" label="Column" />
            <Text property="grid-row" label="Row" />
            <Choice property="align-self" label="Align self" options={["auto", "stretch", "start", "center", "end", "baseline"]} />
          </Section>
        )}

        {shown.has("size") && (
          <Section title={SECTION_TITLE.size}>
            <div className="grid grid-cols-2 gap-1.5">
              <Text property="width" label="Width" />
              <Text property="height" label="Height" />
            </div>
            <Text property="max-width" label="Max width" />
          </Section>
        )}

        {shown.has("spacing") && (
          <Section title={SECTION_TITLE.spacing}>
            {box("padding")}
            {box("margin")}
          </Section>
        )}

        {shown.has("typography") && (
          <Section title={SECTION_TITLE.typography}>
            <Choice property="font-family" label="Font" options={fontOptions} />
            <div className="grid grid-cols-2 gap-1.5">
              <Text property="font-size" label="Size" />
              <Colour property="color" label="Colour" />
            </div>
            <Choice property="font-weight" label="Weight" options={WEIGHTS.filter((weight) => weight.value)} />

            <div className="flex gap-1.5 pt-0.5">
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

            <Row property="text-align">
              <div className="mb-1 text-[11px] text-muted">Alignment</div>
              <Segmented
                value={value("text-align").effective}
                disabled={disabled}
                onChange={(next) => {
                  set("text-align", next);
                  onCommit?.();
                }}
                options={[
                  { value: "left", title: "Left", label: <Lines widths={[12, 8, 10]} align="start" /> },
                  { value: "center", title: "Centre", label: <Lines widths={[12, 8, 10]} align="center" /> },
                  { value: "right", title: "Right", label: <Lines widths={[12, 8, 10]} align="end" /> },
                  { value: "justify", title: "Justify", label: <Lines widths={[12, 12, 12]} align="start" /> },
                ]}
              />
            </Row>

            <div className="grid grid-cols-2 gap-1.5">
              <Text property="line-height" label="Line height" />
              <Text property="letter-spacing" label="Letter spacing" />
            </div>
            <Choice property="text-transform" label="Case" options={CASES.filter((option) => option.value)} />
          </Section>
        )}

        {shown.has("background") && (
          <Section title={SECTION_TITLE.background}>
            <Colour property="background-color" label="Background" />
          </Section>
        )}

        {shown.has("border") && (
          <Section title={SECTION_TITLE.border}>
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
          <Section title={SECTION_TITLE.effects}>
            <Row property="opacity">
              <NumberField
                label="Opacity"
                value={toNumber(value("opacity").effective)}
                step={0.05}
                min={0}
                max={1}
                placeholder="1"
                onChange={(next) => set("opacity", next === null ? "" : String(next))}
                onCommit={onCommit}
              />
            </Row>
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
          <Section title={SECTION_TITLE.position}>
            <Choice property="position" label="Position" options={["static", "relative", "absolute", "fixed", "sticky"]} />
            {offsets.length > 0 && (
              <div className="grid grid-cols-2 gap-1.5">
                {offsets.map((side) => (
                  <Text key={side} property={side} label={side} />
                ))}
              </div>
            )}
            {zIndex && <Text property="z-index" label="Stack order" />}
          </Section>
        )}

        {/* -------------------------------------------------------- advanced */}
        <div className="border-b border-line px-4 py-3 last:border-b-0">
          <button
            type="button"
            onClick={() => setShowAdvanced((was) => !was)}
            aria-expanded={showAdvanced}
            className="flex w-full items-center justify-between gap-2 font-mono text-[10px] font-bold uppercase tracking-[.14em] text-muted transition hover:text-ink"
          >
            <span>{SECTION_TITLE.advanced}</span>
            <span aria-hidden>{showAdvanced ? "▾" : "▸"}</span>
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-1.5">
              {!shown.has("position") && (
                <Choice property="position" label="Position" options={["static", "relative", "absolute", "fixed", "sticky"]} />
              )}
              <Choice property="overflow" label="Overflow" options={["visible", "hidden", "auto", "scroll"]} />
              <Choice property="box-sizing" label="Sizing model" options={["border-box", "content-box"]} />
              <div className="grid grid-cols-2 gap-1.5">
                <Text property="min-width" label="Min width" />
                <Text property="min-height" label="Min height" />
              </div>
              <Text property="max-height" label="Max height" />
              {capabilities.flexChild && <Text property="order" label="Order" />}
              {capabilities.gridChild && <Choice property="justify-self" label="Justify self" options={["auto", "stretch", "start", "center", "end"]} />}
              {!zIndex && <Text property="z-index" label="Stack order" />}
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
          )}
        </div>
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
