/**
 * The Interactions tab's model: a list of interactions read out of an
 * element's inline style, and written back into it.
 *
 * Nothing here is CSS that runs. Every interaction is a keyframe *name* and a
 * handful of numbers in `--dw-*` custom properties; the fixed rules in
 * `shared/websiteInteraction.ts` are the only thing that turns them into
 * animation, so a stored value can only ever choose one of the animations that
 * exist. That is what lets this be edited by somebody who is not a developer,
 * and why no script is ever added to a page.
 *
 * One interaction per trigger. Page load and scroll into view are both an
 * entrance and share the entrance slot: an element arrives once.
 *
 * Pure functions over a style map, so `checks/websiteMotionModel.ts` can hold
 * the round trips without a browser.
 */
import type { MotionSlot } from "../../../src/shared/websiteInteraction.js";

export type Trigger = "load" | "view" | "scroll" | "hover" | "click" | "loop";
export type Effect =
  | "fade" | "slide" | "scale" | "blur" | "flip" | "custom"
  | "pulse" | "float" | "bounce" | "shake" | "wiggle" | "spin"
  | "parallax"
  | "press" | "pop" | "flash";
export type Direction = "" | "top" | "bottom" | "left" | "right";
export type Devices = { desktop: boolean; tablet: boolean; mobile: boolean };
export type MotionState = {
  opacity: number;
  scaleX: number; scaleY: number;
  moveX: number; moveY: number; moveZ: number;
  rotateX: number; rotateY: number; rotateZ: number;
  skewX: number; skewY: number;
};

export type Interaction = {
  trigger: Trigger;
  effect: Effect;
  type: "in" | "out";
  direction: Direction;
  repeat: number | "infinite";
  /** Milliseconds. */
  duration: number;
  delay: number;
  /** A CSS timing function, or "" for the default curve. */
  easing: string;
  /** While scrolling: where in the scroll it starts and ends, and against what. */
  start: number;
  end: number;
  relative: "viewport" | "page";
  /** Parallax only: how far it travels, 0–100. */
  strength: number;
  from: MotionState;
  to: MotionState;
  devices: Devices;
  /**
   * A keyframe this panel cannot describe (written by hand, or by a later
   * version), kept exactly until somebody chooses another effect, so opening an
   * element never rewrites it.
   */
  keyframe?: string;
};

export const TRIGGERS: { value: Trigger; label: string; summary: string }[] = [
  { value: "load", label: "Page load", summary: "On page load" },
  { value: "view", label: "Scroll into view", summary: "On scroll into view" },
  { value: "scroll", label: "While scrolling", summary: "While scrolling" },
  { value: "hover", label: "On hover", summary: "On hover" },
  { value: "click", label: "On click", summary: "On click" },
  { value: "loop", label: "Continuously", summary: "Continuously" },
];

export const EFFECT_LABEL: Record<Effect, string> = {
  fade: "Fade", slide: "Slide", scale: "Scale", blur: "Blur", flip: "Flip", custom: "Custom",
  pulse: "Pulse", float: "Float", bounce: "Bounce", shake: "Shake", wiggle: "Wiggle", spin: "Spin",
  parallax: "Parallax",
  press: "Press", pop: "Pop", flash: "Flash",
};

/** Effects that arrive or leave, so In and Out and a direction mean something. */
export const APPEARING: Effect[] = ["fade", "slide", "scale", "blur", "flip", "custom"];
export const ATTENTION: Effect[] = ["pulse", "float", "bounce", "shake", "wiggle", "spin"];
/** Quick pressed looks, written as state styles rather than animation. */
export const FEEDBACK: Effect[] = ["press", "pop", "flash"];

export function effectsFor(trigger: Trigger): { label: string; effects: Effect[] }[] {
  if (trigger === "loop") return [{ label: "Attention", effects: ATTENTION }];
  if (trigger === "scroll") return [{ label: "Appear", effects: ["fade", "slide", "scale", "blur", "flip", "parallax"] }, { label: "Your own", effects: ["custom"] }];
  const groups = [{ label: "Appear", effects: ["fade", "slide", "scale", "blur", "flip"] as Effect[] }, { label: "Attention", effects: ATTENTION }, { label: "Your own", effects: ["custom"] as Effect[] }];
  return trigger === "click" ? [{ label: "Pressed look", effects: FEEDBACK }, ...groups] : groups;
}

export const EASINGS: { label: string; css: string }[] = [
  { label: "Smooth (default)", css: "" },
  { label: "Ease In", css: "ease-in" },
  { label: "Ease In Out", css: "ease-in-out" },
  { label: "Ease Out", css: "ease-out" },
  { label: "Back In", css: "cubic-bezier(.36,0,.66,-.56)" },
  { label: "Back In Out", css: "cubic-bezier(.68,-.6,.32,1.6)" },
  { label: "Back Out", css: "cubic-bezier(.34,1.56,.64,1)" },
  { label: "Linear", css: "linear" },
];

export const IDENTITY: MotionState = { opacity: 100, scaleX: 1, scaleY: 1, moveX: 0, moveY: 0, moveZ: 0, rotateX: 0, rotateY: 0, rotateZ: 0, skewX: 0, skewY: 0 };
const ALL_DEVICES: Devices = { desktop: true, tablet: true, mobile: true };

export function slotOf(trigger: Trigger): MotionSlot {
  return trigger === "load" || trigger === "view" ? "enter" : trigger === "hover" ? "onhover" : trigger === "click" ? "onclick" : trigger;
}

export function defaultInteraction(trigger: Trigger): Interaction {
  return {
    trigger,
    effect: trigger === "loop" ? "pulse" : "fade",
    type: "in",
    direction: "",
    repeat: 1,
    duration: trigger === "loop" ? 1400 : 600,
    delay: 0,
    easing: "",
    start: 0,
    end: 100,
    relative: "viewport",
    strength: 40,
    from: { ...IDENTITY, opacity: 0 },
    to: { ...IDENTITY },
    devices: { ...ALL_DEVICES },
  };
}

const FADE_FROM: Record<string, Direction> = { "dw-enter-down": "top", "dw-enter-up": "bottom", "dw-enter-right": "left", "dw-enter-left": "right" };
const FADE_TO = Object.fromEntries(Object.entries(FADE_FROM).map(([name, direction]) => [direction, name])) as Record<Exclude<Direction, "">, string>;

export function keyframeFor(effect: Effect, direction: Direction, slot: MotionSlot): string {
  switch (effect) {
    case "fade": return direction ? FADE_TO[direction] : "dw-enter-fade";
    case "slide": return `dw-fx-slide-${direction || "bottom"}`;
    case "scale": return "dw-enter-zoom";
    case "blur": return "dw-enter-blur";
    case "flip": return "dw-enter-flip";
    case "custom": return `dw-fx-custom-${slot}`;
    case "parallax": return "dw-scroll-parallax";
    default: return `dw-loop-${effect}`;
  }
}

function effectOf(name: string): { effect: Effect; direction: Direction } | null {
  if (name === "dw-enter-fade" || name === "dw-scroll-fade") return { effect: "fade", direction: "" };
  if (FADE_FROM[name]) return { effect: "fade", direction: FADE_FROM[name]! };
  const slide = /^dw-fx-slide-(top|bottom|left|right)$/.exec(name);
  if (slide) return { effect: "slide", direction: slide[1] as Direction };
  if (name === "dw-enter-zoom") return { effect: "scale", direction: "" };
  if (name === "dw-enter-blur") return { effect: "blur", direction: "" };
  if (name === "dw-enter-flip") return { effect: "flip", direction: "" };
  if (/^dw-fx-custom-/.test(name)) return { effect: "custom", direction: "" };
  if (name === "dw-scroll-parallax") return { effect: "parallax", direction: "" };
  const loop = /^dw-loop-(pulse|float|bounce|shake|wiggle|spin)$/.exec(name);
  if (loop) return { effect: loop[1] as Effect, direction: "" };
  return null;
}

/** "0.6s", "600ms", "1.4s" → milliseconds. */
export function toMs(value: string | undefined, fallback: number): number {
  const match = /^(-?\d*\.?\d+)\s*(ms|s)?$/.exec((value ?? "").trim());
  if (!match) return fallback;
  const number = Number(match[1]);
  return Math.round(match[2] === "ms" ? number : number * 1000);
}

const NUMBER = (value: number) => String(Math.round(value * 1000) / 1000);

/** One state of a custom effect, as the transform it becomes: the same function list both ends, so each one interpolates on its own. */
export function stateTransform(state: MotionState): string {
  return `translate3d(${NUMBER(state.moveX)}px,${NUMBER(state.moveY)}px,${NUMBER(state.moveZ)}px) rotateX(${NUMBER(state.rotateX)}deg) rotateY(${NUMBER(state.rotateY)}deg) rotateZ(${NUMBER(state.rotateZ)}deg) skew(${NUMBER(state.skewX)}deg,${NUMBER(state.skewY)}deg) scale(${NUMBER(state.scaleX)},${NUMBER(state.scaleY)})`;
}

export function readState(transform: string | undefined, opacity: string | undefined, fallback: MotionState): MotionState {
  const state = { ...fallback };
  const number = (pattern: RegExp, index = 1) => {
    const match = pattern.exec(transform ?? "");
    return match ? Number(match[index]) : null;
  };
  if (transform) {
    const move = /translate3d\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(transform);
    if (move) Object.assign(state, { moveX: Number(move[1]), moveY: Number(move[2]), moveZ: Number(move[3]) });
    state.rotateX = number(/rotateX\(\s*(-?[\d.]+)deg/) ?? state.rotateX;
    state.rotateY = number(/rotateY\(\s*(-?[\d.]+)deg/) ?? state.rotateY;
    state.rotateZ = number(/rotateZ\(\s*(-?[\d.]+)deg/) ?? state.rotateZ;
    const skew = /skew\(\s*(-?[\d.]+)deg\s*,\s*(-?[\d.]+)deg\s*\)/.exec(transform);
    if (skew) Object.assign(state, { skewX: Number(skew[1]), skewY: Number(skew[2]) });
    const scale = /scale\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(transform);
    if (scale) Object.assign(state, { scaleX: Number(scale[1]), scaleY: Number(scale[2]) });
  }
  if (opacity !== undefined && opacity.trim() !== "" && Number.isFinite(Number(opacity))) state.opacity = Math.round(Number(opacity) * 100);
  return state;
}

const devicesOf = (map: Record<string, string>, slot: string): Devices => ({
  desktop: !map[`--dw-${slot}-no-d`],
  tablet: !map[`--dw-${slot}-no-t`],
  mobile: !map[`--dw-${slot}-no-m`],
});

/** Every interaction the element carries, in trigger order. */
export function readInteractions(map: Record<string, string>): Interaction[] {
  const found: Interaction[] = [];
  const animated = (trigger: Trigger, slot: MotionSlot): Interaction | null => {
    const name = map[`--dw-${slot}`];
    if (!name) return null;
    const base = defaultInteraction(trigger);
    const known = effectOf(name.trim());
    const count = map[`--dw-${slot}-count`];
    const interaction: Interaction = {
      ...base,
      effect: known?.effect ?? "fade",
      direction: known?.direction ?? "",
      type: map[`--dw-${slot}-dir`] === "reverse" ? "out" : "in",
      repeat: count === "infinite" ? "infinite" : count && Number.isFinite(Number(count)) ? Math.max(1, Math.round(Number(count))) : 1,
      duration: toMs(map[`--dw-${slot}-dur`], base.duration),
      delay: toMs(map[`--dw-${slot}-delay`], 0),
      easing: map[`--dw-${slot}-ease`] ?? "",
      from: readState(map[`--dw-${slot}-t0`], map[`--dw-${slot}-o0`], base.from),
      to: readState(map[`--dw-${slot}-t1`], map[`--dw-${slot}-o1`], base.to),
      devices: devicesOf(map, slot),
    };
    // Kept only when this panel would not write the same name back.
    if (!known || keyframeFor(interaction.effect, interaction.direction, slot) !== name.trim()) interaction.keyframe = name.trim();
    return interaction;
  };

  const enter = animated(map["--dw-enter-start"] ? "load" : "view", "enter");
  if (enter) found.push(enter);

  const scroll = animated("scroll", "scroll");
  if (scroll) {
    const range = map["--dw-scroll-range"] ?? "";
    const viewport = /cover\s+(-?[\d.]+)%\s+cover\s+(-?[\d.]+)%/.exec(range);
    const page = /^\s*(-?[\d.]+)%\s+(-?[\d.]+)%\s*$/.exec(range);
    const numbers = viewport ?? page;
    scroll.relative = /scroll\(/.test(map["--dw-scroll-tl"] ?? "") ? "page" : "viewport";
    if (numbers) { scroll.start = Number(numbers[1]); scroll.end = Number(numbers[2]); }
    scroll.strength = Number(map["--dw-scroll-strength"] ?? 40) || 40;
    found.push(scroll);
  }

  const hover = animated("hover", "onhover");
  if (hover) found.push(hover);

  const click = animated("click", "onclick");
  if (click) found.push(click);
  else {
    // The pressed looks predate the layers: state styles, not animation.
    const transform = map["--dw-active-transform"];
    const opacity = map["--dw-active-opacity"];
    const feedback: Effect | null = transform === "scale(.94)" ? "press" : transform === "scale(1.08)" ? "pop" : opacity ? "flash" : null;
    if (feedback) found.push({ ...defaultInteraction("click"), effect: feedback });
  }

  const loop = animated("loop", "loop");
  if (loop) found.push(loop);
  return found;
}

const SLOT_KEYS = ["", "-dur", "-delay", "-ease", "-count", "-dir", "-o0", "-o1", "-t0", "-t1", "-no-d", "-no-t", "-no-m"];
const EXTRA_KEYS: Partial<Record<MotionSlot, string[]>> = { enter: ["-start"], scroll: ["-tl", "-range", "-strength"] };
const LEGACY_TRANSITION = "transform 150ms, opacity 150ms";

/** Every property an interaction in this slot may have written, so replacing one leaves nothing behind. */
function slotKeys(slot: MotionSlot): string[] {
  return [...SLOT_KEYS, ...(EXTRA_KEYS[slot] ?? [])].map((suffix) => `--dw-${slot}${suffix}`);
}

/**
 * The style patch that writes `interaction` into its slot, or empties the slot
 * of `trigger` when it is null. `null` values in the patch mean "remove".
 *
 * Defaults are left out — 600 ms, no delay, the smooth curve, once, In, every
 * device — so a simple entrance stays one declaration on the page.
 */
export function writeInteraction(map: Record<string, string>, trigger: Trigger, interaction: Interaction | null): Record<string, string | null> {
  const slot = slotOf(trigger);
  const patch: Record<string, string | null> = Object.fromEntries(slotKeys(slot).map((key) => [key, null]));
  if (slot === "onclick") {
    patch["--dw-active-transform"] = null;
    patch["--dw-active-opacity"] = null;
    if (map.transition === LEGACY_TRANSITION) patch.transition = null;
  }
  if (!interaction) return patch;

  if (interaction.trigger === "click" && FEEDBACK.includes(interaction.effect)) {
    patch["--dw-active-transform"] = interaction.effect === "press" ? "scale(.94)" : interaction.effect === "pop" ? "scale(1.08)" : null;
    patch["--dw-active-opacity"] = interaction.effect === "flash" ? "0.5" : null;
    patch.transition = map.transition && map.transition !== LEGACY_TRANSITION ? map.transition : LEGACY_TRANSITION;
    return patch;
  }

  const name = interaction.keyframe ?? keyframeFor(interaction.effect, interaction.direction, slot);
  patch[`--dw-${slot}`] = name;
  const appearing = APPEARING.includes(interaction.effect) || interaction.effect === "parallax";
  if (slot === "enter" && interaction.trigger === "load") patch["--dw-enter-start"] = "load";
  if (slot === "loop") {
    if (interaction.duration !== 1400) patch["--dw-loop-dur"] = `${Math.max(100, Math.round(interaction.duration))}ms`;
  } else {
    if (interaction.duration !== 600 && slot !== "scroll") patch[`--dw-${slot}-dur`] = `${Math.max(50, Math.round(interaction.duration))}ms`;
    if (interaction.delay > 0 && slot !== "scroll") patch[`--dw-${slot}-delay`] = `${Math.round(interaction.delay)}ms`;
    if (interaction.easing) patch[`--dw-${slot}-ease`] = interaction.easing;
    if (appearing && interaction.type === "out" && interaction.effect !== "parallax") patch[`--dw-${slot}-dir`] = "reverse";
    // Repeating means nothing to a scrubbed animation: scroll into view and
    // while scrolling play as far as the page has been scrolled.
    if ((slot !== "scroll" && slot !== "enter") || interaction.trigger === "load") {
      if (interaction.repeat === "infinite") patch[`--dw-${slot}-count`] = "infinite";
      else if (interaction.repeat > 1) patch[`--dw-${slot}-count`] = String(Math.round(interaction.repeat));
    }
  }
  if (interaction.effect === "custom" && slot !== "loop") {
    patch[`--dw-${slot}-o0`] = NUMBER(interaction.from.opacity / 100);
    patch[`--dw-${slot}-o1`] = NUMBER(interaction.to.opacity / 100);
    patch[`--dw-${slot}-t0`] = stateTransform(interaction.from);
    patch[`--dw-${slot}-t1`] = stateTransform(interaction.to);
  }
  if (slot === "scroll") {
    const start = Math.max(0, Math.min(100, Math.round(interaction.start)));
    const end = Math.max(0, Math.min(100, Math.round(interaction.end)));
    if (interaction.relative === "page") {
      patch["--dw-scroll-tl"] = "scroll(root)";
      patch["--dw-scroll-range"] = `${start}% ${end}%`;
    } else if (start !== 0 || end !== 100) {
      patch["--dw-scroll-range"] = `cover ${start}% cover ${end}%`;
    }
    if (interaction.effect === "parallax") patch["--dw-scroll-strength"] = String(Math.round(interaction.strength));
  }
  if (!interaction.devices.desktop) patch[`--dw-${slot}-no-d`] = "1";
  if (!interaction.devices.tablet) patch[`--dw-${slot}-no-t`] = "1";
  if (!interaction.devices.mobile) patch[`--dw-${slot}-no-m`] = "1";
  return patch;
}

export function summary(interaction: Interaction): string {
  const trigger = TRIGGERS.find((option) => option.value === interaction.trigger)?.summary ?? "";
  const effect = interaction.keyframe && !effectOf(interaction.keyframe) ? interaction.keyframe : EFFECT_LABEL[interaction.effect];
  const appearing = APPEARING.includes(interaction.effect);
  return `${trigger}: ${effect}${appearing ? ` ${interaction.type === "in" ? "In" : "Out"}` : ""}`;
}

/** Which slot a trigger would take, and which interaction already holds it, if any. */
export function slotTaken(interactions: Interaction[], trigger: Trigger, except?: Interaction): Interaction | undefined {
  const slot = slotOf(trigger);
  return interactions.find((interaction) => interaction !== except && slotOf(interaction.trigger) === slot);
}
