/**
 * The Builder agent's animations: what the Interactions tab writes, chosen by
 * name.
 *
 * The tab stores a keyframe name and a few numbers in `--dw-*` custom
 * properties, and the fixed rules in `shared/websiteInteraction.ts` are the
 * only thing that turns them into motion. The agent writes the very same
 * properties, with the tab's defaults (600 ms, once, the smooth curve, every
 * screen size), so an element the agent animated opens in the tab looking as
 * if somebody had picked it there — and can be changed there.
 *
 * This mirrors `writeInteraction` in `client/src/lib/websiteMotion.ts` for a
 * default interaction. `checks/websiteAgentMotion.ts` compares the two for
 * every trigger and effect, so they cannot drift apart unnoticed.
 */

export const MOTION_TRIGGERS = ["load", "view", "scroll", "loop", "hover", "click"] as const;
export type MotionTrigger = typeof MOTION_TRIGGERS[number];

export const MOTION_EFFECTS = [
  "fade", "fade-from-bottom", "fade-from-top", "fade-from-left", "fade-from-right",
  "slide-from-bottom", "slide-from-top", "slide-from-left", "slide-from-right",
  "scale", "blur", "flip",
  "pulse", "float", "bounce", "shake", "wiggle", "spin",
  "parallax",
  "press", "pop", "flash",
  "none",
] as const;
export type MotionEffect = typeof MOTION_EFFECTS[number];

type Slot = "enter" | "loop" | "scroll" | "onhover" | "onclick";
type Direction = "" | "top" | "bottom" | "left" | "right";

const SLOT: Record<MotionTrigger, Slot> = { load: "enter", view: "enter", scroll: "scroll", loop: "loop", hover: "onhover", click: "onclick" };
const SLOT_KEYS = ["", "-dur", "-delay", "-ease", "-count", "-dir", "-o0", "-o1", "-t0", "-t1", "-no-d", "-no-t", "-no-m"];
const EXTRA_KEYS: Partial<Record<Slot, string[]>> = { enter: ["-start"], scroll: ["-tl", "-range", "-strength"] };
const LEGACY_TRANSITION = "transform 150ms, opacity 150ms";

const APPEAR = ["fade", "slide", "scale", "blur", "flip"];
const ATTENTION = ["pulse", "float", "bounce", "shake", "wiggle", "spin"];
const FEEDBACK = ["press", "pop", "flash"];

/** What each trigger offers, as the tab's `effectsFor` does. */
const OFFERED: Record<MotionTrigger, string[]> = {
  load: [...APPEAR, ...ATTENTION],
  view: [...APPEAR, ...ATTENTION],
  hover: [...APPEAR, ...ATTENTION],
  click: [...FEEDBACK, ...APPEAR, ...ATTENTION],
  loop: ATTENTION,
  scroll: [...APPEAR, "parallax"],
};

const TRIGGER_WORDS: Record<MotionTrigger, string> = {
  load: "as the page loads",
  view: "as it scrolls into view",
  scroll: "while the page scrolls",
  loop: "continuously",
  hover: "while the pointer is over it",
  click: "when it is clicked",
};

const FADE_TO: Record<Exclude<Direction, "">, string> = { top: "dw-enter-down", bottom: "dw-enter-up", left: "dw-enter-right", right: "dw-enter-left" };

function parse(effect: MotionEffect): { effect: string; direction: Direction } {
  const directed = /^(fade|slide)-from-(top|bottom|left|right)$/.exec(effect);
  if (directed) return { effect: directed[1]!, direction: directed[2] as Direction };
  return { effect, direction: "" };
}

function keyframe(effect: string, direction: Direction, slot: Slot): string {
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

/** "Fades in from below as it scrolls into view." */
export function describeMotion(trigger: MotionTrigger, effect: MotionEffect): string {
  if (effect === "none") return `No animation ${TRIGGER_WORDS[trigger]}`;
  const { effect: base, direction } = parse(effect);
  const from = direction ? ` from the ${direction}` : "";
  const verb: Record<string, string> = {
    fade: `Fades in${from}`, slide: `Slides in${from}`, scale: "Grows in", blur: "Comes into focus", flip: "Flips in",
    pulse: "Pulses", float: "Floats", bounce: "Bounces", shake: "Shakes", wiggle: "Wiggles", spin: "Spins",
    parallax: "Moves at its own pace (parallax)", press: "Presses in", pop: "Pops out", flash: "Flashes",
  };
  return `${verb[base] ?? base} ${TRIGGER_WORDS[trigger]}`;
}

/**
 * The style patch that gives an element this animation, or takes the
 * trigger's animation away (`none`). `null` in the patch means "remove this
 * property". A combination the tab does not offer — a loop that slides, a
 * pressed look on scroll — is refused with a sentence rather than written.
 */
export function motionPatch(current: Record<string, string>, trigger: MotionTrigger, effect: MotionEffect): { patch: Record<string, string | null> } | { refused: string } {
  const slot = SLOT[trigger];
  const patch: Record<string, string | null> = Object.fromEntries(
    [...SLOT_KEYS, ...(EXTRA_KEYS[slot] ?? [])].map((suffix) => [`--dw-${slot}${suffix}`, null]),
  );
  if (slot === "onclick") {
    patch["--dw-active-transform"] = null;
    patch["--dw-active-opacity"] = null;
    if (current.transition === LEGACY_TRANSITION) patch.transition = null;
  }
  if (effect === "none") return { patch };

  const { effect: base, direction } = parse(effect);
  if (!OFFERED[trigger].includes(base)) {
    return { refused: `a ${base} animation cannot play ${TRIGGER_WORDS[trigger]}` };
  }
  if (trigger === "click" && FEEDBACK.includes(base)) {
    patch["--dw-active-transform"] = base === "press" ? "scale(.94)" : base === "pop" ? "scale(1.08)" : null;
    patch["--dw-active-opacity"] = base === "flash" ? "0.5" : null;
    patch.transition = current.transition && current.transition !== LEGACY_TRANSITION ? current.transition : LEGACY_TRANSITION;
    return { patch };
  }
  patch[`--dw-${slot}`] = keyframe(base, direction, slot);
  if (slot === "enter" && trigger === "load") patch["--dw-enter-start"] = "load";
  if (slot === "scroll" && base === "parallax") patch["--dw-scroll-strength"] = "40";
  return { patch };
}
