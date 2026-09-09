import { useEffect, useState } from "react";
import { parseStyle, writeStyle } from "./StylePanel";

export const INSPECTED_PROPERTIES = ["display", "position", "flex-direction", "flex-wrap", "align-items", "justify-content", "align-self", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "order", "flex-grow", "flex-shrink", "width", "height", "min-width", "max-width", "min-height", "max-height", "top", "right", "bottom", "left", "z-index", "object-fit", "object-position", "background-image", "box-sizing", "font-family", "font-size", "color", "background-color", ...["padding", "margin"].flatMap(p => ["top", "right", "bottom", "left"].map(s => `${p}-${s}`))];

/** Values inherited from the site's CSS are hints, never copied into a draft. */
function Property({ name, label, value, inherited, options, disabled, onChange }: {
  name: string; label: string; value: string; inherited?: string; options?: string[];
  disabled: boolean; onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState(false);
  useEffect(() => { setText(value); setError(false); }, [value]);
  const commit = () => {
    if (!text.trim() || (CSS.supports(name, text.trim()) && text.trim().length <= 120 && !/url\s*\(|expression\s*\(|[<>"'`\\]/i.test(text))) { setError(false); if (text.trim() !== value) onChange(text.trim()); }
    else setError(true);
  };
  return <label className="block min-w-0 text-[11px] text-muted">
    <span className="mb-1 flex items-center justify-between gap-1">{label}{value && <span className="text-blue" title="Overrides the website's style">●</span>}</span>
    {options ? <select aria-label={label} disabled={disabled} value={value} onChange={e => onChange(e.target.value)} className="h-8 w-full rounded-xl border border-line bg-white px-2 text-xs text-ink">
      <option value="">As designed{inherited ? ` · ${inherited}` : ""}</option>
      {value && !options.includes(value) && <option value={value}>{value}</option>}
      {options.map(option => <option key={option}>{option}</option>)}
    </select> : <input aria-label={label} title={`Inherited: ${inherited || "not set"}. Use px, %, rem, auto, or a CSS expression.`} disabled={disabled} value={text} placeholder={inherited || "As designed"} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") { commit(); e.currentTarget.blur(); } if (e.key === "Escape") { setText(value); setError(false); } }} className={`h-8 w-full rounded-xl border bg-white px-2 font-mono text-[11px] text-ink ${error ? "border-danger-solid" : "border-line"}`} />}
    {error && <span role="alert" className="mt-1 block text-danger-text">Enter a valid {label.toLowerCase()}.</span>}
  </label>;
}

export function LayoutInspector({ style, computed, readOnly, onChange }: {
  style: string; computed: Record<string, string>; readOnly: boolean; onChange: (next: string) => void;
}) {
  const values = parseStyle(style);
  const set = (key: string, value: string) => {
    const next = { ...values };
    delete next[key];
    if (value) next[key] = value;
    onChange(writeStyle(next));
  };
  const property = (name: string, label: string, options?: string[]) => <Property key={name} name={name} label={label} options={options} value={values[name] ?? ""} inherited={computed[name]} disabled={readOnly} onChange={value => set(name, value)} />;
  const group = (title: string, children: React.ReactNode, open = false) => <details open={open || undefined} className="border-b border-line px-4 py-3">
    <summary className="cursor-pointer select-none text-xs font-semibold text-ink">{title}</summary>
    <div className="mt-3 grid grid-cols-2 gap-2.5">{children}</div>
  </details>;
  const display = values.display || computed.display || "block";
  return <div>
    {group("Layout", <>
      {property("display", "Display", ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none"])}
      {property("box-sizing", "Sizing model", ["border-box", "content-box"])}
      {display.includes("flex") && <>
        {property("flex-direction", "Direction", ["row", "column", "row-reverse", "column-reverse"])}
        {property("flex-wrap", "Wrap", ["nowrap", "wrap", "wrap-reverse"])}
      </>}
      {(display.includes("flex") || display.includes("grid")) && <>
        {property("justify-content", "Distribute", ["start", "center", "end", "space-between", "space-around", "space-evenly"])}
        {property("align-items", "Align items", ["stretch", "start", "center", "end", "baseline"])}
        {property("row-gap", "Row gap")}{property("column-gap", "Column gap")}
      </>}
      {display.includes("grid") && <>{property("grid-template-columns", "Columns")}{property("grid-template-rows", "Rows")}</>}
    </>, true)}
    {group("Size & constraints", <>{["width", "height", "min-width", "max-width", "min-height", "max-height"].map(name => property(name, name.replaceAll("-", " ")))}</>, true)}
    {group("Spacing", <>{["margin", "padding"].map(name => <div key={name} className="col-span-2"><p className="mb-2 text-[11px] capitalize text-muted">{name}</p><div className="grid grid-cols-2 gap-2">{["top", "right", "bottom", "left"].map(side => property(`${name}-${side}`, `${name} ${side}`))}</div></div>)}</>)}
    {group("Position", <>
      {property("position", "Position", ["static", "relative", "absolute", "fixed", "sticky"])}{property("z-index", "Stack order")}
      {["top", "right", "bottom", "left"].map(name => property(name, name))}
    </>)}
    {group("Within parent", <>
      {property("align-self", "Align self", ["auto", "start", "center", "end", "stretch", "baseline"])}
      {property("order", "Order")}{property("flex-grow", "Grow")}{property("flex-shrink", "Shrink")}
      {property("grid-column", "Grid column")}{property("grid-row", "Grid row")}
    </>)}
    {group("Image & background", <>
      {property("object-fit", "Image fit", ["cover", "contain", "fill", "none", "scale-down"])}
      {property("object-position", "Focal point")}
      <div className="col-span-2">{property("background-image", "Gradient (CSS)")}</div>
      <p className="col-span-2 text-[10px] text-muted">Use a linear-gradient or radial-gradient. Replace photos through the image content control.</p>
    </>)}
  </div>;
}
