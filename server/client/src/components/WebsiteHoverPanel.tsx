import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { INTERACTION_PROPERTIES, interactionCss } from "../../../src/shared/websiteInteraction";
import { ColorCodeInput, parseStyle, writeStyle } from "./InspectorControls";
import { Acc, Field, SHADOW_PRESETS, TILE_ICON, Tiles, Toggle, type TileOption } from "./InspectorDesign";

/**
 * The Style tab's state views: how the element looks while the mouse is over
 * it (Hover), while it is being pressed (Active) and when it has keyboard
 * focus (Focus). Every control writes one of the `--dw-<state>-*` properties
 * that the fixed rules in `shared/websiteInteraction.ts` apply under `:hover`,
 * `:active` and `:focus-visible`, so this is the same mechanism the page
 * already published — only easier to reach. While a view is open the element
 * is shown in that state on the canvas.
 */

export type StyleState = "hover" | "active" | "focus";

const STATES: Record<StyleState, { label: string; word: string; when: string; around: string }> = {
  hover: { label: "Hover", word: "hover", when: "when the mouse is over it", around: "When something around this element is hovered" },
  active: { label: "Active", word: "active", when: "while it is being pressed or clicked", around: "While something around this element is pressed" },
  focus: { label: "Focus", word: "focus", when: "when it is reached with the keyboard (Tab)", around: "When something around this element has focus" },
};

/**
 * Normal, and one interactive state with an arrow beside it that swaps between
 * Hover, Active and Focus. The segment remembers the last one picked, so
 * Normal → back is one click.
 */
export function StyleStateSwitch({ value, last, onChange }: { value: "normal" | StyleState; last: StyleState; onChange: (state: "normal" | StyleState) => void }) {
  const shown = value === "normal" ? last : value;
  return (
    <div className="dx-segc" role="group" aria-label="Pick a state to style">
      <button type="button" aria-pressed={value === "normal"} onClick={() => onChange("normal")}>Normal</button>
      <span className="relative flex flex-1">
        <button type="button" className="flex-1 !pr-7" aria-pressed={value !== "normal"} onClick={() => onChange(shown)}>{STATES[shown].label}</button>
        <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] opacity-70">▾</span>
        <select
          aria-label="Choose the state: hover, active or focus"
          title="Hover, Active (pressed) or Focus (keyboard)"
          className="absolute inset-y-0 right-0 w-7 cursor-pointer opacity-0"
          value={shown}
          onChange={(event) => onChange(event.target.value as StyleState)}
        >
          {(Object.keys(STATES) as StyleState[]).map((state) => <option key={state} value={state}>{STATES[state].label}{state === "active" ? " (pressed)" : state === "focus" ? " (keyboard)" : ""}</option>)}
        </select>
      </span>
    </div>
  );
}

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

type HoverRule = { state?: StyleState; selector: string; hover: string; self: boolean; media?: string; declarations: Array<[string, string]> };

/** The properties a Hover control writes, and so the site's own values it can show and take over. */
const EDITABLE: readonly string[] = INTERACTION_PROPERTIES;

/**
 * What the site's own CSS already does when this element is hovered, nearest
 * rule last so a later declaration wins as it does in the browser. A rule for
 * hovering something around the element (`.card:hover .title`) counts too —
 * it is still this element that changes.
 */
function siteHover(element: HTMLElement | null, rules: HoverRule[], state: StyleState): { found: Map<string, { value: string; self: boolean }>; count: number } {
  const found = new Map<string, { value: string; self: boolean }>();
  let count = 0;
  if (!element) return { found, count };
  const view = element.ownerDocument.defaultView;
  for (const rule of rules) {
    if ((rule.state ?? "hover") !== state) continue;
    if (rule.media && view && !view.matchMedia(rule.media).matches) continue;
    let matches = false;
    try { matches = element.matches(rule.selector); } catch { continue; }
    if (!matches) continue;
    count += 1;
    for (const [property, value] of rule.declarations) {
      const name = property === "background" && !/url\(|gradient/i.test(value) ? "background-color" : property === "text-decoration-line" ? "text-decoration" : property;
      if (name.startsWith("--") || name === "transition" || name.startsWith("transition-")) continue;
      found.set(name, { value: value.replace(/\s*!important$/, ""), self: rule.self });
    }
  }
  return { found, count };
}

export function WebsiteHoverPanel({ pageId, state = "hover", element, style, readOnly, onChange }: { pageId?: string; state?: StyleState; element: HTMLElement | null; style: string; readOnly: boolean; onChange: (style: string) => void }) {
  const map = parseStyle(style);
  const prefix = `--dw-${state}-`;
  const { label, word, when, around } = STATES[state];
  const rules = useQuery({
    queryKey: ["website", "hover-rules", pageId],
    enabled: !!pageId,
    staleTime: 60_000,
    queryFn: ({ signal }) => api.get<{ rules: HoverRule[] }>(`/website/pages/${pageId}/hover-rules`, signal),
  });
  const site = useMemo(() => siteHover(element, rules.data?.rules ?? [], state), [element, rules.data, state]);
  const designed = (property: string) => site.found.get(property)?.value ?? "As designed";
  const write = (patch: Record<string, string | null>) => {
    const next = { ...map };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") delete next[key];
      else next[key] = value;
    }
    onChange(writeStyle(next));
  };

  // Show the state on the canvas while this view is open.
  useEffect(() => {
    if (!element) return;
    const document = element.ownerDocument;
    if (!document.querySelector("style[data-dw-interaction-preview]")) {
      const sheet = document.createElement("style");
      sheet.setAttribute("data-dw-interaction-preview", "");
      sheet.textContent = interactionCss(true);
      (document.head || document.body).appendChild(sheet);
    }
    element.setAttribute("data-dw-state-preview", state);
    return () => element.removeAttribute("data-dw-state-preview");
  }, [element, state]);

  const move = MOVES.find((option) => option.transform && option.transform === map[`${prefix}transform`])?.value ?? "none";
  const shadow = SHADOW_PRESETS.find((option) => option.css === map[`${prefix}box-shadow`])?.value ?? (map[`${prefix}box-shadow`] ? "" : "none");

  return (
    <fieldset disabled={readOnly}>
      <div className="dx-statebar">{TILE_ICON.cursor}<span>Styling <b>{word}</b>: every change below shows {when}</span></div>
      {site.found.size > 0 && (
        <Acc title="On this website already" summary={`${site.found.size} change${site.found.size === 1 ? "" : "s"}`} open>
          <p className="dx-hint">What the site's own styling does {when}. Change any of it below — your value replaces the site's in that state, and the site's file is left as it was.</p>
          <ul className="grid gap-1.5">
            {[...site.found].map(([property, { value, self }]) => (
              <li key={property} className="dx-crow">
                <span title={self ? `${label}: this element itself` : around}>{property}{self ? "" : " ·"}</span>
                <code className="dx-mono min-w-0 flex-1 truncate text-right">{value}</code>
                {EDITABLE.includes(property) && !map[`${prefix}${property}`] && (
                  <button type="button" className="dx-btn dx-ghost" disabled={readOnly} onClick={() => write({ [`${prefix}${property}`]: value })}>Edit</button>
                )}
              </li>
            ))}
          </ul>
        </Acc>
      )}
      <Acc title={`${label} options`} summary={MOVES.find((option) => option.value === move)?.label} open>
        <Field label="Movement">
          <Tiles label={`${label} movement`} options={MOVES} value={move} onChange={(value) => write({ [`${prefix}transform`]: MOVES.find((option) => option.value === value)?.transform ?? null })} />
        </Field>
        <Toggle label="Underline text" checked={map[`${prefix}text-decoration`] === "underline"} onChange={(on) => write({ [`${prefix}text-decoration`]: on ? "underline" : null })} />
        <Field label="Change speed">
          <select aria-label="Change speed" value={map.transition ?? ""} onChange={(event) => write({ transition: event.target.value || null })}>
            {SPEEDS.map(([name, value]) => <option key={name} value={value}>{name}</option>)}
          </select>
        </Field>
      </Acc>
      <Acc title="Colours" summary={map[`${prefix}color`] || map[`${prefix}background-color`] || "As designed"} open>
        <div className="dx-crow"><span>Text colour</span><ColorCodeInput label={`${label} text colour`} value={map[`${prefix}color`] ?? ""} placeholder={designed("color")} disabled={readOnly} onChange={(value) => write({ [`${prefix}color`]: value || null })} /></div>
        <div className="dx-crow"><span>Background</span><ColorCodeInput label={`${label} background`} value={map[`${prefix}background-color`] ?? ""} placeholder={designed("background-color")} disabled={readOnly} onChange={(value) => write({ [`${prefix}background-color`]: value || null })} /></div>
        <div className="dx-crow"><span>Border</span><ColorCodeInput label={`${label} border colour`} value={map[`${prefix}border-color`] ?? ""} placeholder={designed("border-color")} disabled={readOnly} onChange={(value) => write({ [`${prefix}border-color`]: value || null })} /></div>
      </Acc>
      <Acc title="Effects" summary={SHADOW_PRESETS.find((option) => option.value === shadow)?.label ?? "Custom"} open>
        <Field label="Shadow">
          <Tiles
            label={`${label} shadow`}
            options={SHADOW_PRESETS.map((option) => ({ value: option.value, label: option.label, demo: option.css }))}
            value={shadow}
            onChange={(value) => write({ [`${prefix}box-shadow`]: value === "none" ? null : SHADOW_PRESETS.find((option) => option.value === value)?.css ?? null })}
          />
        </Field>
        <Field label="Opacity">
          <select aria-label={`${label} opacity`} value={map[`${prefix}opacity`] ?? ""} onChange={(event) => write({ [`${prefix}opacity`]: event.target.value || null })}>
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
            for (const key of Object.keys(next)) if (key.startsWith(prefix)) delete next[key];
            onChange(writeStyle(next));
          }}
        >
          Reset {word} style
        </button>
      </div>
    </fieldset>
  );
}
