import postcss, { type Rule } from "postcss";

/**
 * What a site's own CSS does on hover, as rules the editor can match against an
 * element. `selector` is the rule's selector with `:hover` taken out, so
 * `element.matches(selector)` says whether this element is the one that
 * changes — `.card:hover .title` becomes `.card .title`, which matches the
 * title, and the panel says the change belongs to hovering something around it
 * when `self` is false.
 *
 * Read from the files rather than from the editor's frame: the frame loads a
 * site's stylesheets from the site's own host, and a browser will not show a
 * page another origin's rules.
 */
export type HoverRule = { selector: string; hover: string; self: boolean; media?: string; declarations: Array<[string, string]> };

const MAX_RULES = 4000;

export function hoverRules(sheets: Array<{ css: string }>): HoverRule[] {
  const rules: HoverRule[] = [];
  for (const sheet of sheets) {
    let root: postcss.Root;
    try { root = postcss.parse(sheet.css); } catch { continue; }
    root.walkRules((rule: Rule) => {
      if (rules.length >= MAX_RULES || !rule.selector.includes(":hover")) return;
      const declarations: Array<[string, string]> = [];
      rule.walkDecls((declaration) => { declarations.push([declaration.prop.toLowerCase(), declaration.important ? `${declaration.value} !important` : declaration.value]); });
      if (!declarations.length) return;
      const media = rule.parent?.type === "atrule" && (rule.parent as postcss.AtRule).name === "media" ? (rule.parent as postcss.AtRule).params : undefined;
      for (const part of rule.selectors) {
        // A pseudo-element (`:hover::after`) is not the element; nothing to edit there.
        if (!/(?<!\\):hover\b/.test(part) || /::?(before|after|placeholder|marker|selection)\b/i.test(part)) continue;
        const selector = part.replace(/(?<!\\):hover\b/g, "").replace(/\s+/g, " ").trim();
        if (!selector) continue;
        // Hovering the element itself when `:hover` sits on the last compound.
        const last = part.trim().split(/\s*[\s>+~]\s*/).pop() ?? "";
        rules.push({ selector, hover: part.trim(), self: /(?<!\\):hover\b/.test(last), ...(media ? { media } : {}), declarations });
      }
    });
  }
  return rules;
}
