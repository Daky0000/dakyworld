import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The style half of the visual editor.
 *
 * Deliberately a fixed set of controls over an inline `style` attribute, not a
 * CSS box. Two reasons, and the second is the one that matters:
 *
 * A person who wants their heading bigger does not want a text box that takes
 * CSS. They want a bigger-looking heading, and every wrong thing they can type
 * into a free-text box is a broken page they cannot see the cause of.
 *
 * And the site is somebody's hand-written HTML that a developer goes on working
 * in. A rule added to a stylesheet would apply to every page at once and to
 * elements nobody was editing; an inline style changes exactly the element that
 * was clicked, and reads in the published diff as exactly that. The server
 * filters what it is sent regardless — see `safeStyle` — so nothing here is
 * load-bearing for safety, only for sanity.
 *
 * Anything the panel does not have a control for is left untouched: an unknown
 * declaration already on the element rides through the parse and back out
 * again, so editing the colour of something never quietly drops the rest of
 * what a developer wrote on it.
 *
 * The one place that rule is bent is Filter, which is a CSS string typed by
 * hand. It is behind an "Add" link rather than on the panel, so nobody meets it
 * who did not go looking for it, and an unparseable value does nothing rather
 * than breaking the layout.
 *
 * Numbers scrub: drag left and right on a field's label. Colours open one
 * popover — the brand swatches, a picker, a hex box and an alpha slider — so a
 * translucent overlay is as reachable as a brand colour.
 */

/** Ink, blue, lime and the neutrals — the design system, as swatches. */
const COLOURS = [
  { label: "Ink", value: "#08101F" },
  { label: "Muted", value: "#69758A" },
  { label: "Blue", value: "#3157FF" },
  { label: "Blue light", value: "#6490FF" },
  { label: "Cyan", value: "#6FE4FF" },
  { label: "Lime", value: "#B8FF3D" },
  { label: "Cream", value: "#F4F5F0" },
  { label: "White", value: "#FFFFFF" },
];

/** The faces the site actually uses, plus the two obvious fallbacks. */
const FONTS = [
  { label: "As designed", value: "" },
  { label: "Space Grotesk (display)", value: '"Space Grotesk", sans-serif' },
  { label: "DM Sans (body)", value: '"DM Sans", sans-serif' },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "System sans", value: "system-ui, -apple-system, sans-serif" },
  { label: "Monospace", value: "ui-monospace, SFMono-Regular, Menlo, monospace" },
];

const WEIGHTS = [
  { label: "As designed", value: "" },
  { label: "Light", value: "300" },
  { label: "Normal", value: "400" },
  { label: "Medium", value: "500" },
  { label: "Semibold", value: "600" },
  { label: "Bold", value: "700" },
  { label: "Black", value: "900" },
];

const CASES = [
  { label: "As designed", value: "" },
  { label: "UPPERCASE", value: "uppercase" },
  { label: "lowercase", value: "lowercase" },
  { label: "Capitalise", value: "capitalize" },
  { label: "Normal", value: "none" },
];

const OVERFLOWS = ["", "visible", "hidden", "auto", "scroll"];
const BORDER_STYLES = ["solid", "dashed", "dotted", "double", "none"];

/** `"color: red; font-size: 20px"` → `{ color: "red", "font-size": "20px" }`. */
export function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of (style ?? "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property && value) out[property] = value;
  }
  return out;
}

/** Back to a declaration string, in the order the properties were set. */
export function writeStyle(declarations: Record<string, string>): string {
  return Object.entries(declarations)
    .filter(([, value]) => value !== "")
    .map(([property, value]) => `${property}: ${value}`)
    .join("; ");
}

/* ------------------------------------------------------------------ values */

const SIDES = ["top", "right", "bottom", "left"] as const;
type Side = (typeof SIDES)[number];

/**
 * A developer may have written `padding: 4px 8px`. The panel edits four sides,
 * so the shorthand is expanded on the way in and only the longhands are written
 * on the way out — otherwise the two would fight and the shorthand would win.
 */
function expandBox(declarations: Record<string, string>, property: "padding" | "margin"): Record<string, string> {
  const shorthand = declarations[property];
  if (!shorthand) return declarations;
  const parts = shorthand.split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 4) return declarations;
  const [t, r = t, b = t, l = r] = parts;
  const next = { ...declarations };
  delete next[property];
  const values: Record<Side, string> = { top: t!, right: r!, bottom: b!, left: l! };
  for (const side of SIDES) {
    if (next[`${property}-${side}`] === undefined) next[`${property}-${side}`] = values[side];
  }
  return next;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const match = /^-?[\d.]+/.exec(value.trim());
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `#3157FF` + 40% → `rgba(49, 87, 255, .4)`, and back. */
function hexToRgb(hex: string): [number, number, number] | null {
  let value = hex.replace("#", "").trim();
  if (value.length === 3) value = value[0]! + value[0] + value[1] + value[1] + value[2] + value[2];
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

type Colour = { hex: string; alpha: number };

function readColour(value: string | undefined): Colour {
  const raw = (value ?? "").trim();
  if (!raw) return { hex: "#08101F", alpha: 1 };
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i.exec(raw);
  if (rgba) {
    const alphaRaw = rgba[4];
    const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
    return { hex: rgbToHex(Number(rgba[1]), Number(rgba[2]), Number(rgba[3])), alpha: Number.isFinite(alpha) ? alpha : 1 };
  }
  const hex8 = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(raw);
  if (hex8) return { hex: `#${hex8[1]!.toUpperCase()}`, alpha: parseInt(hex8[2]!, 16) / 255 };
  const rgb = hexToRgb(raw);
  if (rgb) return { hex: rgbToHex(...rgb), alpha: 1 };
  return { hex: "#08101F", alpha: 1 };
}

function writeColour({ hex, alpha }: Colour): string {
  if (alpha >= 1) return hex.toUpperCase();
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(alpha.toFixed(2))})`;
}

/* ------------------------------------------------------------- primitives */

const FIELD =
  "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-line bg-white px-2 focus-within:border-blue focus-within:ring-2 focus-within:ring-blue/15";
const NUM = "w-full min-w-0 bg-transparent text-right font-mono text-[11px] text-ink outline-none";
const SELECT = "w-full min-w-0 bg-transparent text-right text-[11px] text-ink outline-none cursor-pointer";
const LABEL = "shrink-0 text-[10px] uppercase tracking-[.08em] text-muted";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line px-4 py-3.5 last:border-b-0">
      <div className="mb-2.5 font-mono text-[10px] font-bold uppercase tracking-[.14em] text-muted">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/**
 * A number, draggable by its label.
 *
 * Blank is a real value everywhere it appears — it means "as designed", the
 * element keeping whatever the stylesheet gives it. That is why these are text
 * fields holding numbers rather than `<input type="number">` with a zero in it.
 */
function NumberField({
  label,
  value,
  unit,
  step = 1,
  min,
  max,
  placeholder = "auto",
  disabled,
  onChange,
  onCommit,
}: {
  label: string;
  value: number | null;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: number | null) => void;
  onCommit?: () => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(value === null ? "" : String(value));
  }, [value]);

  const clamp = (next: number) => {
    let out = next;
    if (min !== undefined && out < min) out = min;
    if (max !== undefined && out > max) out = max;
    return Number(out.toFixed(step < 1 ? 2 : 0));
  };

  const scrub = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    event.preventDefault();
    const label = event.currentTarget;
    const startX = event.clientX;
    const base = value ?? 0;
    try {
      label.setPointerCapture(event.pointerId);
    } catch {
      /* a synthetic pointer the element does not own */
    }
    const move = (moved: PointerEvent) => {
      const next = clamp(base + (moved.clientX - startX) * step);
      setText(String(next));
      onChange(next);
    };
    const up = (ended: PointerEvent) => {
      try {
        label.releasePointerCapture(ended.pointerId);
      } catch {
        /* as above */
      }
      label.removeEventListener("pointermove", move);
      label.removeEventListener("pointerup", up);
      onCommit?.();
    };
    label.addEventListener("pointermove", move);
    label.addEventListener("pointerup", up);
  };

  return (
    <div className={FIELD}>
      <span className={`${LABEL} cursor-ew-resize select-none`} title={`${label} — drag to change`} onPointerDown={scrub}>
        {label}
      </span>
      <input
        className={NUM}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        inputMode="decimal"
        onFocus={() => (editing.current = true)}
        onBlur={() => {
          editing.current = false;
          onCommit?.();
        }}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (raw.trim() === "") return onChange(null);
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(clamp(parsed));
        }}
      />
      {unit && <span className="shrink-0 font-mono text-[9px] text-muted">{unit}</span>}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div className={FIELD}>
      <span className={LABEL}>{label}</span>
      <select className={SELECT} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const CHECKER =
  "repeating-conic-gradient(#0000 0% 25%, rgba(8,16,31,.14) 0% 50%) 50% / 8px 8px";

/**
 * One popover for every colour on the panel.
 *
 * The brand swatches are first because they are the right answer nearly every
 * time; the picker, the hex box and the alpha slider are underneath for the
 * times they are not.
 */
function ColourField({
  label,
  value,
  allowNone,
  disabled,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  allowNone?: boolean;
  disabled?: boolean;
  onChange: (next: string) => void;
  onCommit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const colour = readColour(value);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const set = (next: Partial<Colour>) => onChange(writeColour({ ...colour, ...next }));

  return (
    <div className="relative" ref={box}>
      <div className={FIELD}>
        <span className={LABEL}>{label}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((was) => !was)}
          className="ml-auto flex items-center gap-1.5"
          title={value || "As designed"}
        >
          <span className="h-4 w-4 shrink-0 rounded border border-line-strong" style={{ background: CHECKER }}>
            <span className="block h-full w-full rounded" style={{ backgroundColor: value || "transparent" }} />
          </span>
          <span className="font-mono text-[9px] uppercase text-muted">{value ? colour.hex.replace("#", "") : "auto"}</span>
        </button>
      </div>

      {open && !disabled && (
        <div className="absolute right-0 z-30 mt-1.5 w-[228px] rounded-xl border border-line bg-white p-3 shadow-lg shadow-ink/10">
          <div className="grid grid-cols-8 gap-1">
            {COLOURS.map((option) => (
              <button
                key={option.value}
                type="button"
                title={option.label}
                onClick={() => {
                  onChange(option.value);
                  onCommit?.();
                }}
                className={`h-5 w-full rounded border ${
                  colour.hex.toUpperCase() === option.value.toUpperCase() ? "border-blue ring-2 ring-blue/25" : "border-line-strong"
                }`}
                style={{ backgroundColor: option.value }}
              />
            ))}
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="color"
              className="h-7 w-9 cursor-pointer rounded border border-line bg-white p-0.5"
              value={colour.hex}
              onChange={(event) => set({ hex: event.target.value.toUpperCase() })}
              onBlur={() => onCommit?.()}
            />
            <div className="flex h-7 flex-1 items-center gap-1 rounded-xl border border-line px-2">
              <span className="text-[10px] text-muted">#</span>
              <input
                className="w-full bg-transparent font-mono text-[11px] uppercase text-ink outline-none"
                maxLength={6}
                value={colour.hex.replace("#", "")}
                onChange={(event) => {
                  const next = event.target.value.replace(/[^0-9a-f]/gi, "");
                  if (next.length === 6) set({ hex: `#${next.toUpperCase()}` });
                }}
                onBlur={() => onCommit?.()}
              />
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[.08em] text-muted">Alpha</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(colour.alpha * 100)}
              onChange={(event) => set({ alpha: Number(event.target.value) / 100 })}
              onPointerUp={() => onCommit?.()}
              className="h-1.5 flex-1 accent-blue"
            />
            <span className="w-8 text-right font-mono text-[10px] text-muted">{Math.round(colour.alpha * 100)}%</span>
          </div>

          {allowNone && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                onCommit?.();
                setOpen(false);
              }}
              className="mt-2.5 w-full rounded-xl border border-line py-1.5 text-[11px] font-semibold text-muted transition hover:border-ink/30 hover:text-ink"
            >
              As designed
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IconToggle({
  on,
  title,
  disabled,
  onClick,
  children,
}: {
  on: boolean;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border text-[13px] transition ${
        on ? "border-blue bg-blue/10 text-blue" : "border-line bg-white text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Segmented({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: { value: string; label: React.ReactNode; title: string }[];
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex h-8 flex-1 overflow-hidden rounded-xl border border-line bg-white">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value === value ? "" : option.value)}
          className={`flex flex-1 items-center justify-center border-r border-line text-[11px] last:border-r-0 transition ${
            value === option.value ? "bg-blue/10 text-blue" : "text-muted hover:bg-sunken hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SubBlock({ title, onRemove, children }: { title: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-cream/60 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-ink">{title}</span>
        <button type="button" onClick={onRemove} className="text-[10px] text-muted transition hover:text-danger-text">
          Remove
        </button>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

type Extra = "box-shadow" | "text-shadow" | "transform" | "filter";

const EXTRA_LABEL: Record<Extra, string> = {
  "box-shadow": "shadow",
  "text-shadow": "text shadow",
  transform: "transform",
  filter: "filter",
};

const EXTRA_SEED: Record<Extra, string> = {
  "box-shadow": "0 4px 12px 0 rgba(8, 16, 31, 0.15)",
  "text-shadow": "0 2px 6px rgba(8, 16, 31, 0.15)",
  transform: "translate(0px, 0px) rotate(0deg) scale(1, 1)",
  filter: "blur(0px)",
};

function readShadow(value: string | undefined, spread: boolean) {
  const parts = (value ?? "").trim().match(/^(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(?:(-?[\d.]+)px\s+)?(.+)$/);
  if (!parts) return { x: 0, y: spread ? 4 : 2, blur: spread ? 12 : 6, spread: 0, colour: "rgba(8, 16, 31, 0.15)" };
  return {
    x: Number(parts[1]),
    y: Number(parts[2]),
    blur: Number(parts[3]),
    spread: parts[4] === undefined ? 0 : Number(parts[4]),
    colour: parts[5]!.trim(),
  };
}

function readTransform(value: string | undefined) {
  const source = value ?? "";
  const translate = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(source);
  const rotate = /rotate\(\s*(-?[\d.]+)deg\s*\)/.exec(source);
  const scale = /scale\(\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*)?\)/.exec(source);
  return {
    x: translate ? Number(translate[1]) : 0,
    y: translate ? Number(translate[2]) : 0,
    rotate: rotate ? Number(rotate[1]) : 0,
    scaleX: scale ? Number(scale[1]) : 1,
    scaleY: scale ? Number(scale[2] ?? scale[1]) : 1,
  };
}

export function StylePanel({
  style,
  onChange,
  onReset,
  onCommit,
  readOnly,
}: {
  style: string | undefined;
  onChange: (next: string) => void;
  onReset: () => void;
  /** Called when a continuous gesture ends, so history can record one step. */
  onCommit?: () => void;
  readOnly?: boolean;
}) {
  const declarations = useMemo(() => expandBox(parseStyle(style), "padding"), [style]);
  const disabled = !!readOnly;

  const set = (property: string, value: string) => {
    const next = { ...declarations };
    if (value) next[property] = value;
    else delete next[property];
    onChange(writeStyle(next));
  };
  const setMany = (patch: Record<string, string>) => {
    const next = { ...declarations };
    for (const [property, value] of Object.entries(patch)) {
      if (value) next[property] = value;
      else delete next[property];
    }
    onChange(writeStyle(next));
  };
  const px = (property: string, value: number | null) => set(property, value === null ? "" : `${value}px`);

  const extras = (Object.keys(EXTRA_LABEL) as Extra[]).filter((key) => declarations[key] !== undefined);
  const missing = (Object.keys(EXTRA_LABEL) as Extra[]).filter((key) => declarations[key] === undefined);

  // Every property this panel does not own, so the person editing can see that
  // the developer's own styling is still there rather than wondering where it
  // went.
  const owned = new Set([
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-decoration",
    "text-align",
    "text-transform",
    "line-height",
    "letter-spacing",
    "width",
    "height",
    "opacity",
    "border-radius",
    "overflow",
    "border",
    "display",
    "box-shadow",
    "text-shadow",
    "transform",
    "filter",
    ...SIDES.map((side) => `padding-${side}`),
  ]);
  const untouched = Object.entries(declarations).filter(([property]) => !owned.has(property));

  const decoration = declarations["text-decoration"] ?? "";
  const border = declarations.border;
  const borderParts = border ? /^(-?[\d.]+)px\s+(\w+)\s+(.+)$/.exec(border.trim()) : null;

  return (
    <div className={disabled ? "pointer-events-none opacity-50" : ""}>
      <Section title="Appearance">
        <ColourField
          label="Background"
          value={declarations["background-color"] ?? ""}
          allowNone
          disabled={disabled}
          onChange={(next) => set("background-color", next)}
          onCommit={onCommit}
        />

        <div className="flex gap-1.5">
          <NumberField label="W" unit="px" value={toNumber(declarations.width)} min={0} onChange={(next) => px("width", next)} onCommit={onCommit} />
          <NumberField label="H" unit="px" value={toNumber(declarations.height)} min={0} onChange={(next) => px("height", next)} onCommit={onCommit} />
        </div>

        <div className="flex gap-1.5">
          <NumberField
            label="Opacity"
            value={toNumber(declarations.opacity)}
            step={0.05}
            min={0}
            max={1}
            onChange={(next) => set("opacity", next === null ? "" : String(next))}
            onCommit={onCommit}
          />
          <NumberField
            label="Radius"
            unit="px"
            value={toNumber(declarations["border-radius"])}
            min={0}
            onChange={(next) => px("border-radius", next)}
            onCommit={onCommit}
          />
        </div>

        <SelectField
          label="Overflow"
          value={declarations.overflow ?? ""}
          disabled={disabled}
          onChange={(next) => set("overflow", next)}
          options={OVERFLOWS.map((value) => ({ value, label: value || "As designed" }))}
        />

        <div className="pt-1 text-[10px] uppercase tracking-[.08em] text-muted">Padding</div>
        <div className="grid grid-cols-2 gap-1.5">
          {SIDES.map((side) => (
            <NumberField
              key={side}
              label={side}
              unit="px"
              value={toNumber(declarations[`padding-${side}`])}
              min={0}
              onChange={(next) => px(`padding-${side}`, next)}
              onCommit={onCommit}
            />
          ))}
        </div>

        {extras.map((key) => {
          if (key === "filter") {
            return (
              <SubBlock key={key} title="Filter" onRemove={() => set("filter", "")}>
                <input
                  className="h-8 w-full rounded-xl border border-line bg-white px-2 font-mono text-[11px] text-ink outline-none focus:border-blue"
                  value={declarations.filter ?? ""}
                  placeholder="blur(2px) grayscale(.4)"
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
              <SubBlock key={key} title="Transform" onRemove={() => set("transform", "")}>
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
          const spread = key === "box-shadow";
          const shadow = readShadow(declarations[key], spread);
          const write = (patch: Partial<typeof shadow>) => {
            const next = { ...shadow, ...patch };
            set(
              key,
              spread
                ? `${next.x}px ${next.y}px ${next.blur}px ${next.spread}px ${next.colour}`
                : `${next.x}px ${next.y}px ${next.blur}px ${next.colour}`,
            );
          };
          return (
            <SubBlock key={key} title={spread ? "Shadow" : "Text shadow"} onRemove={() => set(key, "")}>
              <div className="grid grid-cols-2 gap-1.5">
                <NumberField label="X" unit="px" value={shadow.x} placeholder="0" onChange={(next) => write({ x: next ?? 0 })} onCommit={onCommit} />
                <NumberField label="Y" unit="px" value={shadow.y} placeholder="0" onChange={(next) => write({ y: next ?? 0 })} onCommit={onCommit} />
                <NumberField label="Blur" unit="px" value={shadow.blur} min={0} placeholder="0" onChange={(next) => write({ blur: next ?? 0 })} onCommit={onCommit} />
                {spread && (
                  <NumberField label="Spread" unit="px" value={shadow.spread} placeholder="0" onChange={(next) => write({ spread: next ?? 0 })} onCommit={onCommit} />
                )}
              </div>
              <ColourField label="Colour" value={shadow.colour} disabled={disabled} onChange={(next) => write({ colour: next })} onCommit={onCommit} />
            </SubBlock>
          );
        })}

        {missing.length > 0 && (
          <div className="pt-1 text-[11px] text-muted">
            Add:{" "}
            {missing.map((key, index) => (
              <span key={key}>
                {index > 0 && " · "}
                <button
                  type="button"
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
      </Section>

      <Section title="Typography">
        <SelectField label="Font" value={declarations["font-family"] ?? ""} disabled={disabled} onChange={(next) => set("font-family", next)} options={FONTS} />

        <div className="flex gap-1.5">
          <NumberField label="Size" unit="px" value={toNumber(declarations["font-size"])} min={1} onChange={(next) => px("font-size", next)} onCommit={onCommit} />
          <ColourField label="Colour" value={declarations.color ?? ""} allowNone disabled={disabled} onChange={(next) => set("color", next)} onCommit={onCommit} />
        </div>

        <SelectField label="Weight" value={declarations["font-weight"] ?? ""} disabled={disabled} onChange={(next) => set("font-weight", next)} options={WEIGHTS} />

        <div className="flex gap-1.5">
          <IconToggle
            on={declarations["font-style"] === "italic"}
            title="Italic"
            disabled={disabled}
            onClick={() => {
              set("font-style", declarations["font-style"] === "italic" ? "" : "italic");
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
              set("text-decoration", decoration.includes("underline") ? decoration.replace("underline", "").trim() : `${decoration} underline`.trim());
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
                decoration.includes("line-through") ? decoration.replace("line-through", "").trim() : `${decoration} line-through`.trim(),
              );
              onCommit?.();
            }}
          >
            <span className="font-serif line-through">S</span>
          </IconToggle>
          <div className="flex-1" />
        </div>

        <Segmented
          value={declarations["text-align"] ?? ""}
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

        <div className="flex gap-1.5">
          <NumberField
            label="Leading"
            value={toNumber(declarations["line-height"])}
            step={0.05}
            min={0}
            onChange={(next) => set("line-height", next === null ? "" : String(next))}
            onCommit={onCommit}
          />
          <NumberField
            label="Tracking"
            unit="em"
            value={toNumber(declarations["letter-spacing"])}
            step={0.01}
            onChange={(next) => set("letter-spacing", next === null ? "" : `${next}em`)}
            onCommit={onCommit}
          />
        </div>

        <SelectField label="Case" value={declarations["text-transform"] ?? ""} disabled={disabled} onChange={(next) => set("text-transform", next)} options={CASES} />
      </Section>

      <Section title="Border">
        {borderParts ? (
          <SubBlock
            title="Border"
            onRemove={() => {
              set("border", "");
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
                options={BORDER_STYLES.map((value) => ({ value, label: value }))}
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
            onClick={() => {
              set("border", "1px solid #08101F");
              onCommit?.();
            }}
            className="w-full rounded-xl border border-dashed border-line py-2 text-[11px] font-semibold text-muted transition hover:border-blue hover:text-blue"
          >
            + Add border
          </button>
        )}
      </Section>

      {(untouched.length > 0 || style) && (
        <div className="px-4 py-3.5">
          {untouched.length > 0 && (
            <div className="mb-2 rounded-xl bg-cream/70 px-2.5 py-2 text-[10px] leading-relaxed text-muted">
              <span className="font-semibold text-muted">Also on this element, left alone:</span>{" "}
              <span className="font-mono">{untouched.map(([property, value]) => `${property}: ${value}`).join("; ")}</span>
            </div>
          )}
          {style && (
            <button
              type="button"
              onClick={() => {
                onReset();
                onCommit?.();
              }}
              className="text-[11px] text-muted underline-offset-2 transition hover:text-ink hover:underline"
            >
              Put this element back as designed
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The three little bars on an alignment button. */
function Lines({ widths, align }: { widths: number[]; align: "start" | "center" | "end" }) {
  return (
    <span className={`flex w-[14px] flex-col gap-[2px] ${align === "center" ? "items-center" : align === "end" ? "items-end" : "items-start"}`}>
      {widths.map((width, index) => (
        <span key={index} className="h-[1.5px] bg-current" style={{ width }} />
      ))}
    </span>
  );
}
