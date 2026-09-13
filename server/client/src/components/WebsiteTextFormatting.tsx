import { useEffect, useRef, useState } from "react";
import { clearTextFormatter, rememberTextFormatter, editableInnerHtml, formatTextRange, type InlineFormat } from "../lib/websiteTextSelection";

export function WebsiteTextFormatting({ element, readOnly, onChange }: { element: HTMLElement | null; readOnly?: boolean; onChange: (html: string) => void }) {
  const range = useRef<Range | null>(null);
  const [selected, setSelected] = useState("");
  const [colour, setColour] = useState("#3157ff");
  const [highlight, setHighlight] = useState("#fff2a8");
  const applyRef = useRef<(styles: Partial<Record<InlineFormat, string>>) => void>(() => {});
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
        if (next.collapsed) clearTextFormatter(element); else rememberTextFormatter(element, styles => applyRef.current(styles));
      } else if (selection.toString()) { range.current = null; setSelected(""); clearTextFormatter(element); }
    };
    document.addEventListener("selectionchange", remember);
    document.addEventListener("mouseup", remember);
    document.addEventListener("keyup", remember);
    remember();
    return () => { clearTextFormatter(element); document.removeEventListener("selectionchange", remember); document.removeEventListener("mouseup", remember); document.removeEventListener("keyup", remember); };
  }, [element]);
  const apply = (styles: Partial<Record<InlineFormat, string>>) => {
    if (!element || !range.current || readOnly) return;
    const next = formatTextRange(element, range.current, styles);
    if (!next) { range.current = null; setSelected(""); clearTextFormatter(element); return; }
    const selection = element.ownerDocument.getSelection();
    selection?.removeAllRanges(); selection?.addRange(next);
    range.current = next.cloneRange();
    onChange(editableInnerHtml(element));
  };
  applyRef.current = apply;
  return <fieldset disabled={readOnly || !selected} className="mb-2 rounded-xl border border-line bg-sunken p-2" aria-label="Selected text formatting">
    <p aria-live="polite" className="mb-2 text-xs text-muted">{selected ? `Selected text: “${selected.slice(0, 70)}${selected.length > 70 ? "…" : ""}”` : "Highlight words to format only those words."}</p>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1">Text colour<input aria-label="Selected text colour" type="color" value={colour} onChange={event => { setColour(event.target.value); apply({ color: event.target.value }); }} className="h-8 w-9" /></label>
      <label className="flex items-center gap-1">Highlight<input aria-label="Selected text highlight" type="color" value={highlight} onChange={event => { setHighlight(event.target.value); apply({ "background-color": event.target.value }); }} className="h-8 w-9" /></label>
      {([['Bold', { 'font-weight': '700' }], ['Italic', { 'font-style': 'italic' }], ['Underline', { 'text-decoration': 'underline' }]] as const).map(([label, styles]) => <button key={label} type="button" onMouseDown={event => event.preventDefault()} onClick={() => apply(styles)} className="rounded-lg border border-line bg-white px-2 py-1.5 disabled:opacity-40">{label}</button>)}
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => apply({ "font-weight": "normal", "font-style": "normal" })} className="rounded-lg border border-line bg-white px-2 py-1.5 disabled:opacity-40">Regular weight & style</button>
    </div>
  </fieldset>;
}
