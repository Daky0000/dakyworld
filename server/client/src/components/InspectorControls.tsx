import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
          aria-label={title}
          disabled={!onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-2.5 text-left text-[11px] font-semibold tracking-[.01em] text-ink transition hover:text-blue disabled:cursor-default disabled:hover:text-ink"
        >
          <span className="truncate">{title}</span>{onToggle && <span className="ml-auto text-[11px] font-normal text-muted">{open ? "Hide" : "Show"}</span>}
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
      {label !== undefined && <span title={label} className="w-[62px] shrink-0 truncate text-[11px] uppercase tracking-[.04em] text-muted">{label}</span>}
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
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center justify-between gap-1">
        {!bare ? (
          <span
            className="cursor-ew-resize select-none text-[11px] font-medium text-ink-2"
            title={`${label} — drag to change`}
            onPointerDown={scrub}
          >
            {label}
          </span>
        ) : (
          <span />
        )}
        {unit && (
          <span
            className="cursor-ew-resize select-none rounded-md bg-blue/15 px-1.5 py-0.5 font-sans text-[10px] font-bold uppercase tracking-wider text-blue"
            title={`${label} (${unit})`}
            onPointerDown={scrub}
          >
            {unit}
          </span>
        )}
      </div>
      <div className={FIELD}>
        <input
          aria-label={label}
          type="number"
          step="any"
          className={`${NUM} w-full text-center`}
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
      </div>
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

const DEFAULT_SAVED_COLORS = [
  "#5E6472",
  "#3B6EF6",
  "#1CB955",
  "#E85D2A",
  "#E03E52",
  "#F2C911",
  "#0FA37F",
  "#6DD3EA",
  "#6C4CE0",
];

function hexToRgbTuple(hex: string): [number, number, number] {
  const cleaned = hex.replace(/^#/, "").trim();
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return [
      parseInt(cleaned[0] + cleaned[0], 16),
      parseInt(cleaned[1] + cleaned[1], 16),
      parseInt(cleaned[2] + cleaned[2], 16),
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return [
      parseInt(cleaned.slice(0, 2), 16),
      parseInt(cleaned.slice(2, 4), 16),
      parseInt(cleaned.slice(4, 6), 16),
    ];
  }
  return [18, 17, 15];
}

function rgbTupleToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    "#" +
    [clamp(r), clamp(g), clamp(b)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  if (max !== min) {
    switch (max) {
      case rn:
        h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
        break;
      case gn:
        h = ((bn - rn) / d + 2) * 60;
        break;
      case bn:
        h = ((rn - gn) / d + 4) * 60;
        break;
    }
  }
  return { h: Math.round(h), s: Math.round(s), v: Math.round(v) };
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const vn = Math.max(0, Math.min(100, v)) / 100;
  const c = vn * sn;
  const hh = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vn - c;
  let r1 = 0,
    g1 = 0,
    b1 = 0;
  if (hh < 60) [r1, g1, b1] = [c, x, 0];
  else if (hh < 120) [r1, g1, b1] = [x, c, 0];
  else if (hh < 180) [r1, g1, b1] = [0, c, x];
  else if (hh < 240) [r1, g1, b1] = [0, x, c];
  else if (hh < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function ModernColorPickerPopover({
  anchorRef,
  colour,
  palette,
  allowNone,
  onChangeColour,
  onClear,
  onCommit,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  colour: Colour;
  palette: { label: string; value: string }[];
  allowNone?: boolean;
  onChangeColour: (next: Partial<Colour>) => void;
  onClear?: () => void;
  onCommit?: () => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const svCanvasRef = useRef<HTMLDivElement>(null);
  const hueTrackRef = useRef<HTMLDivElement>(null);
  const alphaTrackRef = useRef<HTMLDivElement>(null);

  const [rgb, setRgb] = useState<[number, number, number]>(() => hexToRgbTuple(colour.hex));
  const [hsv, setHsv] = useState<{ h: number; s: number; v: number }>(() => {
    const [r, g, b] = hexToRgbTuple(colour.hex);
    return rgbToHsv(r, g, b);
  });
  const [colorMode, setColorMode] = useState<"RGB" | "HEX">("RGB");
  const [savedColors, setSavedColors] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("dw-saved-colors");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch {}
    const fromPalette = palette.map((p) => p.value.toUpperCase()).filter((v) => /^#[0-9A-F]{6}$/.test(v));
    return Array.from(new Set([...DEFAULT_SAVED_COLORS, ...fromPalette])).slice(0, 14);
  });

  useEffect(() => {
    const [r, g, b] = hexToRgbTuple(colour.hex);
    setRgb([r, g, b]);
    const nextHsv = rgbToHsv(r, g, b);
    setHsv((prev) => ({
      h: nextHsv.s === 0 ? prev.h : nextHsv.h,
      s: nextHsv.s,
      v: nextHsv.v,
    }));
  }, [colour.hex]);

  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 120, left: 120 });
  useEffect(() => {
    const updatePosition = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = 268;
      const height = 385;
      let left = rect.right - width;
      if (left < 12) left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.left));
      let top = rect.bottom + 8;
      if (top + height > window.innerHeight - 12) {
        top = Math.max(12, rect.top - height - 8);
      }
      setCoords({ top, left });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  const applyHsv = (nextH: number, nextS: number, nextV: number) => {
    const clampedH = Math.max(0, Math.min(360, Math.round(nextH)));
    const clampedS = Math.max(0, Math.min(100, Math.round(nextS)));
    const clampedV = Math.max(0, Math.min(100, Math.round(nextV)));
    setHsv({ h: clampedH, s: clampedS, v: clampedV });
    const [r, g, b] = hsvToRgb(clampedH, clampedS, clampedV);
    setRgb([r, g, b]);
    const nextHex = rgbTupleToHex(r, g, b);
    onChangeColour({ hex: nextHex });
  };

  const startSvDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const canvas = svCanvasRef.current;
    if (!canvas) return;
    const updateFromPointer = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const s = ((clientX - rect.left) / rect.width) * 100;
      const v = 100 - ((clientY - rect.top) / rect.height) * 100;
      applyHsv(hsv.h, s, v);
    };
    updateFromPointer(event.clientX, event.clientY);
    const onMove = (moveEvt: PointerEvent) => updateFromPointer(moveEvt.clientX, moveEvt.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onCommit?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startHueDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const track = hueTrackRef.current;
    if (!track) return;
    const updateFromPointer = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      const h = ((clientX - rect.left) / rect.width) * 360;
      applyHsv(h, hsv.s, hsv.v);
    };
    updateFromPointer(event.clientX);
    const onMove = (moveEvt: PointerEvent) => updateFromPointer(moveEvt.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onCommit?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startAlphaDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const track = alphaTrackRef.current;
    if (!track) return;
    const updateFromPointer = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      const alpha = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onChangeColour({ alpha: Number(alpha.toFixed(2)) });
    };
    updateFromPointer(event.clientX);
    const onMove = (moveEvt: PointerEvent) => updateFromPointer(moveEvt.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onCommit?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const pickWithEyeDropper = async () => {
    const EyeDropperCtor = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!EyeDropperCtor) return;
    try {
      const dropper = new EyeDropperCtor();
      const res = await dropper.open();
      if (res?.sRGBHex) {
        onChangeColour({ hex: res.sRGBHex.toUpperCase() });
        onCommit?.();
      }
    } catch {}
  };

  const addSavedColor = () => {
    const current = colour.hex.toUpperCase();
    const next = Array.from(new Set([current, ...savedColors])).slice(0, 16);
    setSavedColors(next);
    try {
      localStorage.setItem("dw-saved-colors", JSON.stringify(next));
    } catch {}
  };

  const card = (
    <div
      ref={popoverRef}
      style={{ top: `${coords.top}px`, left: `${coords.left}px` }}
      className="fixed z-[9999] w-[268px] select-none rounded-[18px] border border-[#2C2E36] bg-[#18191D] p-4 text-white shadow-[0_24px_60px_rgba(0,0,0,0.65)]"
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] font-medium tracking-tight text-white/95">Color Picker</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close color picker"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M2 2l8 8M10 2L2 10" />
          </svg>
        </button>
      </div>

      {/* 2D Saturation / Brightness Canvas */}
      <div
        ref={svCanvasRef}
        onPointerDown={startSvDrag}
        style={{
          backgroundColor: `hsl(${hsv.h}, 100%, 50%)`,
          backgroundImage:
            "linear-gradient(to top, #000000, transparent), linear-gradient(to right, #ffffff, transparent)",
        }}
        className="relative h-[154px] w-full cursor-crosshair overflow-hidden rounded-[12px] border border-white/10"
      >
        <span
          style={{
            left: `${hsv.s}%`,
            top: `${100 - hsv.v}%`,
            backgroundColor: colour.hex,
          }}
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-white shadow-[0_2px_6px_rgba(0,0,0,0.7)]"
        />
      </div>

      {/* Eyedropper + Hue & Alpha Sliders */}
      <div className="mt-3.5 flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => void pickWithEyeDropper()}
          title="Pick color from screen (Eyedropper)"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/75 transition hover:bg-white/10 hover:text-white"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="m2 22 1-1h3l9-9" />
            <path d="M3 21v-3l9-9" />
            <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
          </svg>
        </button>

        <div className="flex flex-1 flex-col gap-2.5">
          {/* Hue Slider */}
          <div
            ref={hueTrackRef}
            onPointerDown={startHueDrag}
            style={{
              background:
                "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)",
            }}
            className="relative h-2.5 w-full cursor-pointer rounded-full"
          >
            <span
              style={{
                left: `${(hsv.h / 360) * 100}%`,
                backgroundColor: `hsl(${hsv.h}, 100%, 50%)`,
              }}
              className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-white shadow-[0_1px_4px_rgba(0,0,0,0.65)]"
            />
          </div>

          {/* Alpha Slider */}
          <div
            ref={alphaTrackRef}
            onPointerDown={startAlphaDrag}
            style={{ background: CHECKER }}
            className="relative h-2.5 w-full cursor-pointer overflow-visible rounded-full"
          >
            <div
              style={{
                background: `linear-gradient(to right, transparent, ${colour.hex})`,
              }}
              className="h-full w-full rounded-full"
            />
            <span
              style={{
                left: `${Math.round(colour.alpha * 100)}%`,
                backgroundColor: colour.hex,
              }}
              className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-white shadow-[0_1px_4px_rgba(0,0,0,0.65)]"
            />
          </div>
        </div>
      </div>

      {/* Mode Selector (RGB / HEX) + Segmented Inputs */}
      <div className="mt-3.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setColorMode((m) => (m === "RGB" ? "HEX" : "RGB"))}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[#323540] bg-[#22242C] px-2.5 text-[11px] font-semibold text-white transition hover:border-white/30"
        >
          <span>{colorMode}</span>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {colorMode === "RGB" ? (
          <div className="grid h-8 flex-1 grid-cols-4 overflow-hidden rounded-lg border border-[#323540] bg-[#131418] font-mono text-[11px] text-white">
            {([0, 1, 2] as const).map((idx) => (
              <input
                key={idx}
                type="number"
                min={0}
                max={255}
                aria-label={idx === 0 ? "Red" : idx === 1 ? "Green" : "Blue"}
                value={rgb[idx]}
                onChange={(e) => {
                  const val = Math.max(0, Math.min(255, Number(e.target.value) || 0));
                  const nextRgb: [number, number, number] = [...rgb] as [number, number, number];
                  nextRgb[idx] = val;
                  setRgb(nextRgb);
                  const nextHex = rgbTupleToHex(nextRgb[0], nextRgb[1], nextRgb[2]);
                  setHsv(rgbToHsv(nextRgb[0], nextRgb[1], nextRgb[2]));
                  onChangeColour({ hex: nextHex });
                }}
                onBlur={() => onCommit?.()}
                className="w-full border-r border-[#2C2E36] bg-transparent text-center text-[11px] text-white outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            ))}
            <div className="flex items-center justify-center px-1 text-[10px] text-white/90">
              <span>{Math.round(colour.alpha * 100)}</span>
              <span className="ml-0.5 text-white/50">%</span>
            </div>
          </div>
        ) : (
          <div className="flex h-8 flex-1 items-center overflow-hidden rounded-lg border border-[#323540] bg-[#131418] font-mono text-[11px] text-white">
            <input
              type="text"
              value={colour.hex.toUpperCase()}
              onChange={(e) => {
                const raw = e.target.value.trim().replace(/^#/, "");
                if (/^[0-9a-fA-F]{6}$/.test(raw)) {
                  onChangeColour({ hex: `#${raw.toUpperCase()}` });
                }
              }}
              onBlur={() => onCommit?.()}
              className="min-w-0 flex-1 border-r border-[#2C2E36] bg-transparent px-2 text-center uppercase text-white outline-none"
            />
            <div className="flex w-12 items-center justify-center px-1 text-[10px] text-white/90">
              <span>{Math.round(colour.alpha * 100)}</span>
              <span className="ml-0.5 text-white/50">%</span>
            </div>
          </div>
        )}
      </div>

      {/* Saved Colors */}
      <div className="mt-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-white/80">Saved Colors</span>
          <button
            type="button"
            onClick={addSavedColor}
            title="Save current color"
            className="flex h-5 w-5 items-center justify-center rounded text-sm text-white/75 transition hover:bg-white/10 hover:text-white"
          >
            +
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {savedColors.slice(0, 9).map((swatch) => {
            const active = colour.hex.toUpperCase() === swatch.toUpperCase();
            return (
              <button
                key={swatch}
                type="button"
                title={swatch}
                onClick={() => {
                  onChangeColour({ hex: swatch.toUpperCase() });
                  onCommit?.();
                }}
                style={{ backgroundColor: swatch }}
                className={`h-5 w-5 rounded-full transition ${
                  active
                    ? "ring-2 ring-[#4C82FB] ring-offset-2 ring-offset-[#18191D]"
                    : "border border-white/15 hover:scale-110"
                }`}
              />
            );
          })}
        </div>
      </div>

      {allowNone && onClear && (
        <button
          type="button"
          onClick={() => {
            onClear();
            onCommit?.();
            onClose();
          }}
          className="mt-3 w-full rounded-lg border border-[#323540] bg-[#22242C] py-1.5 text-[11px] font-medium text-white/75 transition hover:border-white/30 hover:text-white"
        >
          Reset to default
        </button>
      )}
    </div>
  );

  return typeof document !== "undefined" ? createPortal(card, document.body) : card;
}

/**
 * One popover for every colour on the panel.
 *
 * Clicking the swatch opens the modern Minima-UI Color Picker popover right
 * beside the inline editable `#HEXCODE` input.
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

  const set = (next: Partial<Colour>) => onChange(writeColour({ ...colour, ...next }));

  const [hexDraft, setHexDraft] = useState(value ? colour.hex : "");
  useEffect(() => {
    setHexDraft(value ? colour.hex.toUpperCase() : "");
  }, [value, colour.hex]);

  return (
    <div className="relative" ref={box}>
      <div className={FIELD}>
        {!bare && <span className={LABEL}>{label}</span>}
        <div className={`flex items-center gap-1.5 ${bare ? "w-full" : "ml-auto"}`}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen((was) => !was)}
            className="relative flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border border-line-strong shadow-2xs transition hover:border-blue"
            style={{ background: CHECKER }}
            title={`${label} color picker (${value ? colour.hex : "auto"})`}
          >
            <span className="block h-full w-full rounded-[3px]" style={{ backgroundColor: value || "transparent" }} />
          </button>
          <input
            type="color"
            aria-label={label}
            disabled={disabled}
            value={colour.hex}
            onChange={(event) => {
              const nextHex = event.target.value.toUpperCase();
              setHexDraft(nextHex);
              set({ hex: nextHex });
            }}
            onBlur={() => onCommit?.()}
            className="sr-only"
          />
          <input
            type="text"
            disabled={disabled}
            placeholder="auto"
            value={hexDraft}
            onChange={(event) => {
              const raw = event.target.value;
              setHexDraft(raw);
              const cleaned = raw.trim().replace(/^#/, "");
              if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
                set({ hex: `#${cleaned.toUpperCase()}` });
              } else if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
                const expanded = cleaned.split("").map((ch) => ch + ch).join("").toUpperCase();
                set({ hex: `#${expanded}` });
              } else if (raw.trim() === "" && allowNone) {
                onChange("");
              }
            }}
            onBlur={() => {
              setHexDraft(value ? colour.hex.toUpperCase() : "");
              onCommit?.();
            }}
            className="w-[62px] bg-transparent font-mono text-[11px] font-semibold uppercase text-ink outline-none placeholder:text-muted focus:text-blue"
            title="Click to type a #HEX color code"
          />
          <button
            type="button"
            aria-label={`${label} palette and opacity`}
            aria-expanded={open}
            disabled={disabled}
            onClick={() => setOpen((was) => !was)}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] text-muted transition hover:bg-surface-2 hover:text-ink"
            title="Open modern color picker"
          >
            ▾
          </button>
        </div>
      </div>

      {open && !disabled && (
        <ModernColorPickerPopover
          anchorRef={box}
          colour={colour}
          palette={palette}
          allowNone={allowNone}
          onChangeColour={(patch) => set(patch)}
          onClear={allowNone ? () => onChange("") : undefined}
          onCommit={onCommit}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Compact side-by-side `[Color Picker] #HEXCODE` control used everywhere a color code
 * is displayed or edited across the website builder. Clicking the swatch opens the
 * modernized Minima-UI Color Picker popover.
 */
export function ColorCodeInput({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder = "#12110F",
  label,
  ariaLabel,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit?: () => void;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const effectiveLabel = ariaLabel ?? label;
  const parsed = useMemo(() => readColour(value || placeholder), [value, placeholder]);
  const palette = useContext(PaletteContext) ?? COLOURS;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(value || "");
  useEffect(() => {
    setDraft(value ? (value.startsWith("#") ? value.toUpperCase() : value) : "");
  }, [value]);

  return (
    <div
      ref={anchorRef}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 focus-within:border-blue ${className}`}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
        className="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-line-strong shadow-2xs transition hover:border-blue"
        style={{ background: CHECKER }}
        title={effectiveLabel ? `${effectiveLabel} (${parsed.hex})` : `Pick color (${parsed.hex})`}
      >
        <span className="block h-full w-full rounded-[3px]" style={{ backgroundColor: value || parsed.hex }} />
      </button>
      <input
        type="color"
        aria-label={effectiveLabel ? `${effectiveLabel} picker` : "Color picker"}
        disabled={disabled}
        value={parsed.hex}
        onChange={(event) => {
          const nextHex = event.target.value.toUpperCase();
          setDraft(nextHex);
          onChange(nextHex);
        }}
        onBlur={() => onCommit?.()}
        className="sr-only"
      />
      <input
        type="text"
        disabled={disabled}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const cleaned = raw.trim().replace(/^#/, "");
          if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
            onChange(`#${cleaned.toUpperCase()}`);
          } else if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
            const expanded = cleaned.split("").map((ch) => ch + ch).join("").toUpperCase();
            onChange(`#${expanded}`);
          } else if (raw.trim().startsWith("rgb") || raw.trim().startsWith("var(") || raw.trim() === "") {
            onChange(raw.trim());
          }
        }}
        onBlur={() => onCommit?.()}
        className="w-[74px] bg-transparent font-mono text-[11px] font-semibold uppercase text-ink outline-none placeholder:text-muted"
      />
      {open && !disabled && (
        <ModernColorPickerPopover
          anchorRef={anchorRef}
          colour={parsed}
          palette={palette}
          onChangeColour={(patch) => {
            const nextColour = { ...parsed, ...patch };
            const formatted = nextColour.alpha < 1 ? writeColour(nextColour) : nextColour.hex.toUpperCase();
            setDraft(formatted);
            onChange(formatted);
          }}
          onCommit={onCommit}
          onClose={() => setOpen(false)}
        />
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
      className={`flex ${CONTROL_HEIGHT} w-7 shrink-0 items-center justify-center rounded-[10px] text-[12px] transition ${
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
    <div className={`flex ${CONTROL_HEIGHT} flex-1 overflow-hidden rounded-[10px] bg-sunken p-0.5`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value === value ? "" : option.value)}
          className={`flex flex-1 items-center justify-center rounded-[10px] text-[11px] transition ${
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
    <div className="rounded-[10px] bg-sunken p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-muted">{title}</span>
        <button type="button" onClick={onRemove} className="text-[11px] text-muted transition hover:text-danger-text">
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

/** Compatibility exports for callers that supply layout choices. Controls render their titles. */
export const JUSTIFY_ICONS: Record<string, React.ReactNode> = Object.fromEntries(["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"].map(value => [value, value]));
export const ALIGN_ICONS: Record<string, React.ReactNode> = Object.fromEntries(["flex-start", "center", "flex-end", "stretch", "baseline"].map(value => [value, value]));
export const DIRECTION_ICONS: Record<string, React.ReactNode> = Object.fromEntries(["row", "column", "row-reverse", "column-reverse"].map(value => [value, value]));
export const DISPLAY_ICONS: Record<string, React.ReactNode> = Object.fromEntries(["block", "flex", "grid", "inline-block", "none"].map(value => [value, value]));

/** A wrapping text control with explicit labels for every layout option. */
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
    <div role="radiogroup" aria-label={label} className="flex flex-wrap flex-1 items-center gap-1 rounded-xl bg-sunken p-1">
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
          className={`flex min-h-8 flex-1 items-center justify-center rounded-[10px] px-2 text-[11px] transition ${
            value === option.value ? "bg-white text-ink shadow-sm shadow-ink/10" : "text-muted hover:text-ink"
          }`}
        >
          {option.title.replaceAll("flex-", "").replaceAll("space-", "")}
        </button>
      ))}
    </div>
  );
}
