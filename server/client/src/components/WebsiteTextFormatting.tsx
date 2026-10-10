import { useEffect, useRef, useState } from "react";
import { applyTextFormat, clearTextFormatter, DEFAULT_HIGHLIGHT, editableInnerHtml, rememberTextFormatter, textFormatState, type TextFormatAction, type TextToggle } from "../lib/websiteTextSelection";

const TOGGLES: [string, TextToggle][] = [["Bold", "bold"], ["Italic", "italic"], ["Underline", "underline"], ["Strikethrough", "strike"]];

export function WebsiteTextFormatting({ element, readOnly, onChange, hideWhenEmpty = false }: { hideWhenEmpty?: boolean; element: HTMLElement | null; readOnly?: boolean; onChange: (html: string) => void }) {
  const range = useRef<Range | null>(null);
  const [selected, setSelected] = useState("");
  const [, setTick] = useState(0);
  const [colour, setColour] = useState("#2563EB");
  const [highlight, setHighlight] = useState(DEFAULT_HIGHLIGHT);
  const applyRef = useRef<(action: TextFormatAction) => void>(() => {});
  useEffect(() => {
    range.current = null; setSelected("");
    if (!element) return;
    const document = element.ownerDocument;
    const remember = () => {
      const selection = document.getSelection();
      if (!selection?.rangeCount) return;
      const next = selection.getRangeAt(0);
      if (element.contains(next.commonAncestorContainer)) {
        range.current = next.collapsed ? null : next.cloneRange();
        setSelected(next.toString());
        if (next.collapsed) clearTextFormatter(element); else rememberTextFormatter(element, action => applyRef.current(action));
      } else if (selection.toString()) { range.current = null; setSelected(""); clearTextFormatter(element); }
    };
    document.addEventListener("selectionchange", remember);
    document.addEventListener("mouseup", remember);
    document.addEventListener("keyup", remember);
    remember();
    return () => { clearTextFormatter(element); document.removeEventListener("selectionchange", remember); document.removeEventListener("mouseup", remember); document.removeEventListener("keyup", remember); };
  }, [element]);
  const apply = (action: TextFormatAction) => {
    if (!element || !range.current || readOnly) return;
    const next = applyTextFormat(element, range.current, action);
    if (!next) { range.current = null; setSelected(""); clearTextFormatter(element); return; }
    const selection = element.ownerDocument.getSelection();
    selection?.removeAllRanges(); selection?.addRange(next);
    range.current = next.cloneRange();
    onChange(editableInnerHtml(element));
    setTick(value => value + 1);
  };
  applyRef.current = apply;
  const state = element && selected ? textFormatState(element, range.current) : null;
  return <fieldset hidden={hideWhenEmpty && !selected} disabled={readOnly || !selected} className="mb-2 rounded-xl border border-line bg-sunken p-2" aria-label="Selected text formatting">
    <p aria-live="polite" className="mb-2 text-xs text-muted">{selected ? `Selected text: “${selected.slice(0, 70)}${selected.length > 70 ? "…" : ""}”` : "Highlight words to format only those words."}</p>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1">Text colour<input aria-label="Selected text colour" type="color" value={colour} onChange={event => { setColour(event.target.value); apply({ kind: "set", styles: { color: event.target.value } }); }} className="h-8 w-9" /></label>
      <label className="flex items-center gap-1">Highlight<input aria-label="Selected text highlight" type="color" value={highlight} onChange={event => { setHighlight(event.target.value); apply({ kind: "set", styles: { "background-color": event.target.value } }); }} className="h-8 w-9" /></label>
      {TOGGLES.map(([label, format]) => <button key={label} type="button" aria-pressed={Boolean(state?.[format])} onMouseDown={event => event.preventDefault()} onClick={() => apply({ kind: "toggle", format })} className={`rounded-[10px] border px-2 py-1.5 disabled:opacity-40 ${state?.[format] ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>{label}</button>)}
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => apply({ kind: "clear" })} className="rounded-[10px] border border-line bg-white px-2 py-1.5 disabled:opacity-40">Clear formatting</button>
    </div>
  </fieldset>;
}
