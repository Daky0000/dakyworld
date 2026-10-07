import { useEffect, useRef, useState } from "react";
import { WebsiteTextFormatting } from "./WebsiteTextFormatting";

export function WebsiteRichText({ html, readOnly, onChange, label = "Editable text", plain = false }: { label?: string; html: string; readOnly: boolean; onChange: (html: string) => void; /** The inspector text box: highlighted words are formatted from the bar on the page instead. */ plain?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    // Canvas edits, undo and version restores must reach the inspector too.
    // Matching content is left untouched so local typing retains its caret.
    if (ref.current.innerHTML !== html) ref.current.innerHTML = html;
    setElement(ref.current);
  }, [html]);
  return <div>
    {!readOnly && !plain && <WebsiteTextFormatting element={element} onChange={onChange} />}
    <div ref={ref} role="textbox" aria-label={label} aria-multiline="true" aria-readonly={readOnly} contentEditable={!readOnly} suppressContentEditableWarning className={plain ? "dx-textbox" : "min-h-12 whitespace-pre-wrap rounded-xl border border-line bg-white p-2 text-sm outline-none focus:border-blue"} onInput={() => onChange(ref.current?.innerHTML ?? "")} onPaste={event => { if (readOnly) return; event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); }} onKeyDown={event => { if (event.key === "Enter" && !readOnly) { event.preventDefault(); document.execCommand("insertLineBreak"); } }} />
  </div>;
}
