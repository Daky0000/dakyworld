import { useState } from "react";
import { ColorCodeInput, parseStyle, writeStyle } from "./InspectorControls";
import { Acc, SHADOW_PRESETS, Seg, Slider, Tiles } from "./InspectorDesign";
import { toHex } from "../lib/elementInspector";

/**
 * The Style tab's Normal view, laid out as the redesign draws it: Size,
 * Spacing, Typography, Background, Border, Effects and Position, each a
 * collapsible section whose header carries its current value.
 *
 * Every control writes one inline declaration on the selected element through
 * `onChange` — the editor routes that to the base style on Desktop or to the
 * tablet/phone override on smaller screens, exactly as the old inspector did.
 * Blank means "as designed": the placeholder shows what the page computes, and
 * "Default" next to a label removes the override. Typing changes the page as
 * you type; a step is added to undo when a field is left (`onCommit`).
 */

type Props = {
  style: string;
  computed: Record<string, string>;
  fonts?: string[];
  kind: string;
  tag: string;
  readOnly: boolean;
  onChange: (style: string, commit?: boolean) => void;
  onCommit: () => void;
  onPickBackgroundImage: () => void;
};

const LENGTH = /^(-?\d*\.?\d+)([a-z%]*)$/i;
const WEIGHTS: [string, string][] = [["Light", "300"], ["Normal", "400"], ["Medium", "500"], ["Semibold", "600"], ["Bold", "700"], ["Black", "900"]];
const CASES: [string, string][] = [["Normal", "none"], ["UPPERCASE", "uppercase"], ["lowercase", "lowercase"], ["Capitalise", "capitalize"]];
const POSITIONS = ["Default", "center center", "center left", "center right", "top center", "top left", "top right", "bottom center", "bottom left", "bottom right"];

const px = (value: string | undefined) => {
  const number = Number.parseFloat(value ?? "");
  return Number.isFinite(number) ? `${Math.round(number)}px` : "—";
};

export function WebsiteStylePanel({ style, computed, fonts = [], kind, tag, readOnly, onChange, onCommit, onPickBackgroundImage }: Props) {
  const map = expandShorthands(parseStyle(style));
  const set = (property: string, value: string | null, commit = false) => {
    const next = { ...map };
    if (value === null || value.trim() === "") delete next[property];
    else next[property] = value.trim();
    onChange(writeStyle(next), commit);
  };
  const setMany = (patch: Record<string, string | null>, commit = true) => {
    const next = { ...map };
    for (const [property, value] of Object.entries(patch)) {
      if (value === null || value === "") delete next[property];
      else next[property] = value;
    }
    onChange(writeStyle(next), commit);
  };
  const value = (property: string) => map[property] ?? "";
  const [spacingUnit, setSpacingUnit] = useState("px");
  const c: Ctx = { map, computed, readOnly, set, setMany, onCommit, spacingUnit };
  const shown = (property: string) => map[property] ?? computed[property] ?? "";
  const isText = kind !== "image" && kind !== "container" && kind !== "icon";
  const isSection = kind === "container";

  // ---- spacing box --------------------------------------------------------
  // ---- text decoration toggles -------------------------------------------
  const decorations = new Set((value("text-decoration") || value("text-decoration-line")).split(/\s+/).filter((part) => part && part !== "none"));
  const toggleDecoration = (part: string) => {
    if (decorations.has(part)) decorations.delete(part);
    else decorations.add(part);
    setMany({ "text-decoration": decorations.size ? [...decorations].join(" ") : null, "text-decoration-line": null });
  };

  // ---- shadow ------------------------------------------------------------
  const boxShadow = value("box-shadow");
  const preset = SHADOW_PRESETS.find((option) => option.css === (boxShadow || "none"))?.value ?? (boxShadow ? "" : "none");
  const shadow = readShadow(boxShadow);
  const writeShadow = (patch: Partial<typeof shadow>) => {
    const next = { ...shadow, ...patch };
    set("box-shadow", `0 ${next.distance}px ${next.blur}px ${next.size}px rgba(${next.rgb.join(",")},${(next.strength / 100).toFixed(2)})`);
  };
  const [fineShadow, setFineShadow] = useState(false);

  const fontFamily = (shown("font-family").split(",")[0] ?? "").replace(/["']/g, "").trim();
  const fontOptions = Array.from(new Set([fontFamily, ...fonts, "Georgia", "System sans", "Mono"].filter(Boolean)));
  const fontCss = (name: string) => (name === "System sans" ? "system-ui, sans-serif" : name === "Mono" ? "ui-monospace, monospace" : /\s/.test(name) ? `"${name}"` : name);
  const opacity = Math.round((Number.parseFloat(shown("opacity") || "1") || 0) * 100);
  const bgImage = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(value("background-image") || value("background"))?.[1] ?? "";
  const position = shown("position") || "static";

  return (
    <fieldset disabled={readOnly} className="dx-style">
      <Acc title="Size" summary={value("width") || (computed.width ? px(computed.width) : "Auto")} open>
        <div className="dx-g2">
          <Num c={c} label="Width" property="width" units={["px", "%", "vw"]} placeholder="Auto" />
          <Num c={c} label="Height" property="height" units={["px", "%", "vh"]} placeholder="Auto" />
        </div>
        <Num c={c} label="Max width" property="max-width" units={["px", "%", "vw"]} placeholder="As designed" />
        <div className="dx-sub">Within its row</div>
        <Select c={c} label="Align self" property="align-self" options={[["Auto", "auto"], ["Stretch", "stretch"], ["Start", "flex-start"], ["Centre", "center"], ["End", "flex-end"], ["Baseline", "baseline"]]} />
        <div className="dx-g2">
          <Num c={c} label="Grow" property="flex-grow" placeholder="auto" />
          <Num c={c} label="Shrink" property="flex-shrink" placeholder="auto" />
        </div>
      </Acc>

      <Acc title="Spacing" summary={`${px(shown("padding-top"))} · ${px(shown("margin-top"))}`} open>
        <div className="dx-fl">
          <label>Margin outside · padding inside</label>
          <select className="dx-unit" aria-label="Spacing unit" value={spacingUnit} onChange={(event) => setSpacingUnit(event.target.value)}>
            {["px", "%", "em", "rem"].map((unit) => <option key={unit}>{unit}</option>)}
          </select>
        </div>
        <div className="dx-box">
          <span className="dx-tag">margin</span>
          <SideInput c={c} property="margin-top" side="t" />
          <SideInput c={c} property="margin-right" side="r" />
          <SideInput c={c} property="margin-bottom" side="b" />
          <SideInput c={c} property="margin-left" side="l" />
          <div className="dx-inner">
            <span className="dx-tag">padding</span>
            <SideInput c={c} property="padding-top" side="t" />
            <SideInput c={c} property="padding-right" side="r" />
            <SideInput c={c} property="padding-bottom" side="b" />
            <SideInput c={c} property="padding-left" side="l" />
            <div className="dx-core">{tag}</div>
          </div>
        </div>
      </Acc>

      <Acc title="Typography" summary={`${fontFamily || "Font"} · ${px(shown("font-size"))}`} open={isText}>
        <div className="dx-f">
          <Label c={c} text="Font" props={["font-family"]} />
          <select aria-label="Font" value={value("font-family") ? (value("font-family").split(",")[0] ?? "").replace(/["']/g, "").trim() : ""} onChange={(event) => set("font-family", event.target.value ? fontCss(event.target.value) : null, true)}>
            <option value="">{fontFamily ? `${fontFamily} (as designed)` : "As designed"}</option>
            {fontOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div className="dx-g2">
          <Num c={c} label="Size" aria="Font size" property="font-size" units={["px", "rem", "em", "%"]} />
          <Select c={c} label="Weight" property="font-weight" options={WEIGHTS} />
        </div>
        <Colour c={c} label="Colour" aria="Text colour" property="color" />
        <div className="dx-g2">
          <div className="dx-f">
            <Label c={c} text="Style" props={["font-style", "text-decoration"]} />
            <div className="dx-segc" role="group" aria-label="Text style">
              <button type="button" aria-pressed={value("font-style") === "italic"} title="Italic" onClick={() => set("font-style", value("font-style") === "italic" ? null : "italic", true)}><i>I</i></button>
              <button type="button" aria-pressed={decorations.has("underline")} title="Underline" onClick={() => toggleDecoration("underline")}><u>U</u></button>
              <button type="button" aria-pressed={decorations.has("line-through")} title="Strikethrough" onClick={() => toggleDecoration("line-through")}><s>S</s></button>
            </div>
          </div>
          <Select c={c} label="Case" property="text-transform" options={CASES} />
        </div>
        <div className="dx-f">
          <Label c={c} text="Align" props={["text-align"]} />
          <Seg
            label="Text alignment"
            value={(value("text-align") || "") as string}
            options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }, { value: "justify", label: "Justify" }]}
            onChange={(next) => set("text-align", value("text-align") === next ? null : next, true)}
          />
        </div>
        <div className="dx-g2">
          <Num c={c} label="Line height" property="line-height" units={["", "px", "rem", "em", "%"]} placeholder="As designed" />
          <Num c={c} label="Letter spacing" property="letter-spacing" units={["px", "rem", "em", "%"]} placeholder="As designed" />
        </div>
      </Acc>

      <Acc title="Background" summary={value("background-color") || (bgImage ? "Image" : computed["background-color"] && computed["background-color"] !== "rgba(0, 0, 0, 0)" ? toHex(computed["background-color"]) ?? "Colour" : "None")} open={isSection}>
        <Colour c={c} label="Colour" aria="Background colour" property="background-color" />
        <div className="dx-f">
          <Label c={c} text="Image" props={["background-image"]} />
          <button type="button" className="dx-btn dx-soft dx-full" onClick={onPickBackgroundImage}>Choose from media or upload</button>
        </div>
        <div className="dx-f">
          <div className="dx-fl"><label htmlFor="dx-bg-url">Image URL</label></div>
          <input
            id="dx-bg-url"
            type="text"
            placeholder="/assets/… or https://…"
            defaultValue={bgImage}
            key={bgImage}
            onBlur={(event) => {
              const url = event.target.value.trim().replace(/['"\\]/g, "");
              if (url === bgImage) return;
              setMany({ "background-image": url ? `url('${url}')` : null });
            }}
          />
        </div>
        <div className="dx-g2">
          <Select c={c} label="Fit" aria="Background fit" property="background-size" options={[["Full (cover)", "cover"], ["Contain", "contain"], ["Original", "auto"], ["Stretch", "100% 100%"]]} />
          <div className="dx-f">
            <Label c={c} text="Position" props={["background-position"]} />
            <select aria-label="Background position" value={value("background-position")} onChange={(event) => set("background-position", event.target.value === "Default" ? null : event.target.value, true)}>
              {POSITIONS.map((option) => <option key={option} value={option === "Default" ? "" : option}>{option === "Default" ? option : option.replace(/\b\w/g, (letter) => letter.toUpperCase())}</option>)}
            </select>
          </div>
        </div>
      </Acc>

      <Acc title="Border" summary={value("border-style") === "none" || !shown("border-style") || shown("border-style") === "none" ? "None" : px(shown("border-width") || shown("border-top-width"))}>
        <div className="dx-g2">
          <Num c={c} label="Width" aria="Border width" property="border-width" units={["px"]} placeholder="0" />
          <Select c={c} label="Style" aria="Border style" property="border-style" options={[["Solid", "solid"], ["Dashed", "dashed"], ["Dotted", "dotted"], ["Double", "double"], ["None", "none"]]} />
        </div>
        <Colour c={c} label="Colour" aria="Border colour" property="border-color" />
        <Num c={c} label="Corner radius" property="border-radius" units={["px", "%", "rem"]} />
      </Acc>

      <Acc title="Effects" summary={`${SHADOW_PRESETS.find((option) => option.value === preset)?.label ?? "Custom"} · ${opacity}%`}>
        <Slider label="Opacity" min={0} max={100} unit="%" value={opacity} onChange={(next) => set("opacity", next === 100 ? null : String(next / 100))} />
        <div className="dx-f">
          <Label c={c} text="Shadow" props={["box-shadow"]} />
          <Tiles
            label="Shadow"
            options={SHADOW_PRESETS.map((option) => ({ value: option.value, label: option.label, demo: option.css }))}
            value={preset}
            onChange={(next) => set("box-shadow", next === "none" ? (computed["box-shadow"] && computed["box-shadow"] !== "none" ? "none" : null) : SHADOW_PRESETS.find((option) => option.value === next)?.css ?? null, true)}
          />
        </div>
        <button type="button" className="dx-fine" aria-expanded={fineShadow} onClick={() => setFineShadow((open) => !open)}>Fine-tune shadow</button>
        {fineShadow && (
          <>
            <Slider label="Distance" min={0} max={40} unit="px" value={shadow.distance} onChange={(next) => writeShadow({ distance: next })} />
            <Slider label="Blur" min={0} max={80} unit="px" value={shadow.blur} onChange={(next) => writeShadow({ blur: next })} />
            <Slider label="Size" min={-10} max={20} unit="px" value={shadow.size} onChange={(next) => writeShadow({ size: next })} />
            <Slider label="Strength" min={0} max={100} unit="%" value={shadow.strength} onChange={(next) => writeShadow({ strength: next })} />
            <div className="dx-f">
              <div className="dx-fl"><label>Shadow colour</label></div>
              <ColorCodeInput label="Shadow colour" className="dx-cbtn" value={`#${shadow.rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}`} onChange={(hex) => { const rgb = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)); if (rgb.every(Number.isFinite)) writeShadow({ rgb }); }} onCommit={onCommit} />
            </div>
          </>
        )}
      </Acc>

      <Acc title="Position" summary={position}>
        <Select c={c} label="Position type" property="position" options={[["Static", "static"], ["Relative", "relative"], ["Absolute", "absolute"], ["Fixed", "fixed"], ["Sticky", "sticky"]]} />
        <div className="dx-g2">
          <Num c={c} label="Top" property="top" units={["px", "%"]} placeholder="auto" />
          <Num c={c} label="Right" property="right" units={["px", "%"]} placeholder="auto" />
          <Num c={c} label="Bottom" property="bottom" units={["px", "%"]} placeholder="auto" />
          <Num c={c} label="Left" property="left" units={["px", "%"]} placeholder="auto" />
        </div>
        <Num c={c} label="Layer order" property="z-index" placeholder="auto" />
      </Acc>
    </fieldset>
  );
}


type Ctx = {
  map: Record<string, string>;
  computed: Record<string, string>;
  readOnly: boolean;
  set: (property: string, value: string | null, commit?: boolean) => void;
  setMany: (patch: Record<string, string | null>, commit?: boolean) => void;
  onCommit: () => void;
  spacingUnit: string;
};

  /** A label with its "Default" reset, shown only when there is something to reset. */
function Label({ c, text, props, htmlFor }: { c: Ctx; text: string; props: string[]; htmlFor?: string }) {
  const { map, setMany } = c;
  return (
    <div className="dx-fl">
      <label htmlFor={htmlFor}>{text}</label>
      {props.some((property) => map[property] !== undefined) && (
        <button type="button" className="dx-rs" title="Go back to the website default" onClick={() => setMany(Object.fromEntries(props.map((property) => [property, null])))}>
          Default
        </button>
      )}
    </div>
  );
}

  /** A number with its unit, blank for "as designed". */
function Num({ c, label, aria, property, units, placeholder }: { c: Ctx; label: string; aria?: string; property: string; units?: string[]; placeholder?: string }) {
  const { set, computed, readOnly, onCommit } = c;
  const value = (name: string) => c.map[name] ?? "";
    const current = value(property);
    const match = LENGTH.exec(current);
    const [unit, setUnit] = useState(match?.[2] || units?.[0] || "");
    const number = match ? match[1] : current;
    const write = (raw: string, nextUnit = unit) => {
      const trimmed = raw.trim();
      if (!trimmed) return set(property, null);
      set(property, /^-?\d*\.?\d+$/.test(trimmed) ? `${trimmed}${nextUnit}` : trimmed);
    };
    const computedPlaceholder = placeholder ?? (computed[property] ? String(Number.parseFloat(computed[property]) || computed[property]) : "As designed");
    return (
      <div className="dx-f">
        <Label c={c} text={label} props={[property]} />
        <div className="dx-inp dx-num">
          <input type="text" aria-label={aria ?? label} disabled={readOnly} value={number} placeholder={computedPlaceholder} onChange={(event) => write(event.target.value)} onBlur={onCommit} />
          {units && (
            <select
              className="dx-unit"
              aria-label={`${aria ?? label} unit`}
              disabled={readOnly}
              value={match?.[2] || unit}
              onChange={(event) => {
                setUnit(event.target.value);
                if (match) write(match[1], event.target.value);
              }}
            >
              {units.map((option) => <option key={option}>{option}</option>)}
            </select>
          )}
        </div>
      </div>
    );
}

function Select({ c, label, aria, property, options, placeholder = "As designed" }: { c: Ctx; label: string; aria?: string; property: string; options: [string, string][]; placeholder?: string }) {
  const { set, readOnly } = c;
  const value = (name: string) => c.map[name] ?? "";
  return (
    <div className="dx-f">
      <Label c={c} text={label} props={[property]} />
      <select aria-label={aria ?? label} disabled={readOnly} value={value(property)} onChange={(event) => set(property, event.target.value || null, true)}>
        <option value="">{placeholder}</option>
        {options.map(([name, css]) => <option key={css} value={css}>{name}</option>)}
      </select>
    </div>
  );
}

function Colour({ c, label, aria, property }: { c: Ctx; label: string; aria?: string; property: string }) {
  const { set, computed, readOnly, onCommit } = c;
  const value = (name: string) => c.map[name] ?? "";
  return (
    <div className="dx-f">
      <Label c={c} text={label} props={[property]} />
      <ColorCodeInput
        label={aria ?? label}
        className="dx-cbtn"
        value={value(property)}
        placeholder={toHex(computed[property] ?? "") ?? "#000000"}
        disabled={readOnly}
        onChange={(next) => set(property, next || null)}
        onCommit={onCommit}
      />
    </div>
  );
}

function SideInput({ c, property, side }: { c: Ctx; property: string; side: "t" | "r" | "b" | "l" }) {
  const { set, computed, readOnly, onCommit, spacingUnit } = c;
  const value = (name: string) => c.map[name] ?? "";
    const current = value(property);
    const match = LENGTH.exec(current);
    return (
      <input
        className={side}
        aria-label={property.replace("-", " ")}
        disabled={readOnly}
        value={match ? (match[2] === "px" ? match[1] : current) : current}
        placeholder={String(Math.round(Number.parseFloat(computed[property] ?? "0")) || 0)}
        onChange={(event) => {
          const raw = event.target.value.trim();
          set(property, !raw ? null : /^-?\d*\.?\d+$/.test(raw) ? `${raw}${spacingUnit}` : raw);
        }}
        onBlur={onCommit}
      />
    );
  }

/** `padding: 4px 8px` and friends become four sides, so a side can change on its own. */
function expandShorthands(map: Record<string, string>): Record<string, string> {
  const out = { ...map };
  for (const box of ["padding", "margin"] as const) {
    const short = out[box];
    if (!short || /var\(|calc\(/i.test(short)) continue;
    const parts = short.trim().split(/\s+/);
    if (parts.length < 1 || parts.length > 4) continue;
    const [top, right = top, bottom = top, left = right] = parts;
    delete out[box];
    for (const [side, part] of [["top", top], ["right", right], ["bottom", bottom], ["left", left]] as const) {
      if (out[`${box}-${side}`] === undefined) out[`${box}-${side}`] = part;
    }
  }
  return out;
}

function readShadow(css: string): { distance: number; blur: number; size: number; strength: number; rgb: number[] } {
  const fallback = { distance: 8, blur: 20, size: 0, strength: 20, rgb: [0, 0, 0] };
  if (!css || css === "none" || /inset/.test(css)) return fallback;
  const numbers = [...css.replace(/rgba?\([^)]*\)/, "").matchAll(/(-?\d*\.?\d+)px|(?:^|\s)(0)(?=\s|$)/g)].map((match) => Number(match[1] ?? match[2]));
  const rgba = /rgba?\(([^)]*)\)/.exec(css)?.[1]?.split(",").map((part) => Number.parseFloat(part));
  return {
    distance: numbers[1] ?? fallback.distance,
    blur: numbers[2] ?? fallback.blur,
    size: numbers[3] ?? 0,
    strength: rgba && rgba.length === 4 ? Math.round(rgba[3] * 100) : 100,
    rgb: rgba ? rgba.slice(0, 3).map((part) => Math.round(part)) : [0, 0, 0],
  };
}

