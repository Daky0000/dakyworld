import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { applyTextFormat, clearTextFormatter, DEFAULT_HIGHLIGHT, editableInnerHtml, rememberTextFormatter, textFormatState, type TextFormatAction } from "../lib/websiteTextSelection";

/**
 * What sits on top of the page while something is selected: a label naming
 * it, a small toolbar of the things people do most, and — while words are
 * highlighted inside it — a dark bar that formats only those words.
 *
 * It is drawn in the editor, over the frame, not inside the page: nothing here
 * can end up in somebody's HTML. Positions are read from the frame's own
 * layout each time it scrolls or resizes, scaled by the canvas zoom.
 */

type Box = { x: number; y: number; w: number; h: number };

const icon = (d: string) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  link: icon("M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"),
  spark: icon("M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"),
  copy: icon("M9 9h11v11H9zM5 15V5a1 1 0 011-1h10"),
  trash: icon("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"),
};

export function WebsiteCanvasOverlay({
  stage,
  frame,
  element,
  label,
  kind,
  zoom,
  typing,
  readOnly,
  canDuplicate,
  canDelete,
  hasParent,
  agent,
  onEdit,
  onBold,
  onItalic,
  onLink,
  onReplace,
  onParent,
  onAgent,
  onDuplicate,
  onDelete,
  onFormat,
}: {
  stage: RefObject<HTMLElement | null>;
  frame: RefObject<HTMLIFrameElement | null>;
  element: HTMLElement | null;
  label: string;
  kind: string;
  zoom: number;
  typing: boolean;
  readOnly: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
  hasParent: boolean;
  agent: boolean;
  onEdit: () => void;
  onBold: () => void;
  onItalic: () => void;
  onLink: () => void;
  onReplace: () => void;
  onParent: () => void;
  onAgent: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onFormat: (html: string) => void;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const [selection, setSelection] = useState<Box | null>(null);
  const range = useRef<Range | null>(null);
  const [tick, setTick] = useState(0);

  const toStage = (rect: DOMRect): Box | null => {
    const frameEl = frame.current;
    const stageEl = stage.current;
    if (!frameEl || !stageEl) return null;
    const f = frameEl.getBoundingClientRect();
    const s = stageEl.getBoundingClientRect();
    return { x: f.left - s.left + stageEl.scrollLeft + rect.left * zoom, y: f.top - s.top + stageEl.scrollTop + rect.top * zoom, w: rect.width * zoom, h: rect.height * zoom };
  };

  // Follow the element through scrolling, resizing and edits.
  useLayoutEffect(() => {
    if (!element) { setBox(null); return; }
    const measure = () => setBox(element.isConnected ? toStage(element.getBoundingClientRect()) : null);
    measure();
    const win = element.ownerDocument.defaultView;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    win?.addEventListener("scroll", measure, { passive: true });
    win?.addEventListener("resize", measure);
    stage.current?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      win?.removeEventListener("scroll", measure);
      win?.removeEventListener("resize", measure);
      stage.current?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, zoom, tick]);

  // Words highlighted inside the element.
  useEffect(() => {
    range.current = null;
    setSelection(null);
    if (!element || readOnly) return;
    const document = element.ownerDocument;
    const remember = () => {
      const current = document.getSelection();
      if (!current?.rangeCount) return;
      const next = current.getRangeAt(0);
      if (!next.collapsed && element.contains(next.commonAncestorContainer)) {
        range.current = next.cloneRange();
        setSelection(toStage(next.getBoundingClientRect()));
        rememberTextFormatter(element, (action) => apply(action));
      } else {
        range.current = null;
        setSelection(null);
        clearTextFormatter(element);
      }
    };
    document.addEventListener("selectionchange", remember);
    return () => { clearTextFormatter(element); document.removeEventListener("selectionchange", remember); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, readOnly, zoom]);

  const apply = (action: TextFormatAction) => {
    if (!element || !range.current) return;
    const next = applyTextFormat(element, range.current, action);
    if (!next) return;
    const current = element.ownerDocument.getSelection();
    current?.removeAllRanges();
    current?.addRange(next);
    range.current = next.cloneRange();
    onFormat(editableInnerHtml(element));
    setTick((value) => value + 1);
  };

  if (!box) return null;
  const state = selection && range.current && element ? textFormatState(element, range.current) : { bold: false, italic: false, underline: false, strike: false };
  const isText = kind !== "image" && kind !== "container" && kind !== "icon" && kind !== "unsupported";
  const isSection = kind === "container";
  const stageWidth = stage.current?.clientWidth ?? 800;
  const miniLeft = Math.max(8, Math.min(box.x, (stage.current?.scrollLeft ?? 0) + stageWidth - 330));
  const miniTop = isSection ? box.y + box.h - 44 : box.y + box.h + 10;

  return (
    <>
      <div className="dx-seltag" style={{ left: isSection ? box.x + 2 : box.x - 2, top: isSection ? box.y + 2 : box.y - 22 }}>{kindName(kind)} · {label}</div>
      {!typing && !readOnly && (
        <div className="dx-mini" role="toolbar" aria-label={`Quick actions for ${label}`} style={{ left: miniLeft, top: miniTop }} onMouseDown={(event) => event.preventDefault()}>
          {isText && (
            <>
              <button type="button" className="dx-ib" onClick={onEdit}>Edit text</button>
              <button type="button" className="dx-ib" title="Bold" aria-label="Bold" onClick={onBold}><b>B</b></button>
              <button type="button" className="dx-ib" title="Italic" aria-label="Italic" onClick={onItalic}><i>I</i></button>
              {(kind === "link" || kind === "button") && <button type="button" className="dx-ib" title="Where it goes" aria-label="Where it goes" onClick={onLink}>{I.link}</button>}
              <span className="dx-sep" />
            </>
          )}
          {(kind === "image" || kind === "icon") && (
            <>
              <button type="button" className="dx-ib" onClick={onReplace}>Replace</button>
              <span className="dx-sep" />
            </>
          )}
          <button type="button" className="dx-ib" title="Select parent" aria-label="Select parent" disabled={!hasParent} onClick={onParent}>↑</button>
          {agent && <button type="button" className="dx-ib" title="Ask the agent" aria-label="Ask the agent" onClick={onAgent}>{I.spark}</button>}
          <button type="button" className="dx-ib" title="Duplicate" aria-label="Duplicate" disabled={!canDuplicate} onClick={onDuplicate}>{I.copy}</button>
          <button type="button" className="dx-ib" title="Delete" aria-label="Delete" disabled={!canDelete} onClick={onDelete}>{I.trash}</button>
        </div>
      )}
      {selection && range.current && (
        <div
          className="dx-fmtbar"
          role="toolbar"
          aria-label="Format the highlighted words"
          style={{ left: Math.max(8, selection.x + selection.w / 2 - 150), top: Math.max(4, selection.y - 44) }}
          onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}
        >
          {/* Each press switches it on or off, judged by the words themselves. */}
          <button type="button" title="Bold" aria-label="Bold" aria-pressed={state.bold} onClick={() => apply({ kind: "toggle", format: "bold" })}><b>B</b></button>
          <button type="button" title="Italic" aria-label="Italic" aria-pressed={state.italic} onClick={() => apply({ kind: "toggle", format: "italic" })}><i>I</i></button>
          <button type="button" title="Underline" aria-label="Underline" aria-pressed={state.underline} onClick={() => apply({ kind: "toggle", format: "underline" })}><u>U</u></button>
          <button type="button" title="Strikethrough" aria-label="Strikethrough" aria-pressed={state.strike} onClick={() => apply({ kind: "toggle", format: "strike" })}><s>S</s></button>
          <span className="dx-sep" />
          <label title="Text colour"><span className="dx-ftc">A</span><input type="color" aria-label="Selected text colour" defaultValue="#3157ff" onChange={(event) => apply({ kind: "set", styles: { color: event.target.value } })} /></label>
          <label title="Highlight"><span className="dx-fhl">A</span><input type="color" aria-label="Selected text highlight" defaultValue={DEFAULT_HIGHLIGHT} onChange={(event) => apply({ kind: "set", styles: { "background-color": event.target.value } })} /></label>
          <span className="dx-sep" />
          <button type="button" title="Clear formatting: bold, italic, lines, colour and highlight" aria-label="Clear formatting" onClick={() => apply({ kind: "clear" })}>Aa</button>
        </div>
      )}
    </>
  );
}

function kindName(kind: string) {
  return { text: "Text", richtext: "Text", link: "Link", button: "Button", image: "Image", icon: "Image", container: "Section", background: "Section" }[kind] ?? "Element";
}
