export const INTERACTION_PROPERTIES = ["color", "background-color", "border-color", "box-shadow", "opacity", "transform", "text-decoration"] as const;
export const INTERACTION_STATES = ["hover", "focus", "active"] as const;
export type InteractionState = typeof INTERACTION_STATES[number];

/** Fixed selectors and properties only. User values remain in sanitized inline styles. */
export function interactionCss(preview = false): string {
  return stateCss(preview) + "\n" + MOTION_CSS;
}

/**
 * Motion is chosen by name, never written as CSS. The inspector stores a
 * keyframe name in a custom property (`--dw-enter: dw-enter-up`) and these
 * fixed rules turn it into an animation, so a stored value can only ever pick
 * one of the animations below. Scroll-linked motion uses CSS view timelines;
 * a browser without them plays the entrance once on load instead. Everything
 * stops for somebody who has asked for reduced motion.
 */
export const ENTRANCES = ["fade", "up", "down", "left", "right", "zoom", "blur", "flip"] as const;
export const LOOPS = ["pulse", "float", "bounce", "shake", "wiggle", "spin"] as const;
export const SCROLLS = ["fade", "parallax"] as const;
export const MOTION_PROPERTY = /--dw-(?:enter|loop|scroll)/;

export const MOTION_CSS = [
  "@keyframes dw-enter-fade{from{opacity:0}}",
  "@keyframes dw-enter-up{from{opacity:0;transform:translateY(40px)}}",
  "@keyframes dw-enter-down{from{opacity:0;transform:translateY(-40px)}}",
  "@keyframes dw-enter-left{from{opacity:0;transform:translateX(60px)}}",
  "@keyframes dw-enter-right{from{opacity:0;transform:translateX(-60px)}}",
  "@keyframes dw-enter-zoom{from{opacity:0;transform:scale(.7)}}",
  "@keyframes dw-enter-blur{from{opacity:0;filter:blur(12px)}}",
  "@keyframes dw-enter-flip{from{opacity:0;transform:perspective(600px) rotateX(70deg)}}",
  "@keyframes dw-loop-pulse{50%{transform:scale(1.06)}}",
  "@keyframes dw-loop-float{50%{transform:translateY(-8px)}}",
  "@keyframes dw-loop-bounce{25%{transform:translateY(-14px)}50%{transform:none}75%{transform:translateY(-5px)}}",
  "@keyframes dw-loop-shake{25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}",
  "@keyframes dw-loop-wiggle{25%{transform:rotate(-4deg)}75%{transform:rotate(4deg)}}",
  "@keyframes dw-loop-spin{to{transform:rotate(360deg)}}",
  "@keyframes dw-scroll-fade{from{opacity:.15}to{opacity:1}}",
  "@keyframes dw-scroll-parallax{from{transform:translateY(calc(var(--dw-scroll-strength,40) * 1px))}to{transform:translateY(calc(var(--dw-scroll-strength,40) * -1px))}}",
  '[style*="--dw-enter"]{animation:var(--dw-enter) var(--dw-enter-dur,.6s) var(--dw-enter-ease,cubic-bezier(.22,1,.36,1)) var(--dw-enter-delay,0s) both}',
  '[style*="--dw-loop"]{animation:var(--dw-loop) var(--dw-loop-dur,1.4s) ease-in-out infinite}',
  '[style*="--dw-enter"][style*="--dw-loop"]{animation:var(--dw-enter) var(--dw-enter-dur,.6s) var(--dw-enter-ease,ease) var(--dw-enter-delay,0s) both,var(--dw-loop) var(--dw-loop-dur,1.4s) ease-in-out calc(var(--dw-enter-dur,.6s) + var(--dw-enter-delay,0s)) infinite}',
  '@supports (animation-timeline:view()){[style*="--dw-enter"]:not([style*="--dw-loop"]):not([style*="--dw-enter-start"]){animation-timeline:view();animation-range:entry 0% entry 70%}[style*="--dw-scroll"]{animation:var(--dw-scroll) linear both;animation-timeline:view()}}',
  '@media(prefers-reduced-motion:reduce){[style*="--dw-enter"],[style*="--dw-loop"],[style*="--dw-scroll"]{animation:none !important}}',
].join("\n");

function stateCss(preview: boolean): string {
  return INTERACTION_STATES.flatMap(state => INTERACTION_PROPERTIES.map(property => {
    const variable = `--dw-${state}-${property}`;
    const base = `[style*="${variable}:"]`;
    const pseudo = state === "focus" ? ":focus-visible" : `:${state}`;
    const selector = `${base}${pseudo}${preview ? `,${base}[data-dw-state-preview="${state}"]` : ""}`;
    return `${selector}{${property}:var(${variable}) !important;}`;
  })).join("\n") + '\n@media(prefers-reduced-motion:reduce){[style*="--dw-hover-"],[style*="--dw-focus-"],[style*="--dw-active-"]{transition:none !important;}}';
}
