import { useEffect, useState } from "react";

/**
 * Preserve %, rem, clamp(), and unitless leading when editing an existing site.
 *
 * `name` is what the field is called on screen; `label` is what it is called to
 * a screen reader, and they differ where a group heading already says half of
 * it — four boxes reading "top, right, bottom, left" under "Padding" rather
 * than "padding top" four times, while each still announces itself in full.
 */
export function CssValueField({ property, label, name, value, disabled, onChange }: {
  property: string; label: string; name?: string; value: string; disabled?: boolean; onChange: (value: string) => void;
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
  return <label className="min-w-0 flex-1 text-[11px] text-muted"><span className="mb-1 block">{name ?? label}</span><input aria-label={label} aria-invalid={error} className={`h-8 w-full rounded-xl border bg-white px-2 font-mono text-xs text-ink ${error ? "border-danger-solid" : "border-line"}`} value={text} disabled={disabled} placeholder="As designed" onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setText(value); setError(false); } }} />{error && <span role="alert" className="mt-1 block text-danger-text">Use a valid CSS value (px, %, rem or auto).</span>}</label>;
}
