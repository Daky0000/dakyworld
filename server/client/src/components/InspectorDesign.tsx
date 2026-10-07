import type { ReactNode } from "react";

/**
 * The small pieces the redesigned inspector is built from: a collapsible
 * section with its current value in the header, a grid of picture tiles for a
 * choice between named options, a labelled slider and a segmented switch.
 * Styled by the `dx-*` rules in index.css so the light and dark editor share
 * one look.
 */

export function Acc({ title, summary, open, children }: { title: string; summary?: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="dx-acc" open={open}>
      <summary>
        {title}
        {summary && <small>{summary}</small>}
      </summary>
      <div className="dx-accb">{children}</div>
    </details>
  );
}

export type TileOption = { value: string; label: string; icon?: ReactNode; demo?: string };

export function Tiles({ label, options, value, disabled, onChange }: { label: string; options: TileOption[]; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <div className="dx-tiles" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          className="dx-tile"
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.demo !== undefined ? <span className="dx-demo" style={{ boxShadow: option.demo }} /> : <span className="dx-ico">{option.icon}</span>}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, unit, disabled, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <div className="dx-sl">
      <div className="dx-fl">
        <label>{label}</label>
        <span>{value}{unit}</span>
      </div>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}

export function Seg<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="dx-segc" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dx-f">
      <div className="dx-fl"><label>{label}</label></div>
      {children}
    </div>
  );
}

export function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="dx-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

/** The shadows offered as tiles, normal and hover alike. */
export const SHADOW_PRESETS: { value: string; label: string; css: string }[] = [
  { value: "none", label: "None", css: "none" },
  { value: "soft", label: "Soft", css: "0 2px 8px rgba(0,0,0,.12)" },
  { value: "medium", label: "Medium", css: "0 8px 20px rgba(0,0,0,.18)" },
  { value: "strong", label: "Strong", css: "0 18px 40px rgba(0,0,0,.28)" },
  { value: "glow", label: "Glow", css: "0 0 0 4px rgba(77,123,255,.35)" },
  { value: "inner", label: "Inner", css: "inset 0 2px 6px rgba(0,0,0,.25)" },
];

/** Line icons the tiles use, drawn the same way as the editor's own. */
const path = (d: string) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const TILE_ICON = {
  none: path("M6 6l12 12M18 6L6 18"),
  eye: path("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z"),
  up: path("M12 19V5M6 11l6-6 6 6"),
  down: path("M12 5v14M6 13l6 6 6-6"),
  left: path("M15 18l-6-6 6-6"),
  right: path("M9 6l6 6-6 6"),
  plus: path("M12 5v14M5 12h14"),
  minus: path("M5 12h14"),
  drop: path("M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"),
  swap: path("M7 7h13l-3-3M17 17H4l3 3"),
  spark: path("M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"),
  reload: path("M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"),
  cursor: path("M5 3l14 7-6 2-2 6z"),
  bolt: path("M13 3L4 14h7l-1 7 9-11h-7z"),
  layers: path("M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"),
  pin: path("M12 21s-7-6-7-11a7 7 0 0114 0c0 5-7 11-7 11z"),
  play: path("M7 5l12 7-12 7z"),
};
