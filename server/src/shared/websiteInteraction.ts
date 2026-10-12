export const INTERACTION_PROPERTIES = ["color", "background-color", "border-color", "box-shadow", "opacity", "transform", "text-decoration"] as const;
export const INTERACTION_STATES = ["hover", "focus", "active"] as const;
export type InteractionState = typeof INTERACTION_STATES[number];

/** Fixed selectors and properties only. User values remain in sanitized inline styles. */
export function interactionCss(preview = false): string {
  return stateCss(preview) + "\n" + motionCss(preview);
}

/**
 * Motion is chosen by name, never written as CSS. The inspector stores a
 * keyframe name in a custom property (`--dw-enter: dw-enter-up`) and these
 * fixed rules turn it into an animation, so a stored value can only ever pick
 * one of the animations below. Scroll-linked motion uses CSS view timelines;
 * a browser without them plays the entrance once on load instead. Everything
 * stops for somebody who has asked for reduced motion.
 *
 * Five slots, one interaction each, named for when they play:
 *
 * - `enter`   page load (`--dw-enter-start: load`) or scroll into view;
 * - `loop`    continuously, starting once the entrance has finished;
 * - `scroll`  scrubbed by scrolling (`--dw-scroll-tl`, `--dw-scroll-range`);
 * - `onhover` while the pointer is over the element;
 * - `onclick` while it is pressed, and on links and buttons until focus moves.
 *
 * They are layers of one `animation-*` list rather than five rules, because an
 * element may carry several and the cascade would otherwise let one rule's
 * `animation` erase another's. Hover and click only switch a `-live` property
 * on, so starting one never restarts the others: an animation whose name stays
 * in the list carries on where it was.
 *
 * The names `--dw-enter`, `--dw-loop` and `--dw-scroll` predate the layers and
 * are on published pages; every value they could hold still animates the same.
 */
export const ENTRANCES = ["fade", "up", "down", "left", "right", "zoom", "blur", "flip"] as const;
export const LOOPS = ["pulse", "float", "bounce", "shake", "wiggle", "spin"] as const;
export const SCROLLS = ["fade", "parallax"] as const;
export const MOTION_SLOTS = ["enter", "loop", "scroll", "onhover", "onclick"] as const;
export type MotionSlot = typeof MOTION_SLOTS[number];
export const MOTION_PROPERTY = /--dw-(?:enter|loop|scroll|onhover|onclick)/;
/** Anything in a style attribute that needs the interaction rules on the page. */
export const USES_INTERACTION_CSS = /--dw-(?:hover-|focus-|active-|enter|loop|scroll|onhover|onclick)/;

/** The widths the device switches mean, matching `RESPONSIVE_BREAKPOINTS`. */
const DEVICE_MEDIA = {
  d: "(min-width:1025px)",
  t: "(min-width:641px) and (max-width:1024px)",
  m: "(max-width:640px)",
} as const;

const KEYFRAMES = [
  "@keyframes dw-enter-fade{from{opacity:0}}",
  "@keyframes dw-enter-up{from{opacity:0;transform:translateY(40px)}}",
  "@keyframes dw-enter-down{from{opacity:0;transform:translateY(-40px)}}",
  "@keyframes dw-enter-left{from{opacity:0;transform:translateX(60px)}}",
  "@keyframes dw-enter-right{from{opacity:0;transform:translateX(-60px)}}",
  "@keyframes dw-enter-zoom{from{opacity:0;transform:scale(.7)}}",
  "@keyframes dw-enter-blur{from{opacity:0;filter:blur(12px)}}",
  "@keyframes dw-enter-flip{from{opacity:0;transform:perspective(600px) rotateX(70deg)}}",
  "@keyframes dw-fx-slide-top{from{transform:translateY(-100%)}}",
  "@keyframes dw-fx-slide-bottom{from{transform:translateY(100%)}}",
  "@keyframes dw-fx-slide-left{from{transform:translateX(-100%)}}",
  "@keyframes dw-fx-slide-right{from{transform:translateX(100%)}}",
  "@keyframes dw-loop-pulse{50%{transform:scale(1.06)}}",
  "@keyframes dw-loop-float{50%{transform:translateY(-8px)}}",
  "@keyframes dw-loop-bounce{25%{transform:translateY(-14px)}50%{transform:none}75%{transform:translateY(-5px)}}",
  "@keyframes dw-loop-shake{25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}",
  "@keyframes dw-loop-wiggle{25%{transform:rotate(-4deg)}75%{transform:rotate(4deg)}}",
  "@keyframes dw-loop-spin{to{transform:rotate(360deg)}}",
  "@keyframes dw-scroll-fade{from{opacity:.15}to{opacity:1}}",
  "@keyframes dw-scroll-parallax{from{transform:translateY(calc(var(--dw-scroll-strength,40) * 1px))}to{transform:translateY(calc(var(--dw-scroll-strength,40) * -1px))}}",
  // A custom effect is still one of these: the keyframes are fixed and only the
  // two states are numbers the element carries. One per slot, because the
  // numbers belong to the slot.
  ...(["enter", "scroll", "onhover", "onclick"] as const).map(
    (slot) => `@keyframes dw-fx-custom-${slot}{from{opacity:var(--dw-${slot}-o0,1);transform:var(--dw-${slot}-t0,none)}to{opacity:var(--dw-${slot}-o1,1);transform:var(--dw-${slot}-t1,none)}}`,
  ),
];

const EASE = "cubic-bezier(.22,1,.36,1)";

function layers(scrollDuration: string): string {
  return [
    "animation-name:var(--dw-enter,none),var(--dw-loop,none),var(--dw-scroll-live,none),var(--dw-onhover-live,none),var(--dw-onclick-live,none)",
    `animation-duration:var(--dw-enter-dur,.6s),var(--dw-loop-dur,1.4s),${scrollDuration},var(--dw-onhover-dur,.6s),var(--dw-onclick-dur,.6s)`,
    `animation-timing-function:var(--dw-enter-ease,${EASE}),ease-in-out,var(--dw-scroll-ease,linear),var(--dw-onhover-ease,${EASE}),var(--dw-onclick-ease,${EASE})`,
    "animation-delay:var(--dw-enter-delay,0s),var(--dw-loop-wait,0s),0s,var(--dw-onhover-delay,0s),var(--dw-onclick-delay,0s)",
    "animation-iteration-count:var(--dw-enter-count,1),infinite,1,var(--dw-onhover-count,1),var(--dw-onclick-count,1)",
    "animation-direction:var(--dw-enter-dir,normal),normal,var(--dw-scroll-dir,normal),var(--dw-onhover-dir,normal),var(--dw-onclick-dir,normal)",
    "animation-fill-mode:both,none,both,both,both",
  ].join(";");
}

/**
 * The rules, with the editor's extra selectors when `preview` is set: the
 * Play button marks the element `data-dw-play="onhover"` (or `onclick`) so an
 * interaction can be watched without the pointer on it.
 */
export function motionCss(preview = false): string {
  // An element that animates at rest, and one that only does while it is
  // hovered or pressed. They are kept apart because the second kind must be
  // left exactly as the site made it the rest of the time: a spinner the site
  // animates itself keeps spinning until the pointer arrives.
  const atRest = '[style*="--dw-enter"],[style*="--dw-loop"],[style*="--dw-scroll"]';
  const onState = `[style*="--dw-onhover"]:hover,[style*="--dw-onclick"]:active,[style*="--dw-onclick"]:focus${preview ? ',[style*="--dw-onhover"][data-dw-play="onhover"],[style*="--dw-onclick"][data-dw-play="onclick"]' : ""}`;
  const switches =
    `[style*="--dw-onhover"]:hover${preview ? ',[data-dw-play="onhover"]' : ""}{--dw-onhover-live:var(--dw-onhover)}` +
    `[style*="--dw-onclick"]:active,[style*="--dw-onclick"]:focus${preview ? ',[data-dw-play="onclick"]' : ""}{--dw-onclick-live:var(--dw-onclick)}`;
  const timelines = "animation-timeline:var(--dw-enter-tl,auto),auto,var(--dw-scroll-tl,view()),auto,auto;animation-range:var(--dw-enter-range,normal),normal,var(--dw-scroll-range,normal),normal,normal";
  // Somebody who has asked for reduced motion gets no hover or click layer at
  // all — not `animation: none` on those elements, which would also stop
  // whatever the site itself animates on them.
  const calm = "@media(prefers-reduced-motion:no-preference)";
  const flags = (Object.keys(DEVICE_MEDIA) as (keyof typeof DEVICE_MEDIA)[]).map(
    (device) => `@media${DEVICE_MEDIA[device]}{${MOTION_SLOTS.map((slot) => `[style*="--dw-${slot}-no-${device}"]{--dw-${slot}:none !important}`).join("")}}`,
  );
  return [
    ...KEYFRAMES,
    `${atRest}{${layers("1s")}}`,
    '[style*="--dw-enter"][style*="--dw-loop"]{--dw-loop-wait:calc(var(--dw-enter-dur,.6s) + var(--dw-enter-delay,0s))}',
    `${calm}{${onState}{${layers("1s")}}${switches}}`,
    "@supports (animation-timeline:view()){" +
      '[style*="--dw-scroll"]{--dw-scroll-live:var(--dw-scroll)}' +
      `${atRest}{${layers("auto")};${timelines}}` +
      `${calm}{${onState}{${layers("auto")};${timelines}}}` +
      '[style*="--dw-enter"]:not([style*="--dw-enter-start"]){--dw-enter-tl:view();--dw-enter-range:entry 0% entry 70%}' +
      "}",
    ...flags,
    `@media(prefers-reduced-motion:reduce){${atRest}{animation:none !important}}`,
  ].join("\n");
}

/** The published rules. Kept as a constant for callers that read it whole. */
export const MOTION_CSS = motionCss();

function stateCss(preview: boolean): string {
  return INTERACTION_STATES.flatMap(state => INTERACTION_PROPERTIES.map(property => {
    const variable = `--dw-${state}-${property}`;
    const base = `[style*="${variable}:"]`;
    const pseudo = state === "focus" ? ":focus-visible" : `:${state}`;
    const selector = `${base}${pseudo}${preview ? `,${base}[data-dw-state-preview="${state}"]` : ""}`;
    return `${selector}{${property}:var(${variable}) !important;}`;
  })).join("\n") + '\n@media(prefers-reduced-motion:reduce){[style*="--dw-hover-"],[style*="--dw-focus-"],[style*="--dw-active-"]{transition:none !important;}}';
}
