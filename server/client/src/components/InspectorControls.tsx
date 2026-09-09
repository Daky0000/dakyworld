import { createContext, useContext, useEffect, useRef, useState } from "react";

/**
 * The controls the inspector is built from, and the style string they write.
 *
 * These were the `StylePanel`, which both owned this set of widgets and decided
 * which of them a selected element got. `ElementInspector` now makes that second
 * decision — from what the element is, rather than from what CSS exists — and
 * this file is left holding only the widgets and the parsing. Everything below
 * is unchanged in behaviour; the notes are the original ones and still apply.
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
export const PaletteContext = createContext<{ label: string; value: string }[] | null>(null);
export const COLOURS = [
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
export const FONTS = [
  { label: "As designed", value: "" },
  { label: "Space Grotesk", value: '"Space Grotesk", sans-serif' },
  { label: "DM Sans", value: '"DM Sans", sans-serif' },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "System sans", value: "system-ui, -apple-system, sans-serif" },
  { label: "Mono", value: "ui-monospace, SFMono-Regular, Menlo, monospace" },
];

export const WEIGHTS = [
  { label: "As designed", value: "" },
  { label: "Light", value: "300" },
  { label: "Normal", value: "400" },
  { label: "Medium", value: "500" },
  { label: "Semibold", value: "600" },
  { label: "Bold", value: "700" },
  { label: "Black", value: "900" },
];

export const CASES = [
  { label: "As designed", value: "" },
  { label: "UPPERCASE", value: "uppercase" },
  { label: "lowercase", value: "lowercase" },
  { label: "Capitalise", value: "capitalize" },
  { label: "Normal", value: "none" },
];

export const OVERFLOWS = ["", "visible", "hidden", "auto", "scroll"];
export const BORDER_STYLES = ["solid", "dashed", "dotted", "double", "none"];

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

export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];

/**
 * A developer may have written `padding: 4px 8px`. The panel edits four sides,
 * so the shorthand is expanded on the way in and only the longhands are written
 * on the way out — otherwise the two would fight and the shorthand would win.
 */
export function expandBox(declarations: Record<string, string>, property: "padding" | "margin"): Record<string, string> {
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

export function toNumber(value: string | undefined): number | null {
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

export type Colour = { hex: string; alpha: number };

export function readColour(value: string | undefined): Colour {
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

export function writeColour({ hex, alpha }: Colour): string {
  if (alpha >= 1) return hex.toUpperCase();
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(alpha.toFixed(2))})`;
}

/* ------------------------------------------------------------- primitives */

/**
 * The look of a control, in one place.
 *
 * Inputs sit on the sunken surface rather than on white with a border. A panel
 * of thirty bordered pills reads as thirty objects; a panel of thirty quiet
 * wells reads as one instrument, and the border comes back the moment something
 * is focused. Every control is the same height, because a column of controls
 * whose heights disagree is the single thing that makes a panel look homemade.
 */
export const CONTROL_HEIGHT = "h-7";
export const FIELD =
  `flex ${CONTROL_HEIGHT} min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-transparent bg-sunken px-2 transition focus-within:border-blue focus-within:bg-white focus-within:ring-2 focus-within:ring-blue/15 hover:border-line-strong`;
const NUM = "w-full min-w-0 bg-transparent text-right font-mono text-[11px] text-ink outline-none placeholder:text-faint";
const SELECT = "w-full min-w-0 cursor-pointer bg-transparent text-right text-[11px] text-ink outline-none";
export const LABEL = "shrink-0 text-[10px] uppercase tracking-[.08em] text-muted";

/**
 * A group of controls, open or shut.
 *
 * Collapsible because a contextual inspector still has more in it than anybody
 * looks at in one go, and the section that matters is different every time. The
 * dot on the right is what makes a shut section honest: it says this group is
 * carrying a change even while you cannot see it, which is the one thing a
 * collapsed section can otherwise hide from somebody.
 */
export function Section({
  title,
  name,
  children,
  open = true,
  changed,
  onToggle,
  action,
}: {
  title: string;
  /** A stable hook for tests, so a restyle cannot silently break one. */
  name?: string;
  children: React.ReactNode;
  open?: boolean;
  /** Something in here has been overridden. */
  changed?: boolean;
  onToggle?: () => void;
  /** A control that belongs to the group's heading rather than to a property. */
  action?: React.ReactNode;
}) {
  return (
    <section data-section={name ?? title} className="border-b border-line last:border-b-0">
      <div className="flex items-center gap-1 px-3 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          disabled={!onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-2.5 text-left text-[11px] font-semibold tracking-[.01em] text-ink transition hover:text-blue disabled:cursor-default disabled:hover:text-ink"
        >
          {onToggle && (
            <span aria-hidden className={`text-[8px] text-faint transition-transform ${open ? "rotate-90" : ""}`}>
              ▶
            </span>
          )}
          <span className="truncate">{title}</span>
          {changed && <span aria-label="Changed here" title="Something in this group has been changed" className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue" />}
        </button>
        {action}
      </div>
      {open && <div className="space-y-1 px-3 pb-3">{children}</div>}
    </section>
  );
}

/**
 * A row: what the property is called, the control, and where its value is from.
 *
 * One line rather than a label above a box, because a panel three hundred pixels
 * wide has no vertical space to spend on saying twice what a control already
 * shows. The right-hand rail is a fixed width so that every origin in the panel
 * lines up — a ragged right edge is what makes this kind of panel feel busy.
 */
export function Row({ label, control, rail }: { label?: string; control: React.ReactNode; rail?: React.ReactNode }) {
  return (
    <div data-row className="flex min-w-0 items-center gap-2">
      {label !== undefined && <span title={label} className="w-[62px] shrink-0 truncate text-[10px] uppercase tracking-[.04em] text-muted">{label}</span>}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{control}</div>
      <div className="flex w-[50px] shrink-0 justify-end">{rail}</div>
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
export function NumberField({
  label,
  value,
  unit,
  step = 1,
  min,
  max,
  placeholder = "auto",
  disabled,
  bare,
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
  /** The row already says what this is; the scrub handle moves onto the unit. */
  bare?: boolean;
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
      {!bare && (
        <span className={`${LABEL} cursor-ew-resize select-none`} title={`${label} — drag to change`} onPointerDown={scrub}>
          {label}
        </span>
      )}
      <input
        aria-label={label}
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
      <span
        className={`shrink-0 cursor-ew-resize select-none font-mono text-[9px] ${unit ? "text-muted" : "text-faint"}`}
        title={`${label} — drag to change`}
        onPointerDown={scrub}
      >
        {unit || "⇔"}
      </span>
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  disabled,
  bare,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  disabled?: boolean;
  /** The row already says what this is; do not say it twice. */
  bare?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div className={FIELD}>
      {!bare && <span className={LABEL}>{label}</span>}
      <select aria-label={label} className={`${SELECT} ${bare ? "text-left" : "text-right"}`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
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
export function ColourField({
  label,
  value,
  allowNone,
  disabled,
  bare,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  allowNone?: boolean;
  disabled?: boolean;
  bare?: boolean;
  onChange: (next: string) => void;
  onCommit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const colour = readColour(value);
  const palette = useContext(PaletteContext) ?? COLOURS;

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
        {!bare && <span className={LABEL}>{label}</span>}
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((was) => !was)}
          className={`flex items-center gap-1.5 ${bare ? "w-full" : "ml-auto"}`}
          title={value || "As designed"}
        >
          <span className="h-3.5 w-3.5 shrink-0 rounded border border-line-strong" style={{ background: CHECKER }}>
            <span className="block h-full w-full rounded" style={{ backgroundColor: value || "transparent" }} />
          </span>
          <span className="font-mono text-[10px] uppercase text-ink">{value ? colour.hex.replace("#", "") : "auto"}</span>
        </button>
      </div>

      {open && !disabled && (
        <div className="absolute right-0 z-30 mt-1.5 w-[228px] rounded-xl border border-line bg-white p-3 shadow-lg shadow-ink/10">
          <div className="grid grid-cols-8 gap-1">
            {palette.map((option) => (
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

export function IconToggle({
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
      className={`flex ${CONTROL_HEIGHT} w-7 shrink-0 items-center justify-center rounded-lg text-[12px] transition ${
        on ? "bg-blue text-white" : "bg-sunken text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function Segmented({
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
    <div className={`flex ${CONTROL_HEIGHT} flex-1 overflow-hidden rounded-lg bg-sunken p-0.5`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value === value ? "" : option.value)}
          className={`flex flex-1 items-center justify-center rounded-[5px] text-[11px] transition ${
            value === option.value ? "bg-white text-ink shadow-sm shadow-ink/10" : "text-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SubBlock({ title, onRemove, children }: { title: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-sunken p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[.06em] text-muted">{title}</span>
        <button type="button" onClick={onRemove} className="text-[10px] text-muted transition hover:text-danger-text">
          Remove
        </button>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

export type Extra = "box-shadow" | "text-shadow" | "transform" | "filter";

export const EXTRA_LABEL: Record<Extra, string> = {
  "box-shadow": "shadow",
  "text-shadow": "text shadow",
  transform: "transform",
  filter: "filter",
};

export const EXTRA_SEED: Record<Extra, string> = {
  "box-shadow": "0 4px 12px 0 rgba(8, 16, 31, 0.15)",
  "text-shadow": "0 2px 6px rgba(8, 16, 31, 0.15)",
  transform: "translate(0px, 0px) rotate(0deg) scale(1, 1)",
  filter: "blur(0px)",
};

export function readShadow(value: string | undefined, spread: boolean) {
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

export function readTransform(value: string | undefined) {
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

/** The three little bars on an alignment button. */
export function Lines({ widths, align }: { widths: number[]; align: "start" | "center" | "end" }) {
  return (
    <span className={`flex w-[14px] flex-col gap-[2px] ${align === "center" ? "items-center" : align === "end" ? "items-end" : "items-start"}`}>
      {widths.map((width, index) => (
        <span key={index} className="h-[1.5px] bg-current" style={{ width }} />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ icons */

/**
 * The layout controls, as pictures.
 *
 * "space-between" is a phrase somebody has to learn; five boxes pushed to the
 * edges of a frame is the thing itself. Every icon here draws the arrangement it
 * sets, at the size it is set at, which is why they are hand-drawn rectangles
 * rather than a symbol font: an icon of a bar chart standing in for "distribute"
 * would be exactly the jargon this replaces.
 */
function Frame({ children, vertical }: { children: React.ReactNode; vertical?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false" className={vertical ? "" : ""}>
      <rect x="0.5" y="0.5" width="15" height="15" rx="3" fill="none" stroke="currentColor" strokeOpacity=".25" />
      {children}
    </svg>
  );
}

const bar = (x: number, y: number, width: number, height: number) => <rect key={`${x}-${y}`} x={x} y={y} width={width} height={height} rx="1" fill="currentColor" />;

/** Where children sit along the main axis. */
export const JUSTIFY_ICONS: Record<string, React.ReactNode> = {
  "flex-start": <Frame>{[bar(3, 4, 2.5, 8), bar(6.5, 4, 2.5, 8)]}</Frame>,
  center: <Frame>{[bar(4.5, 4, 2.5, 8), bar(8, 4, 2.5, 8)]}</Frame>,
  "flex-end": <Frame>{[bar(6.5, 4, 2.5, 8), bar(10, 4, 2.5, 8)]}</Frame>,
  "space-between": <Frame>{[bar(3, 4, 2.5, 8), bar(10.5, 4, 2.5, 8)]}</Frame>,
  "space-around": <Frame>{[bar(3.5, 4, 2.5, 8), bar(9.5, 4, 2.5, 8)]}</Frame>,
  "space-evenly": <Frame>{[bar(4, 4, 2.5, 8), bar(9, 4, 2.5, 8)]}</Frame>,
};

/** Where children sit across it. */
export const ALIGN_ICONS: Record<string, React.ReactNode> = {
  "flex-start": <Frame>{[bar(3.5, 3, 3, 5), bar(8, 3, 3, 8)]}</Frame>,
  center: <Frame>{[bar(3.5, 5.5, 3, 5), bar(8, 4, 3, 8)]}</Frame>,
  "flex-end": <Frame>{[bar(3.5, 8, 3, 5), bar(8, 5, 3, 8)]}</Frame>,
  stretch: <Frame>{[bar(3.5, 3, 3, 10), bar(8, 3, 3, 10)]}</Frame>,
  baseline: <Frame>{[bar(3.5, 4, 3, 6), bar(8, 6, 3, 4)]}</Frame>,
};

export const DIRECTION_ICONS: Record<string, React.ReactNode> = {
  row: <Frame>{[bar(3, 4.5, 3.5, 7), bar(8, 4.5, 3.5, 7)]}</Frame>,
  column: <Frame>{[bar(4.5, 3, 7, 3.5), bar(4.5, 8, 7, 3.5)]}</Frame>,
  "row-reverse": <Frame>{[bar(3, 4.5, 3.5, 7), bar(8, 4.5, 3.5, 7)]}<path d="M11 2.5 L13 2.5" stroke="currentColor" strokeWidth="1.2" /></Frame>,
  "column-reverse": <Frame>{[bar(4.5, 3, 7, 3.5), bar(4.5, 8, 7, 3.5)]}<path d="M13 11 L13 13" stroke="currentColor" strokeWidth="1.2" /></Frame>,
};

export const DISPLAY_ICONS: Record<string, React.ReactNode> = {
  block: <Frame>{[bar(3, 3.5, 10, 3), bar(3, 8, 10, 3)]}</Frame>,
  flex: DIRECTION_ICONS.row,
  grid: <Frame>{[bar(3, 3, 4.5, 4.5), bar(8.5, 3, 4.5, 4.5), bar(3, 8.5, 4.5, 4.5), bar(8.5, 8.5, 4.5, 4.5)]}</Frame>,
  "inline-block": <Frame>{[bar(3, 5.5, 4.5, 5), bar(8.5, 5.5, 4.5, 5)]}</Frame>,
  none: (
    <Frame>
      <path d="M4 12 L12 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </Frame>
  ),
};

/**
 * A segmented control of pictures, with the words kept for the tooltip and for
 * anybody using a screen reader. Falls back to a select when there are more
 * choices than fit — five is the most that reads at this width.
 */
export function IconChoice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; title: string; icon: React.ReactNode }>;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex ${CONTROL_HEIGHT} flex-1 items-center gap-0.5 rounded-lg bg-sunken p-0.5`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.title}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`flex h-6 flex-1 items-center justify-center rounded-[5px] transition ${
            value === option.value ? "bg-white text-ink shadow-sm shadow-ink/10" : "text-muted hover:text-ink"
          }`}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
