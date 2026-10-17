import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { editorTip } from "../lib/editorTips";

/**
 * One hover tooltip for the whole editor.
 *
 * A control gets a tip in one of three ways, and none of them needs the control
 * to import anything:
 *
 * - **`data-tip`** written by the component itself, with `data-tip-heading` for
 *   a bold first line. This always wins.
 * - **The glossary** (`lib/editorTips.ts`): a label whose words match an entry,
 *   or a button inside a labelled group matching `Group/Option`.
 * - **A `title` the editor already wrote.** The browser's own title tooltip
 *   waits a second and cannot be styled; it is moved onto `data-tip` so every
 *   hint in the editor looks and behaves the same.
 *
 * The bubble is `position: fixed`, placed from the target's rectangle and
 * rendered into `document.body`: inside the editor it sat under the inspector,
 * which has a stacking layer of its own, and an absolutely positioned child of
 * the panel would have been clipped by its scrolling.
 *
 * `data-tip-field` + `data-tip-variant` ask for a sample of a button style: the
 * button is copied in the preview, given that class, measured and removed, and
 * the tip shows what it actually looks like on this site. A style is a class in
 * somebody else's stylesheet, so its name ("b", "o") often says nothing; the
 * sample is the only description that cannot be wrong.
 */

type Look = {
  backdrop: string;
  background: string;
  color: string;
  border: string;
  radius: string;
  weight: string;
  transform: string;
  text: string;
  summary: string;
};

type Shown = { target: HTMLElement; heading?: string; text: string; look: Look | null };

const SHOW_DELAY = 300;
const LABELS = "label, .dx-lt, .dx-row-l";
const GROUP_BUTTONS = "[role=radiogroup][aria-label] > button, [role=group][aria-label] > button, .dx-segc[aria-label] > button";

export function EditorTips({ frame }: { frame: RefObject<HTMLIFrameElement | null> }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Give every matching control its tip, and keep doing so as panels open.
  useEffect(() => {
    const root = anchor.current?.closest<HTMLElement>(".dx-editor");
    if (!root) return;
    let queued = 0;
    const run = () => {
      queued = 0;
      annotate(root);
    };
    run();
    const observer = new MutationObserver(() => {
      if (!queued) queued = requestAnimationFrame(run);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "aria-label"] });
    return () => {
      observer.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
  }, []);

  // Show on hover (after a short pause) and on keyboard focus (at once).
  useEffect(() => {
    const root = anchor.current?.closest<HTMLElement>(".dx-editor");
    if (!root) return;
    let timer = 0;
    let current: HTMLElement | null = null;
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setShown(null);
    };
    const open = (target: HTMLElement) => {
      const text = target.dataset.tip?.trim();
      if (!text || !target.isConnected) return;
      const field = target.dataset.tipField;
      const look = field !== undefined ? sampleLook(frame.current, field, target.dataset.tipVariant ?? "", (target.dataset.tipVariants ?? "").split(" ").filter(Boolean)) : null;
      setShown({ target, heading: target.dataset.tipHeading, text, look });
    };
    const tipOf = (node: EventTarget | null) => (node instanceof Element ? node.closest<HTMLElement>("[data-tip]") : null);

    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = tipOf(event.target);
      if (target === current) return;
      window.clearTimeout(timer);
      current = target;
      if (!target) return setShown(null);
      timer = window.setTimeout(() => open(target), SHOW_DELAY);
    };
    const out = (event: PointerEvent) => {
      if (!current) return;
      const next = event.relatedTarget;
      if (next instanceof Node && current.contains(next)) return;
      hide();
    };
    const focus = (event: FocusEvent) => {
      const target = tipOf(event.target);
      if (!target || !(event.target as Element).matches?.(":focus-visible")) return;
      window.clearTimeout(timer);
      current = target;
      open(target);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    root.addEventListener("pointerover", over);
    root.addEventListener("pointerout", out);
    root.addEventListener("pointerdown", hide);
    root.addEventListener("focusin", focus);
    root.addEventListener("focusout", hide);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerout", out);
      root.removeEventListener("pointerdown", hide);
      root.removeEventListener("focusin", focus);
      root.removeEventListener("focusout", hide);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [frame]);

  // Above the control when there is room, below it when there is not, and never off screen.
  useLayoutEffect(() => {
    if (!shown || !bubble.current) return setPlace(null);
    const rect = shown.target.getBoundingClientRect();
    const { width, height } = bubble.current.getBoundingClientRect();
    const gap = 8;
    const above = rect.top - height - gap;
    const top = above >= gap ? above : Math.min(rect.bottom + gap, window.innerHeight - height - gap);
    const left = Math.max(gap, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - gap));
    setPlace({ left, top });
  }, [shown]);

  // Screen readers hear the tip as the control's description while it is open.
  useEffect(() => {
    const target = shown?.target;
    if (!target || target.hasAttribute("aria-describedby")) return;
    target.setAttribute("aria-describedby", "dx-editor-tip");
    return () => target.removeAttribute("aria-describedby");
  }, [shown]);

  return (
    <>
      <span ref={anchor} hidden />
      {shown && createPortal(
        <div
          ref={bubble}
          id="dx-editor-tip"
          role="tooltip"
          className="dx-tip"
          style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}
        >
          {shown.heading && <strong>{shown.heading}</strong>}
          <span>{shown.text}</span>
          {shown.look && (
            <span className="dx-tip-look">
              <span className="dx-tip-stage" style={{ background: shown.look.backdrop }}>
                <span
                  className="dx-tip-sample"
                  style={{
                    background: shown.look.background,
                    color: shown.look.color,
                    border: shown.look.border,
                    borderRadius: shown.look.radius,
                    fontWeight: shown.look.weight as never,
                    textTransform: shown.look.transform as never,
                  }}
                >
                  {shown.look.text}
                </span>
              </span>
              <span className="dx-tip-sum">{shown.look.summary}</span>
            </span>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Write `data-tip` onto every control the glossary or a `title` explains. */
function annotate(root: HTMLElement) {
  const give = (element: HTMLElement, tip: string, heading?: string) => {
    if (element.dataset.tip === tip && element.dataset.tipHeading === heading) return;
    element.dataset.tip = tip;
    element.dataset.tipAuto = "";
    if (heading) element.dataset.tipHeading = heading;
    else delete element.dataset.tipHeading;
  };
  const owned = (element: HTMLElement) => element.dataset.tip !== undefined && element.dataset.tipAuto === undefined;
  const words = (element: HTMLElement) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
  // The title goes once a tip replaces it, or the browser shows both. A button
  // that was named only by its title keeps that name as its aria-label.
  const dropTitle = (element: HTMLElement, title: string) => {
    if (!element.getAttribute("aria-label") && !words(element) && !element.getAttribute("aria-labelledby")) element.setAttribute("aria-label", title);
    element.removeAttribute("title");
  };

  for (const element of root.querySelectorAll<HTMLElement>(LABELS)) {
    if (owned(element)) continue;
    const text = words(element);
    const tip = editorTip(text);
    if (!tip) continue;
    give(element, tip, text);
    if (element.title) dropTitle(element, element.title);
  }

  for (const element of root.querySelectorAll<HTMLElement>(GROUP_BUTTONS)) {
    if (owned(element)) continue;
    const group = element.parentElement?.getAttribute("aria-label") ?? "";
    const name = element.getAttribute("aria-label") || words(element) || element.title;
    const tip = editorTip(`${group}/${name}`);
    if (!tip) continue;
    give(element, tip);
    if (element.title) dropTitle(element, element.title);
  }

  for (const element of root.querySelectorAll<HTMLElement>("[title]")) {
    if (owned(element) || element.tagName === "IFRAME") continue;
    const title = element.title.trim();
    // A title that only repeats the words already on screen is there for when
    // they are cut off; it is not a hint and is left to the browser.
    if (!title || title === words(element)) continue;
    give(element, title);
    dropTitle(element, title);
  }
}

/** Copy the button in the preview, give it `variant` instead of its current style, and measure it. */
function sampleLook(frame: HTMLIFrameElement | null, fieldId: string, variant: string, variants: string[]): Look | null {
  try {
    const doc = frame?.contentDocument;
    const win = doc?.defaultView;
    const element = doc?.querySelector<HTMLElement>(`[data-dw-field="${CSS.escape(fieldId)}"]`);
    if (!doc || !win || !element?.parentNode) return null;

    const copy = element.cloneNode(true) as HTMLElement;
    for (const name of ["data-dw-field", "data-dw-selected", "id"]) copy.removeAttribute(name);
    for (const token of variants) copy.classList.remove(token);
    if (variant) copy.classList.add(variant);
    copy.setAttribute("aria-hidden", "true");
    for (const [property, value] of [["position", "absolute"], ["visibility", "hidden"], ["pointer-events", "none"], ["transition", "none"], ["animation", "none"]]) {
      copy.style.setProperty(property, value, "important");
    }
    element.parentNode.insertBefore(copy, element.nextSibling);
    const style = win.getComputedStyle(copy);
    const read = {
      background: style.backgroundColor,
      image: style.backgroundImage,
      color: style.color,
      borderWidth: parseFloat(style.borderTopWidth) || 0,
      borderStyle: style.borderTopStyle,
      borderColor: style.borderTopColor,
      radius: parseFloat(style.borderTopLeftRadius) || 0,
      weight: style.fontWeight,
      transform: style.textTransform,
    };
    const text = (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    copy.remove();

    let backdrop = "#FFFFFF";
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const colour = win.getComputedStyle(parent).backgroundColor;
      if (alpha(colour) > 0.05) {
        backdrop = colour;
        break;
      }
    }

    const gradient = read.image && read.image !== "none" && !/url\(/.test(read.image);
    const filled = gradient || alpha(read.background) > 0.05;
    const bordered = read.borderWidth > 0 && read.borderStyle !== "none" && alpha(read.borderColor) > 0.05;
    const summary = [
      gradient ? "Gradient fill" : filled ? `Filled ${hex(read.background)}` : bordered ? "Outline, no fill" : "No fill",
      bordered ? `${Math.round(read.borderWidth)}px ${hex(read.borderColor)} border` : "",
      `${hex(read.color)} text`,
    ].filter(Boolean).join(" · ");

    return {
      backdrop,
      background: gradient ? read.image : read.background,
      color: read.color,
      border: bordered ? `${Math.min(read.borderWidth, 3)}px solid ${read.borderColor}` : "1px solid transparent",
      radius: `${Math.min(read.radius, 999)}px`,
      weight: read.weight,
      transform: read.transform,
      text: text.length > 22 ? `${text.slice(0, 21)}…` : text || "Button",
      summary,
    };
  } catch {
    // A preview on another origin cannot be read; the words alone still explain it.
    return null;
  }
}

function channels(colour: string): number[] | null {
  const match = /rgba?\(([^)]+)\)/.exec(colour);
  return match ? match[1].split(/[\s,/]+/).filter(Boolean).map(Number) : null;
}

function alpha(colour: string): number {
  if (!colour || colour === "transparent") return 0;
  const parts = channels(colour);
  return parts ? (parts.length > 3 ? parts[3] : 1) : 1;
}

function hex(colour: string): string {
  const parts = channels(colour);
  if (!parts) return colour;
  return `#${parts.slice(0, 3).map((part) => Math.round(part).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
