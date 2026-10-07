import { useEffect } from "react";
import { interactionCss } from "../../../src/shared/websiteInteraction";
import { ColorCodeInput, parseStyle, writeStyle } from "./InspectorControls";
import { Acc, Field, SHADOW_PRESETS, TILE_ICON, Tiles, Toggle, type TileOption } from "./InspectorDesign";

/**
 * The Style tab's Hover view: how the element looks while the mouse is over
 * it. Every control writes one of the `--dw-hover-*` properties that the fixed
 * rules in `shared/websiteInteraction.ts` apply under `:hover`, so this is the
 * same mechanism the page already published — only easier to reach. While the
 * view is open the element is shown in its hover state on the canvas.
 */

const MOVES: (TileOption & { transform: string })[] = [
  { value: "none", label: "None", icon: TILE_ICON.none, transform: "" },
  { value: "lift", label: "Lift", icon: TILE_ICON.up, transform: "translateY(-4px)" },
  { value: "sink", label: "Sink", icon: TILE_ICON.down, transform: "translateY(2px)" },
  { value: "grow", label: "Grow", icon: TILE_ICON.plus, transform: "scale(1.05)" },
  { value: "shrink", label: "Shrink", icon: TILE_ICON.minus, transform: "scale(.95)" },
  { value: "tilt", label: "Tilt", icon: TILE_ICON.reload, transform: "rotate(-2deg)" },
];



const SPEEDS: [string, string][] = [
  ["Website default", ""],
  ["None", "none"],
  ["Fast (150 ms)", "all 150ms ease"],
  ["Normal (250 ms)", "all 250ms ease"],
  ["Slow (400 ms)", "all 400ms ease"],
];

export function WebsiteHoverPanel({ element, style, readOnly, onChange }: { element: HTMLElement | null; style: string; readOnly: boolean; onChange: (style: string) => void }) {
  const map = parseStyle(style);
  const write = (patch: Record<string, string | null>) => {
    const next = { ...map };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") delete next[key];
      else next[key] = value;
    }
    onChange(writeStyle(next));
  };

  // Show the hover state on the canvas while this view is open.
  useEffect(() => {
    if (!element) return;
    const document = element.ownerDocument;
    if (!document.querySelector("style[data-dw-interaction-preview]")) {
      const sheet = document.createElement("style");
      sheet.setAttribute("data-dw-interaction-preview", "");
      sheet.textContent = interactionCss(true);
      (document.head || document.body).appendChild(sheet);
    }
    element.setAttribute("data-dw-state-preview", "hover");
    return () => element.removeAttribute("data-dw-state-preview");
  }, [element]);

  const move = MOVES.find((option) => option.transform && option.transform === map["--dw-hover-transform"])?.value ?? "none";
  const shadow = SHADOW_PRESETS.find((option) => option.css === map["--dw-hover-box-shadow"])?.value ?? (map["--dw-hover-box-shadow"] ? "" : "none");

  return (
    <fieldset disabled={readOnly}>
      <div className="dx-statebar">{TILE_ICON.cursor}<span>Styling <b>hover</b>: every change below shows when the mouse is over it</span></div>
      <Acc title="Hover options" summary={MOVES.find((option) => option.value === move)?.label} open>
        <Field label="Movement">
          <Tiles label="Hover movement" options={MOVES} value={move} onChange={(value) => write({ "--dw-hover-transform": MOVES.find((option) => option.value === value)?.transform ?? null })} />
        </Field>
        <Toggle label="Underline text" checked={map["--dw-hover-text-decoration"] === "underline"} onChange={(on) => write({ "--dw-hover-text-decoration": on ? "underline" : null })} />
        <Field label="Change speed">
          <select aria-label="Change speed" value={map.transition ?? ""} onChange={(event) => write({ transition: event.target.value || null })}>
            {SPEEDS.map(([name, value]) => <option key={name} value={value}>{name}</option>)}
          </select>
        </Field>
      </Acc>
      <Acc title="Colours" summary={map["--dw-hover-color"] || map["--dw-hover-background-color"] || "As designed"} open>
        <div className="dx-crow"><span>Text colour</span><ColorCodeInput label="Hover text colour" value={map["--dw-hover-color"] ?? ""} placeholder="As designed" disabled={readOnly} onChange={(value) => write({ "--dw-hover-color": value || null })} /></div>
        <div className="dx-crow"><span>Background</span><ColorCodeInput label="Hover background" value={map["--dw-hover-background-color"] ?? ""} placeholder="As designed" disabled={readOnly} onChange={(value) => write({ "--dw-hover-background-color": value || null })} /></div>
        <div className="dx-crow"><span>Border</span><ColorCodeInput label="Hover border colour" value={map["--dw-hover-border-color"] ?? ""} placeholder="As designed" disabled={readOnly} onChange={(value) => write({ "--dw-hover-border-color": value || null })} /></div>
      </Acc>
      <Acc title="Effects" summary={SHADOW_PRESETS.find((option) => option.value === shadow)?.label ?? "Custom"} open>
        <Field label="Shadow">
          <Tiles
            label="Hover shadow"
            options={SHADOW_PRESETS.map((option) => ({ value: option.value, label: option.label, demo: option.css }))}
            value={shadow}
            onChange={(value) => write({ "--dw-hover-box-shadow": value === "none" ? null : SHADOW_PRESETS.find((option) => option.value === value)?.css ?? null })}
          />
        </Field>
        <Field label="Opacity">
          <select aria-label="Hover opacity" value={map["--dw-hover-opacity"] ?? ""} onChange={(event) => write({ "--dw-hover-opacity": event.target.value || null })}>
            <option value="">As designed</option>
            {["0.9", "0.8", "0.7", "0.5"].map((value) => <option key={value} value={value}>{Number(value) * 100}%</option>)}
          </select>
        </Field>
      </Acc>
      <div className="dx-pad">
        <button
          type="button"
          className="dx-btn dx-ghost dx-full"
          onClick={() => {
            const next = { ...map };
            for (const key of Object.keys(next)) if (key.startsWith("--dw-hover-")) delete next[key];
            onChange(writeStyle(next));
          }}
        >
          Reset hover style
        </button>
      </div>
    </fieldset>
  );
}
