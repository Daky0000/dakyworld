import postcss, { type Rule } from "postcss";

/**
 * What a site's own CSS does on hover, while pressed (`:active`) and on focus,
 * as rules the editor can match against an element — the three states the
 * Style tab can set. `selector` is the rule's selector with the state taken out, so
 * `element.matches(selector)` says whether this element is the one that
 * changes — `.card:hover .title` becomes `.card .title`, which matches the
 * title, and the panel says the change belongs to hovering something around it
 * when `self` is false.
 *
 * Read from the files rather than from the editor's frame: the frame loads a
 * site's stylesheets from the site's own host, and a browser will not show a
 * page another origin's rules.
 */
export type InteractionState = "hover" | "active" | "focus";
export type HoverRule = { state: InteractionState; selector: string; hover: string; self: boolean; media?: string; declarations: Array<[string, string]> };

const MAX_RULES = 4000;
/** `:focus-visible` is what the editor's Focus means; plain `:focus` is what Elementor writes. Both are focus. */
const STATE = /(?<!\\):(hover|active|focus-visible|focus)(?![\w-])/;

export function hoverRules(sheets: Array<{ css: string }>): HoverRule[] {
  const rules: HoverRule[] = [];
  for (const sheet of sheets) {
    let root: postcss.Root;
    try { root = postcss.parse(sheet.css); } catch { continue; }
    root.walkRules((rule: Rule) => {
      if (rules.length >= MAX_RULES || !/:(hover|active|focus)/.test(rule.selector)) return;
      const declarations: Array<[string, string]> = [];
      rule.walkDecls((declaration) => { declarations.push([declaration.prop.toLowerCase(), declaration.important ? `${declaration.value} !important` : declaration.value]); });
      if (!declarations.length) return;
      const media = rule.parent?.type === "atrule" && (rule.parent as postcss.AtRule).name === "media" ? (rule.parent as postcss.AtRule).params : undefined;
      for (const part of rule.selectors) {
        const found = STATE.exec(part);
        // A pseudo-element (`:hover::after`) is not the element; nothing to edit there.
        if (!found || /::?(before|after|placeholder|marker|selection)\b/i.test(part)) continue;
        const state: InteractionState = found[1] === "hover" ? "hover" : found[1] === "active" ? "active" : "focus";
        const selector = part.replace(new RegExp(STATE.source, "g"), "").replace(/\s+/g, " ").trim();
        if (!selector) continue;
        // The element's own state when the pseudo-class sits on the last compound.
        const last = part.trim().split(/\s*[\s>+~]\s*/).pop() ?? "";
        rules.push({ state, selector, hover: part.trim(), self: STATE.test(last), ...(media ? { media } : {}), declarations });
      }
    });
  }
  return rules;
}
