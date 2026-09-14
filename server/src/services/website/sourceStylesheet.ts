/**
 * The one file in a customer's repository this editor writes CSS into.
 *
 * Everything else the source editor does is a change to the page being edited.
 * Media rules cannot be: `@media (max-width: 640px){…}` has to be in a
 * stylesheet the site already loads, and a framework page has no `<head>` of
 * ours to put a `<style>` in. So one stylesheet gains one region per page,
 * fenced by comments, regenerated from the page's own attributes every publish:
 *
 *     \/* dakyworld-editor:start app/page.tsx *\/
 *     @media (max-width: 1024px){ … }
 *     \/* dakyworld-editor:end app/page.tsx *\/
 *
 * Three things follow from writing it that way, all deliberate:
 *
 *  - **it is derived, never authored.** Delete the region and publish again and
 *    it comes back identical, because the answer lives in the page's
 *    `data-dw-responsive` attributes. Nothing is lost by a developer tidying it.
 *  - **one region per page**, so two pages sharing a stylesheet do not overwrite
 *    each other, and a page whose overrides are all cleared takes its region
 *    away rather than leaving an empty fence.
 *  - **we do not create the stylesheet or wire it up.** A CSS file we add is a
 *    file nothing imports, which would be a control that silently does nothing.
 *    If none of the usual global stylesheets is in the repository, the editor
 *    says so and the override is refused.
 *
 * The interaction block — hover, focus and active — is fixed CSS that reads the
 * custom properties the inline styles carry, so it is written once into the same
 * region whenever the page uses any of them.
 */
import { interactionCss } from "../../shared/websiteInteraction.js";
import { responsiveStyleCss, RESPONSIVE_TOKEN, normalizeResponsive, type ResponsiveStyles } from "./responsive.js";
import { readBlocks } from "./sourceAttributes.js";
import { isMarkdownPath } from "./markdown.js";

export const SOURCE_STYLESHEET_VERSION = "source-stylesheet-v1" as const;

/**
 * Where frameworks keep the stylesheet that every page loads, most specific
 * first. Probed by exact path rather than by walking the tree: a repository can
 * hold hundreds of CSS files and only a handful of names mean "this one is
 * global", so guessing from a listing would eventually pick a component's.
 */
export const STYLESHEET_CANDIDATES = [
  "app/globals.css", "src/app/globals.css", "app/global.css", "src/app/global.css",
  "styles/globals.css", "src/styles/globals.css", "styles/global.css", "src/styles/global.css",
  "src/index.css", "src/main.css", "src/app.css", "src/global.css", "src/styles/main.css",
  "assets/css/main.css", "src/assets/main.css", "src/assets/css/main.css",
  "public/styles.css", "styles.css", "style.css", "css/style.css",
] as const;

/** A hover value in either spelling: `--dw-hover-color: red` in a template's
 * style attribute, or `"--dw-hover-color": "red"` in a JSX style object. */
const HOVER_PROPERTY = /--dw-(?:hover|focus|active)-[a-z-]+["']?\s*:/;

const START = (page: string) => `/* dakyworld-editor:start ${page} */`;
const END = (page: string) => `/* dakyworld-editor:end ${page} */`;
/** Kept out of a fence name so a page path can never close someone else's. */
const safePage = (filePath: string) => filePath.replace(/[^A-Za-z0-9_./-]/g, "_");

/** The CSS this page needs, derived from the page itself. Empty when it needs none. */
export function pageEditorCss(source: string, filePath: string): string {
  if (isMarkdownPath(filePath)) return "";
  const entries: Array<{ token: string; responsive: ResponsiveStyles }> = [];
  for (const block of readBlocks(source, filePath)) {
    const token = block.attributes.find((attribute) => attribute.name.toLowerCase() === "data-dw-style")?.value;
    const raw = block.attributes.find((attribute) => attribute.name.toLowerCase() === "data-dw-responsive")?.value;
    if (!token || !RESPONSIVE_TOKEN.test(token) || !raw) continue;
    try { entries.push({ token, responsive: normalizeResponsive(JSON.parse(raw)) }); } catch { /* a broken annotation writes no rule */ }
  }
  const media = responsiveStyleCss(entries);
  // The interaction block is the same for every page, and one copy in the file
  // is enough — but which page carries it changes as pages come and go, so it is
  // written by whichever page uses the properties and deduplicated on assembly.
  const interaction = HOVER_PROPERTY.test(source) ? interactionCss() : "";
  return [media, interaction].filter(Boolean).join("\n");
}

/** Replace, insert or remove this page's region. Everything else is untouched. */
export function writeEditorRegion(stylesheet: string, filePath: string, css: string): string {
  const page = safePage(filePath);
  const start = stylesheet.indexOf(START(page));
  const end = stylesheet.indexOf(END(page));
  const block = css ? `${START(page)}\n${css}\n${END(page)}` : "";
  if (start !== -1 && end > start) {
    const before = stylesheet.slice(0, start);
    const after = stylesheet.slice(end + END(page).length);
    if (!block) {
      // Take the blank line the fence was sitting on with it, so removing the
      // last override does not leave a growing gap in somebody's stylesheet.
      return `${before.replace(/\n*$/, before ? "\n" : "")}${after.replace(/^\n+/, "")}`;
    }
    return `${before}${block}${after}`;
  }
  if (!block) return stylesheet;
  const separator = stylesheet && !stylesheet.endsWith("\n") ? "\n\n" : stylesheet ? "\n" : "";
  return `${stylesheet}${separator}${block}\n`;
}

/** What this page's region currently holds, for a caller comparing before and after. */
export function readEditorRegion(stylesheet: string, filePath: string): string {
  const page = safePage(filePath);
  const start = stylesheet.indexOf(START(page));
  const end = stylesheet.indexOf(END(page));
  if (start === -1 || end <= start) return "";
  return stylesheet.slice(start + START(page).length, end).trim();
}

/** Does this page need a stylesheet at all? Cheap enough to ask before reading one. */
export function needsStylesheet(source: string, filePath: string): boolean {
  return (/data-dw-responsive/.test(source) || HOVER_PROPERTY.test(source)) && !isMarkdownPath(filePath);
}
