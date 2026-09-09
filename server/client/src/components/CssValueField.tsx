import { useEffect, useState } from "react";

/**
 * Preserve %, rem, clamp(), and unitless leading when editing an existing site.
 *
 * `name` is what the field is called on screen; `label` is what it is called to
 * a screen reader, and they differ where a group heading already says half of
 * it — four boxes reading "top, right, bottom, left" under "Padding" rather
 * than "padding top" four times, while each still announces itself in full.
 */
export function CssValueField({ property, label, name, prefix, value, disabled, bare, onChange }: {
  property: string; label: string; name?: string;
  /** A letter inside the well — W, H — where two fields share one row label. */
  prefix?: string;
  value: string; disabled?: boolean; bare?: boolean; onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState(false);
  useEffect(() => { setText(value); setError(false); }, [value]);
  const commit = () => {
    const next = text.trim();
    if (next && (!CSS.supports(property, next) || next.length > 120 || /url\s*\(|expression\s*\(|[<>"'`\\]/i.test(next))) { setError(true); return; }
    setError(false);
    if (next !== value) onChange(next);
  };
  const box = `h-7 w-full rounded-lg border bg-sunken ${prefix ? "pl-[18px] pr-1.5" : "px-2"} font-mono text-[11px] text-ink outline-none transition placeholder:text-faint focus:border-blue focus:bg-white focus:ring-2 focus:ring-blue/15 hover:border-line-strong ${error ? "border-danger-solid" : "border-transparent"}`;
  const field = <input aria-label={label} aria-invalid={error} className={box} value={text} disabled={disabled} placeholder={prefix ? "auto" : "As designed"} onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setText(value); setError(false); } }} />;
  const problem = error ? <span role="alert" className="mt-1 block text-[10px] text-danger-text">Use a valid CSS value (px, %, rem or auto).</span> : null;
  // Bare: the row it sits in already says what the property is called.
  if (bare) return <span className="relative block min-w-0 flex-1">{prefix && <span aria-hidden className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 font-mono text-[9px] uppercase text-faint">{prefix}</span>}{field}{problem}</span>;
  return <label className="min-w-0 flex-1 text-[11px] text-muted"><span className="mb-1 block">{name ?? label}</span>{field}{problem}</label>;
}
