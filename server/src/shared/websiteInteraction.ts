export const INTERACTION_PROPERTIES = ["color", "background-color", "border-color", "box-shadow", "opacity", "transform", "text-decoration"] as const;
export const INTERACTION_STATES = ["hover", "focus", "active"] as const;
export type InteractionState = typeof INTERACTION_STATES[number];

/** Fixed selectors and properties only. User values remain in sanitized inline styles. */
export function interactionCss(preview = false): string {
  return INTERACTION_STATES.flatMap(state => INTERACTION_PROPERTIES.map(property => {
    const variable = `--dw-${state}-${property}`;
    const base = `[style*="${variable}:"]`;
    const pseudo = state === "focus" ? ":focus-visible" : `:${state}`;
    const selector = `${base}${pseudo}${preview ? `,${base}[data-dw-state-preview="${state}"]` : ""}`;
    return `${selector}{${property}:var(${variable}) !important;}`;
  })).join("\n") + '\n@media(prefers-reduced-motion:reduce){[style*="--dw-hover-"],[style*="--dw-focus-"],[style*="--dw-active-"]{transition:none !important;}}';
}
