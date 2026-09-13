import { useEffect, useRef, useState } from "react";
import { WebsiteTextFormatting } from "./WebsiteTextFormatting";

export function WebsiteRichText({ html, readOnly, onChange, label = "Editable text" }: { label?: string; html: string; readOnly: boolean; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => { if (ref.current) { ref.current.innerHTML = html; setElement(ref.current); } }, []);
  return <div>
    {!readOnly && <WebsiteTextFormatting element={element} onChange={onChange} />}
    <div ref={ref} role="textbox" aria-label={label} aria-multiline="true" aria-readonly={readOnly} contentEditable={!readOnly} suppressContentEditableWarning className="min-h-12 whitespace-pre-wrap rounded-xl border border-line bg-white p-2 text-sm outline-none focus:border-blue" onInput={() => onChange(ref.current?.innerHTML ?? "")} onPaste={event => { if (readOnly) return; event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); }} onKeyDown={event => { if (event.key === "Enter" && !readOnly) { event.preventDefault(); document.execCommand("insertLineBreak"); } }} />
  </div>;
}
