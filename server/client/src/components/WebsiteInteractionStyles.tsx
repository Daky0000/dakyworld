import { useEffect, useState } from "react";
import { INTERACTION_PROPERTIES, interactionCss, type InteractionState } from "../../../src/shared/websiteInteraction";
import { parseStyle, writeStyle } from "./InspectorControls";

export function WebsiteInteractionStyles({ element, style, readOnly, onChange }: { element: HTMLElement | null; style: string; readOnly: boolean; onChange: (style: string) => void }) {
  const [state, setState] = useState<InteractionState>("hover");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const declarations = parseStyle(style);
  useEffect(() => {
    if (!element) return;
    const document = element.ownerDocument;
    let sheet = document.querySelector<HTMLStyleElement>("style[data-dw-interaction-preview]");
    if (!sheet) { sheet = document.createElement("style"); sheet.setAttribute("data-dw-interaction-preview", ""); sheet.textContent = interactionCss(true); (document.head || document.body).appendChild(sheet); }
    if (preview) element.setAttribute("data-dw-state-preview", state);
    else element.removeAttribute("data-dw-state-preview");
    return () => element.removeAttribute("data-dw-state-preview");
  }, [element, state, preview]);
  const set = (property: string, value: string) => {
    if (value && (!CSS.supports(property, value) || value.length > 120 || /[;{}<>@\\]|url\s*\(|var\s*\(/i.test(value))) { setError(`Enter a valid ${property.replaceAll("-", " ")} value.`); return; }
    const next = { ...declarations };
    const key = `--dw-${state}-${property}`;
    if (value) next[key] = value; else delete next[key];
    setError(""); onChange(writeStyle(next));
  };
  return <details open className="border-b border-line px-3 py-3"><summary className="cursor-pointer text-sm font-semibold">Hover, focus & active</summary><p className="my-2 text-xs text-muted">Interaction styles apply at every screen size. Focus styles appear during keyboard navigation.</p>
    <div className="mb-3 flex gap-2">{(["hover", "focus", "active"] as const).map(option => <button key={option} type="button" aria-pressed={state === option} onClick={() => setState(option)} className={`rounded-[10px] border border-line px-3 py-1.5 text-xs ${state === option ? "bg-ink text-white" : "bg-white"}`}>{option === "hover" ? "Hover" : option === "focus" ? "Keyboard focus" : "Active"}</button>)}</div>
    <label className="mb-3 flex items-center gap-2 text-xs"><input type="checkbox" checked={preview} onChange={event => setPreview(event.target.checked)} />Preview this state</label>
    <fieldset disabled={readOnly} className="space-y-2">{INTERACTION_PROPERTIES.map(property => <label className="block text-xs capitalize" key={`${state}:${property}`}>{property.replaceAll("-", " ")}<input key={`${state}:${property}:${declarations[`--dw-${state}-${property}`] ?? ""}`} aria-label={`${state} ${property}`} defaultValue={declarations[`--dw-${state}-${property}`] ?? ""} placeholder={property.includes("color") ? "#3157FF" : property === "opacity" ? "0.8" : property === "transform" ? "translateY(-2px)" : property === "text-decoration" ? "underline" : "0 4px 12px #00000033"} className="mt-1 w-full rounded-[10px] border border-line bg-white p-2 text-xs" onBlur={event => { if (event.target.value !== (declarations[`--dw-${state}-${property}`] ?? "")) set(property, event.target.value); }} /></label>)}
    <label className="block text-xs">Transition<select aria-label="Interaction transition" value={declarations.transition ?? ""} className="mt-1 w-full rounded-[10px] border border-line p-2 text-xs" onChange={event => { const next = { ...declarations }; if (event.target.value) next.transition = event.target.value; else delete next.transition; onChange(writeStyle(next)); }}><option value="">Website default</option><option value="none">None</option>{[150, 250, 400].map(ms => <option key={ms} value={`color ${ms}ms, background-color ${ms}ms, border-color ${ms}ms, opacity ${ms}ms, transform ${ms}ms`}>{ms} ms</option>)}</select></label>
    <button type="button" className="text-xs text-blue" onClick={() => { const next = { ...declarations }; for (const property of INTERACTION_PROPERTIES) delete next[`--dw-${state}-${property}`]; onChange(writeStyle(next)); }}>Reset {state} overrides</button></fieldset>
    {error && <p role="alert" className="mt-2 text-xs text-danger-text">{error}</p>}
  </details>;
}
