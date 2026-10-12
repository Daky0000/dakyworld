import { useEffect, useState, type ReactNode } from "react";
import { interactionCss } from "../../../src/shared/websiteInteraction";
import { parseStyle, writeStyle } from "./InspectorControls";
import { ICON, Num, Pick } from "./StyleControls";
import {
  APPEARING, EASINGS, EFFECT_LABEL, FEEDBACK, TRIGGERS, defaultInteraction, effectsFor, readInteractions, slotOf, slotTaken, summary,
  writeInteraction, type Direction, type Effect, type Interaction, type MotionState, type Trigger,
} from "../lib/websiteMotion";

/**
 * The Interactions tab: animations started by the page loading, by scrolling,
 * by the pointer or by a press, listed the way the page builder this follows
 * lists them — "On page load: Fade In" — each with a Details and a Settings tab.
 *
 * Nothing here writes CSS. Each choice is a keyframe name or a number in a
 * `--dw-*` custom property on the element's own style, and the fixed rules in
 * `shared/websiteInteraction.ts` are what animate it, so a stored value can
 * only ever pick one of the animations that exist. No script is added to the
 * page, which is why a click plays while the element is pressed rather than on
 * its own afterwards: that needs code the page does not carry.
 */

const HINT: Record<Trigger, string> = {
  load: "Plays once the page has loaded.",
  view: "Plays as it scrolls into view, in browsers that support scroll-linked animation; others play it when the page loads.",
  scroll: "Follows the scroll: the effect runs between the start and end points as the page moves. Browsers without scroll-linked animation show the element as it is.",
  hover: "Plays while the pointer is over it and stops when it leaves. To change colours or lift it on hover, use Style → Hover.",
  click: "Plays while it is pressed; links and buttons keep it until something else is clicked. The page has no script, so a click can't start a long animation on its own.",
  loop: "Keeps moving after it has appeared, to draw attention. Use sparingly.",
};

const DIRECTIONS: { value: Exclude<Direction, "">; label: string; icon: ReactNode }[] = [
  { value: "top", label: "From top", icon: ICON.arrowDown },
  { value: "bottom", label: "From bottom", icon: ICON.arrowUp },
  { value: "left", label: "From left", icon: ICON.arrowRight },
  { value: "right", label: "From right", icon: ICON.arrowLeft },
];

/** Order a new interaction is offered in: the commonest first, skipping any trigger already in use. */
const CREATE_ORDER: Trigger[] = ["load", "hover", "click", "scroll", "loop"];

export function WebsiteInteractionsPanel({
  element,
  style,
  readOnly,
  onChange,
}: {
  element: HTMLElement | null;
  style: string;
  readOnly: boolean;
  onChange: (style: string) => void;
}) {
  const map = parseStyle(style);
  const interactions = readInteractions(map);
  const [openTrigger, setOpenTrigger] = useState<Trigger | null>(interactions[0]?.trigger ?? null);

  // The page carries these rules once it uses motion, and the editing preview
  // always does; a frame that has neither still gets them, so Play shows something.
  useEffect(() => {
    const document = element?.ownerDocument;
    if (!document || document.querySelector("style[data-dw-interaction-preview]")) return;
    const sheet = document.createElement("style");
    sheet.setAttribute("data-dw-interaction-preview", "");
    sheet.textContent = interactionCss(true);
    (document.head || document.body).appendChild(sheet);
  }, [element]);

  const apply = (patches: Record<string, string | null>[]) => {
    const next = { ...map };
    for (const patch of patches) {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
    }
    onChange(writeStyle(next));
  };
  const save = (previous: Interaction, next: Interaction) => {
    // Moving to another slot empties the old one first, so nothing of it lingers.
    const moving = slotOf(previous.trigger) !== slotOf(next.trigger);
    apply([...(moving ? [writeInteraction(map, previous.trigger, null)] : []), writeInteraction(map, next.trigger, next)]);
    if (next.trigger !== previous.trigger) setOpenTrigger(next.trigger);
  };
  const create = () => {
    const trigger = CREATE_ORDER.find((candidate) => !slotTaken(interactions, candidate));
    if (!trigger) return;
    apply([writeInteraction(map, trigger, defaultInteraction(trigger))]);
    setOpenTrigger(trigger);
    window.setTimeout(() => play(element, defaultInteraction(trigger)), 80);
  };
  const full = CREATE_ORDER.every((trigger) => slotTaken(interactions, trigger));

  return (
    <fieldset disabled={readOnly} className="dx-motion">
      {interactions.length === 0 ? (
        <div className="dx-empty">
          <div className="dx-empty-ico">{ICON.play}</div>
          <b>Animate elements with Interactions</b>
          <p>Add entrance animations and effects triggered by user interactions such as page load or scroll.</p>
          <button type="button" className="dx-btn dx-pri" onClick={create}>Create an interaction</button>
        </div>
      ) : (
        <div className="dx-pad">
          {interactions.map((interaction) => (
            <InteractionCard
              key={interaction.trigger}
              interaction={interaction}
              all={interactions}
              open={openTrigger === interaction.trigger}
              readOnly={readOnly}
              onToggle={() => setOpenTrigger(openTrigger === interaction.trigger ? null : interaction.trigger)}
              onPlay={() => play(element, interaction)}
              onRemove={() => apply([writeInteraction(map, interaction.trigger, null)])}
              onChange={(next) => save(interaction, next)}
            />
          ))}
          <button type="button" className="dx-btn dx-soft dx-full" disabled={readOnly || full} title={full ? "Every trigger already has an interaction on this element." : undefined} onClick={create}>
            + Create an interaction
          </button>
        </div>
      )}
    </fieldset>
  );
}

function InteractionCard({
  interaction,
  all,
  open,
  readOnly,
  onToggle,
  onPlay,
  onRemove,
  onChange,
}: {
  interaction: Interaction;
  all: Interaction[];
  open: boolean;
  readOnly: boolean;
  onToggle: () => void;
  onPlay: () => void;
  onRemove: () => void;
  onChange: (next: Interaction) => void;
}) {
  const [tab, setTab] = useState<"details" | "settings">("details");
  const [customFor, setCustomFor] = useState<"from" | "to" | null>(null);
  const set = (patch: Partial<Interaction>) => onChange({ ...interaction, ...patch });
  const { trigger, effect } = interaction;
  const appearing = APPEARING.includes(effect);
  const feedback = FEEDBACK.includes(effect);
  const timed = !feedback && trigger !== "scroll";
  const repeats = !feedback && (trigger === "load" || trigger === "hover" || trigger === "click");
  const known = EASINGS.some((option) => option.css === interaction.easing);
  return (
    <div className="dx-ix" data-open={open || undefined}>
      <div className="dx-ix-row">
        <button type="button" className="dx-ix-sum" aria-expanded={open} onClick={onToggle}>{summary(interaction)}</button>
        <button type="button" className="dx-ib" aria-label="Play interaction" title={trigger === "scroll" ? "Scroll the page to see it" : "Play interaction"} disabled={trigger === "scroll"} onClick={onPlay}>{ICON.play}</button>
        <button type="button" className="dx-ib" aria-label="Remove interaction" title="Remove" disabled={readOnly} onClick={onRemove}>{ICON.trash}</button>
      </div>
      {open && (
        <div className="dx-ix-ed">
          <Pick label="Interaction tabs" value={tab} options={[{ value: "details", label: "Details" }, { value: "settings", label: "Settings" }]} onChange={setTab} />
          {tab === "details" ? (
            <div className="dx-stack">
              <label className="dx-f">
                <span className="dx-fl"><span className="dx-lt">Trigger</span></span>
                <select
                  aria-label="Trigger"
                  value={trigger}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = event.target.value as Trigger;
                    const allowed = effectsFor(next).some((group) => group.effects.includes(effect));
                    onChange({ ...interaction, trigger: next, ...(allowed ? {} : { effect: next === "loop" ? "pulse" : "fade", keyframe: undefined }) });
                  }}
                >
                  {TRIGGERS.map((option) => {
                    const taken = slotTaken(all, option.value, interaction);
                    return <option key={option.value} value={option.value} disabled={Boolean(taken)}>{option.label}{taken ? " (in use)" : ""}</option>;
                  })}
                </select>
              </label>
              <p className="dx-hint">{HINT[trigger]}</p>

              <label className="dx-f">
                <span className="dx-fl"><span className="dx-lt">Effect</span></span>
                <select
                  aria-label="Effect"
                  value={interaction.keyframe && !EFFECT_LABEL[effect] ? "" : effect}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = event.target.value as Effect;
                    set({ effect: next, keyframe: undefined, direction: next === "slide" && !interaction.direction ? "bottom" : APPEARING.includes(next) && next !== "custom" ? interaction.direction : "" });
                  }}
                >
                  {effectsFor(trigger).map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.effects.map((option) => <option key={option} value={option}>{EFFECT_LABEL[option]}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {interaction.keyframe && <p className="dx-hint">This element uses an animation set elsewhere ({interaction.keyframe}). Choosing an effect replaces it.</p>}

              {effect === "custom" && (
                <div className="dx-f">
                  <span className="dx-fl"><span className="dx-lt">Custom effect</span></span>
                  <div className="dx-g2">
                    <button type="button" className="dx-btn dx-soft" aria-pressed={customFor === "from"} onClick={() => setCustomFor(customFor === "from" ? null : "from")}>Edit “From”</button>
                    <button type="button" className="dx-btn dx-soft" aria-pressed={customFor === "to"} onClick={() => setCustomFor(customFor === "to" ? null : "to")}>Edit “To”</button>
                  </div>
                  {customFor && (
                    <CustomState
                      label={customFor === "from" ? "From" : "To"}
                      state={interaction[customFor]}
                      readOnly={readOnly}
                      onChange={(next) => set({ [customFor]: next } as Partial<Interaction>)}
                    />
                  )}
                </div>
              )}

              {appearing && effect !== "custom" && trigger !== "loop" && (
                <div className="dx-f">
                  <span className="dx-fl"><span className="dx-lt">Type</span></span>
                  <Pick label="Type" value={interaction.type} options={[{ value: "in", label: "In" }, { value: "out", label: "Out" }]} onChange={(type) => set({ type })} disabled={readOnly} />
                </div>
              )}

              {(effect === "fade" || effect === "slide") && (
                <div className="dx-f">
                  <span className="dx-fl"><span className="dx-lt">Direction</span>{effect === "fade" && <span className="dx-hint">optional</span>}</span>
                  <div className="dx-btns" role="radiogroup" aria-label="Direction">
                    {DIRECTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={interaction.direction === option.value}
                        aria-label={option.label}
                        title={option.label}
                        disabled={readOnly}
                        onClick={() => set({ keyframe: undefined, direction: interaction.direction === option.value && effect === "fade" ? "" : option.value })}
                      >
                        {option.icon}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {repeats && (
                <div className="dx-f">
                  <span className="dx-fl"><span className="dx-lt">Repeat</span></span>
                  <div className="dx-g2">
                    <Pick
                      label="Repeat"
                      value={interaction.repeat === "infinite" ? "infinite" : "number"}
                      options={[{ value: "number", label: "123" }, { value: "infinite", label: "∞" }]}
                      onChange={(mode) => set({ repeat: mode === "infinite" ? "infinite" : 1 })}
                      disabled={readOnly}
                    />
                    {interaction.repeat !== "infinite" && <Num label="Times" min={1} max={99} value={interaction.repeat} onChange={(repeat) => set({ repeat: Math.max(1, Math.round(repeat)) })} disabled={readOnly} />}
                  </div>
                </div>
              )}

              {timed && (
                <div className="dx-g2">
                  <Num label="Duration" unit="ms" min={50} step={50} value={interaction.duration} onChange={(duration) => set({ duration })} disabled={readOnly} />
                  {trigger !== "loop" && <Num label="Delay" unit="ms" min={0} step={50} value={interaction.delay} onChange={(delay) => set({ delay })} disabled={readOnly} />}
                </div>
              )}

              {trigger === "scroll" && (
                <>
                  <div className="dx-g2">
                    <Num label="Start" unit="%" min={0} max={100} value={interaction.start} onChange={(start) => set({ start })} disabled={readOnly} />
                    <Num label="End" unit="%" min={0} max={100} value={interaction.end} onChange={(end) => set({ end })} disabled={readOnly} />
                  </div>
                  <div className="dx-f">
                    <span className="dx-fl"><span className="dx-lt">Relative to</span></span>
                    <Pick label="Relative to" value={interaction.relative} options={[{ value: "viewport", label: "Viewport" }, { value: "page", label: "Page" }]} onChange={(relative) => set({ relative })} disabled={readOnly} />
                  </div>
                  {effect === "parallax" && (
                    <div className="dx-sl">
                      <div className="dx-fl"><label>Strength</label><span>{interaction.strength}</span></div>
                      <input type="range" aria-label="Parallax strength" min={0} max={100} value={interaction.strength} disabled={readOnly} onChange={(event) => set({ strength: Number(event.target.value) })} />
                    </div>
                  )}
                </>
              )}

              {!feedback && trigger !== "loop" ? (
                <label className="dx-f">
                  <span className="dx-fl"><span className="dx-lt">Easing</span></span>
                  <select aria-label="Easing" value={known ? interaction.easing : "custom"} disabled={readOnly} onChange={(event) => set({ easing: event.target.value === "custom" ? interaction.easing : event.target.value })}>
                    {EASINGS.map((option) => <option key={option.label} value={option.css}>{option.label}</option>)}
                    {!known && <option value="custom">Custom curve ({interaction.easing})</option>}
                  </select>
                </label>
              ) : null}
            </div>
          ) : (
            <div className="dx-stack">
              <span className="dx-fl"><span className="dx-lt">Trigger on</span></span>
              <div className="dx-devs" role="group" aria-label="Trigger on">
                {(["desktop", "tablet", "mobile"] as const).map((device) => (
                  <button
                    key={device}
                    type="button"
                    aria-pressed={interaction.devices[device]}
                    aria-label={device === "mobile" ? "Mobile portrait" : device === "tablet" ? "Tablet portrait" : "Desktop"}
                    title={device === "mobile" ? "Phone" : device === "tablet" ? "Tablet" : "Desktop"}
                    disabled={readOnly || feedback}
                    onClick={() => set({ devices: { ...interaction.devices, [device]: !interaction.devices[device] } })}
                  >
                    {device === "desktop" ? ICON.desktop : device === "tablet" ? ICON.tablet : ICON.phone}
                    <span>{device === "mobile" ? "Phone" : device === "tablet" ? "Tablet" : "Desktop"}</span>
                  </button>
                ))}
              </div>
              <p className="dx-hint">{feedback ? "A pressed look plays on every screen." : "Switch a screen size off to keep this element still there — for example, to spare phones a heavy animation."}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const STATE_FIELDS: { key: keyof MotionState; label: string; unit: string; step: number; group: string }[] = [
  { key: "opacity", label: "Opacity", unit: "%", step: 5, group: "Opacity" },
  { key: "scaleX", label: "Scale X", unit: "", step: 0.05, group: "Scale" },
  { key: "scaleY", label: "Scale Y", unit: "", step: 0.05, group: "Scale" },
  { key: "moveX", label: "Move X", unit: "px", step: 1, group: "Move" },
  { key: "moveY", label: "Move Y", unit: "px", step: 1, group: "Move" },
  { key: "moveZ", label: "Move Z", unit: "px", step: 1, group: "Move" },
  { key: "rotateX", label: "Rotate X", unit: "°", step: 1, group: "Rotate" },
  { key: "rotateY", label: "Rotate Y", unit: "°", step: 1, group: "Rotate" },
  { key: "rotateZ", label: "Rotate Z", unit: "°", step: 1, group: "Rotate" },
  { key: "skewX", label: "Skew X", unit: "°", step: 1, group: "Skew" },
  { key: "skewY", label: "Skew Y", unit: "°", step: 1, group: "Skew" },
];

function CustomState({ label, state, readOnly, onChange }: { label: string; state: MotionState; readOnly: boolean; onChange: (next: MotionState) => void }) {
  const groups = Array.from(new Set(STATE_FIELDS.map((field) => field.group)));
  return (
    <div className="dx-panel" aria-label={`Custom effect ${label}`}>
      <div className="dx-sub">{label}</div>
      {groups.map((group) => (
        <div key={group} className="dx-g3">
          {STATE_FIELDS.filter((field) => field.group === group).map((field) => (
            <Num
              key={field.key}
              label={`${label} ${field.label}`}
              unit={field.unit}
              step={field.step}
              min={field.key === "opacity" ? 0 : undefined}
              max={field.key === "opacity" ? 100 : undefined}
              value={state[field.key]}
              onChange={(next) => onChange({ ...state, [field.key]: next })}
              disabled={readOnly}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Plays an interaction on the canvas now, whatever would normally start it.
 * An entrance or a loop restarts; hover and click are switched on for one run
 * by a preview-only attribute the page itself never carries.
 */
function play(element: HTMLElement | null, interaction: Interaction) {
  if (!element) return;
  if (FEEDBACK.includes(interaction.effect)) {
    element.setAttribute("data-dw-state-preview", "active");
    window.setTimeout(() => element.removeAttribute("data-dw-state-preview"), 450);
    return;
  }
  const length = interaction.delay + interaction.duration * (interaction.repeat === "infinite" ? 3 : interaction.repeat) + 120;
  if (interaction.trigger === "hover" || interaction.trigger === "click") {
    const slot = slotOf(interaction.trigger);
    element.removeAttribute("data-dw-play");
    void element.offsetWidth;
    element.setAttribute("data-dw-play", slot);
    window.setTimeout(() => {
      if (element.getAttribute("data-dw-play") === slot) element.removeAttribute("data-dw-play");
    }, length);
    return;
  }
  // An entrance tied to the scroll would otherwise sit wherever the scroll has
  // left it; for one run it plays on the clock.
  element.style.setProperty("animation-timeline", "auto");
  element.style.setProperty("animation", "none");
  void element.offsetWidth;
  element.style.removeProperty("animation");
  window.setTimeout(() => element.style.removeProperty("animation-timeline"), length);
}
