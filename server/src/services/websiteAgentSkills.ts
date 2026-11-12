/**
 * The Builder agent's skills, and what it knows about the website before it
 * touches it.
 *
 * The agent is one agent — it always was — and until Nov 2026 it carried one
 * brief for every kind of request: a line about words, a line about design, a
 * line about reviews. That is enough to choose an operation and not enough to
 * do the work well. Asked to "make this section convert better" it knew it
 * could change words and styles, and nothing about what makes a section
 * convert.
 *
 * Two things live here, and neither calls a model:
 *
 * 1. **Skills.** A skill is a short piece of craft doctrine — how copy is
 *    written, how a layout is spaced, what a search result needs — picked for
 *    the request by its wording and by what is selected, at most two at a
 *    time. It goes in the *request*, not the system prompt: the system prompt
 *    is the same for every request and is cached, and the ten doctrines
 *    together would be paid for on every message for the one that applied.
 *    The same shape as the OS orchestrator's skills (`agents/orchestrator.ts`):
 *    one agent, the right skill for the task, the same tools throughout.
 *
 * 2. **The site profile.** What kind of website this is, read from the pages
 *    already loaded for the overview: how it was built, the language it is
 *    written in, the design tokens its stylesheet defines, who the business
 *    says it is, how its navigation is laid out, and what kind of page is
 *    open. A model that is shown `--brand: #0B3D2E` uses the brand colour; one
 *    that is shown only ten hex codes counted off the page picks the commonest
 *    grey. A model that knows the page is in French does not answer "tidy the
 *    heading" in English.
 *
 * Everything in the profile comes from the website, so it travels inside the
 * fenced context and is data, never instruction.
 */

// --- Skills ------------------------------------------------------------------

export type BuilderSkillKey =
  | "copy"
  | "design"
  | "layout"
  | "seo"
  | "accessibility"
  | "motion"
  | "media"
  | "conversion"
  | "navigation"
  | "review";

export interface BuilderSkill {
  key: BuilderSkillKey;
  /** What the chat calls it. */
  name: string;
  /** Wording that asks for this craft. */
  asks: RegExp;
  /** How to do this kind of work well, in the fewest words that change the result. */
  doctrine: string;
}

export const BUILDER_SKILLS: readonly BuilderSkill[] = [
  {
    key: "copy",
    name: "Copywriting",
    asks: /\b(?:write|rewrite|reword|rephrase|copy|wording|headline|tagline|slogan|tone|voice|shorter|longer|punchier|clearer|friendl(?:y|ier)|professional|formal|casual|persuasive|proofread|grammar|spelling|typo|translate|summari[sz]e|paragraph|sentence|caption|description)\b/i,
    doctrine:
      "Lead with what the visitor gets, not what the business is. One idea a sentence; cut every word that does not carry meaning (very, really, simply, world-class, solutions). A heading is a claim a stranger understands with no context; a button names what happens next (\"Book a call\", never \"Submit\"). Match the reading level and the person (we/you) the page already uses, keep its spelling convention, and keep every fact, name, price and number exactly as given. Never lengthen text into a space that was designed for a short line.",
  },
  {
    key: "design",
    name: "Visual design",
    asks: /\b(?:design|style|restyle|look|modern|clean|elegant|premium|bold|minimal|colou?rs?|palette|theme|fonts?|typograph\w*|bigger|smaller|size|weight|contrast|shadow|rounded|radius|border|gradient|background|dark|light|brand|polish|beautiful|prettier|nicer)\b/i,
    doctrine:
      "Use the site's own design tokens and fonts first (designTokens and siteStyles in the context): a new colour or font is a decision the person makes, not you. Build hierarchy with size, weight and space before colour — one thing is the loudest in any section. Text contrast at least 4.5:1 against what is really behind it (3:1 for large headings). Keep a consistent scale: font sizes and spacing that already appear on the page, not new in-between values. Change siblings together — one restyled card among three reads as a mistake. On phones, body text 15px or more and nothing wider than the screen.",
  },
  {
    key: "layout",
    name: "Layout and structure",
    asks: /\b(?:layout|section|block|column|grid|row|spacing|space|padding|margin|gap|align\w*|centre|center|left|right|move|reorder|rearrange|swap|above|below|before|after|duplicate|delete|remove|hide|add|insert|stack|side by side|wider|narrower|width|height|full[- ]width|mobile|tablet|phone|responsive|breakpoint)\b/i,
    doctrine:
      "Read the outline's nesting before moving anything: a move is only between siblings, and a section's meaning usually depends on its order (heading, then proof, then action). Space belongs to the container, not to each child — set padding or gap once on the parent rather than margins on every item. For phones and tablets use the mobile and tablet style operations and leave the desktop value alone. Removing a block is the largest change there is: do it only when asked for by name, and say what went with it.",
  },
  {
    key: "seo",
    name: "Search and sharing",
    asks: /\b(?:seo|search|google|rank\w*|keyword|meta|title tag|page title|description|snippet|headings? structure|h1|alt text|indexing|sitemap|open graph|share|preview|schema)\b/i,
    doctrine:
      "One h1 a page, saying what the page is for in the visitor's words; headings below it in order with no skipped level. A page title of about 50 to 60 characters with the subject first and the business name last; a description of about 140 to 160 characters that reads as a reason to click, not a list of keywords. Every meaningful picture has alt text describing what it shows; decoration has none. Links say where they go (never \"click here\"). Write for the reader first: a phrase repeated for a search engine is worse copy and no better ranking. Use the facts block for what is actually missing before proposing anything.",
  },
  {
    key: "accessibility",
    name: "Accessibility",
    asks: /\b(?:accessib\w*|a11y|wcag|screen ?readers?|contrast|alt text|alt=|readable|legib\w*|keyboard|focus|colou?r ?blind|aria)\b/i,
    doctrine:
      "Text contrast 4.5:1 (3:1 for large or bold headings) against the real background, including on hover. Every picture that carries meaning gets alt text that says what it shows and why it is there; never \"image of\". A link or button is understandable out of context and at least about 44px tall on phones. Do not carry meaning by colour alone. Keep a visible focus style on anything that can be clicked: set one with the focus style operation rather than removing an outline. Headings describe the section under them and go in order.",
  },
  {
    key: "motion",
    name: "Motion",
    asks: /\b(?:animat\w*|motion|fade|slide|parallax|hover effect|transition|scroll effect|bounce|pulse|spin|float|appear|entrance|reveal|interactive|interaction)\b/i,
    doctrine:
      "Motion explains, it does not decorate: an arrival shows what is new, a hover shows what can be pressed. One arrival effect per section, the same effect for the same kind of element across the page, and nothing that loops beside text somebody is trying to read. Prefer fades and short slides; reserve bounce, shake and spin for a single deliberate moment. Never animate the main heading of the page in a way that delays reading it.",
  },
  {
    key: "media",
    name: "Pictures and media",
    asks: /\b(?:image|picture|photo|logo|icon|banner|hero image|background image|video|gallery|thumbnail|illustration|attach\w*|upload\w*|replace the (?:image|picture|photo))\b/i,
    doctrine:
      "Use only a picture you were given: an attached file, a picture already on the site, or an address in the request — never an invented address. When a picture changes, its alt text changes with it. A background picture needs text over it to stay readable: check the contrast and, if it fails, say so and offer an overlay or a different text colour rather than leaving unreadable words. Keep a logo's proportions: never set a width and a height that distort it.",
  },
  {
    key: "conversion",
    name: "Conversion",
    asks: /\b(?:convert\w*|conversion|cta|call to action|sign ?ups?|leads?|enquir\w*|inquir\w*|bookings?|sales|sell|buy|checkout|pricing|trust|testimonial|social proof|landing page|above the fold|bounce rate|form)\b/i,
    doctrine:
      "A section does one job and asks for one action. Above the first scroll: what it is, who it is for, and one button. Put the proof a visitor needs (a figure, a named customer, a guarantee) next to the claim it supports, and use only proof the page already has — never write a testimonial, a rating or a number. A button's words finish the sentence \"I want to…\". Remove a competing second button before making the first one louder. A form asks only for what is needed to reply.",
  },
  {
    key: "navigation",
    name: "Site-wide and navigation",
    asks: /\b(?:all|every|each|whole|entire|across)\b[^.]{0,40}\b(?:pages?|site|website)\b|\b(?:nav\w*|menu|header|footer|links?|phone number|email address|contact details|site[- ]wide|everywhere|consisten\w*)\b/i,
    doctrine:
      "A change to the header, footer or menu is a change to every page: say how many pages it reaches. For one value replaced everywhere (a phone number, an email, a font, a colour) use the site-wide intent so every page is changed the same way, rather than editing the open page and leaving the others behind. A link to another page uses the path from the page list exactly. Keep menu labels short and in the order the pages matter to a visitor.",
  },
  {
    key: "review",
    name: "Page review",
    asks: /\b(?:review|audit|critique|feedback|check over|look over|what(?:'s| is) wrong|improve this page|how (?:can|do) (?:i|we) improve|suggestions?|what would you change)\b/i,
    doctrine:
      "Judge the page as a first-time visitor on a phone: within five seconds, is it clear what this is, who it is for and what to do next? Then, in this order: the message (heading, sub-heading, button), the proof, readability and contrast, the facts block (missing descriptions, headings out of order, dead links, placeholders left in), and consistency with the rest of the site. At most seven findings, each one specific to an element and paired with a fix where the editor can make it. Say what is weak and why; no praise for its own sake.",
  },
];

const SKILL_BY_KEY = new Map(BUILDER_SKILLS.map((skill) => [skill.key, skill]));

/** What the selected element suggests, when the wording alone does not say. */
function skillForSelection(kind: string | null | undefined): BuilderSkillKey | null {
  if (!kind) return null;
  if (/^(?:img|image|icon|bg|background|video)$/i.test(kind)) return "media";
  if (/^(?:h[1-6]|p|span|text|richtext|heading|paragraph|li)$/i.test(kind)) return "copy";
  if (/^(?:button|link|a)$/i.test(kind)) return "conversion";
  if (/^(?:section|container|div|header|footer|nav|main|article|aside)$/i.test(kind)) return "layout";
  return null;
}

export interface SkillPick {
  key: BuilderSkillKey;
  name: string;
  doctrine: string;
}

/**
 * The skills a request calls for: at most two, best first.
 *
 * Scored by how many distinct words of the request ask for the craft, so
 * "rewrite the headline in a friendlier tone" is plainly copy and "make the
 * hero look more modern and add a fade" is design then motion. A review
 * always comes first when asked for, because it changes the shape of the
 * answer. The selection breaks a tie and fills an empty answer: "make this
 * better" with a picture selected is about the picture.
 *
 * Nothing matching is an answer too — the agent then works from its brief
 * alone, exactly as it did before skills existed.
 */
export function pickBuilderSkills(input: { prompt: string; selectedKind?: string | null; attachments?: number }): SkillPick[] {
  const prompt = input.prompt.slice(0, 2_000);
  const fromSelection = skillForSelection(input.selectedKind);

  const scored = BUILDER_SKILLS.map((skill) => {
    const flags = skill.asks.flags.includes("g") ? skill.asks.flags : `${skill.asks.flags}g`;
    const hits = new Set((prompt.match(new RegExp(skill.asks.source, flags)) ?? []).map((word) => word.toLowerCase()));
    let score = hits.size;
    if (score > 0 && skill.key === fromSelection) score += 0.5;
    if (skill.key === "review" && score > 0) score += 10;
    if (skill.key === "media" && (input.attachments ?? 0) > 0) score += 2;
    return { skill, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, 2).map((entry) => entry.skill);
  if (picked.length === 0 && fromSelection) picked.push(SKILL_BY_KEY.get(fromSelection)!);
  return picked.map((skill) => ({ key: skill.key, name: skill.name, doctrine: skill.doctrine }));
}

/** The block that goes in the request, or nothing. Ours, so it sits above the fenced page data. */
export function skillsBlock(skills: SkillPick[]): string {
  if (skills.length === 0) return "";
  return [
    `Skills for this request (${skills.map((skill) => skill.name).join(", ")}) — how to do this kind of work well. They guide your judgement; the request and the editor's rules still decide what you may change:`,
    ...skills.map((skill) => `- ${skill.name}: ${skill.doctrine}`),
  ].join("\n");
}

// --- The site profile --------------------------------------------------------

export interface SiteProfile {
  /** How the site was built, as far as its own markup says. */
  builtWith: string[];
  /** The `lang` of the page, e.g. `en`, `fr-FR`. Null when the page does not say. */
  language: string | null;
  /** Who the business says it is: its home page's title, description and main heading. */
  identity: { title: string | null; description: string | null; heading: string | null };
  /** The labels in the site's main menu, in order. */
  navigation: string[];
  /** Named values the stylesheet defines: `--brand: #0B3D2E`. The palette and type scale as the site's own author named them. */
  designTokens: Array<{ name: string; value: string }>;
}

const text = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    // Numeric references are decoded; a named one this does not know (&reg;,
    // &rarr;) is decoration in a title or a menu label, and is dropped rather
    // than shown to the model as markup.
    .replace(/&#(\d{2,6});/g, (_, code: string) => (Number(code) >= 0x2190 && Number(code) <= 0x21ff ? " " : String.fromCodePoint(Number(code))))
    .replace(/&#x([0-9a-f]{2,6});/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&(?:reg|trade|copy|rarr|larr|raquo|laquo|bull|middot|hellip);/gi, " ")
    .replace(/&(?:ndash|mdash);/gi, "–")
    .replace(/\s+/g, " ")
    .trim();

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : null;
}

/** How a page was made, from the marks its builder leaves. Order: most specific first. */
export function builtWith(html: string): string[] {
  const found: string[] = [];
  const add = (label: string, test: RegExp) => {
    if (test.test(html) && !found.includes(label)) found.push(label);
  };
  const generator = html.match(/<meta[^>]+name\s*=\s*["']generator["'][^>]*>/i)?.[0];
  const made = generator ? attribute(generator, "content") : null;
  if (made) found.push(made.slice(0, 40));
  add("Elementor", /\belementor-(?:element|widget|section|kit)\b/i);
  add("WordPress", /\/wp-content\/|\/wp-includes\/|\bwp-block-/i);
  add("Shopify", /cdn\.shopify\.com|\bshopify-section\b/i);
  add("Wix", /static\.wixstatic\.com|\bwix-/i);
  add("Squarespace", /squarespace\.com|\bsqs-block\b/i);
  add("Webflow", /\bw-(?:nav|container|col|button)\b|webflow\.(?:js|css)/i);
  add("Next.js", /\/_next\/static\/|id="__next"/i);
  add("Nuxt", /\/_nuxt\/|id="__nuxt"/i);
  add("Astro", /\bastro-[a-z0-9]{6,}\b|data-astro-/i);
  add("Gatsby", /id="___gatsby"/i);
  add("React", /data-reactroot|id="root"><\/div>/i);
  add("Tailwind CSS", /class\s*=\s*["'][^"']*\b(?:(?:sm|md|lg|xl):[a-z-]+|(?:px|py|mt|mb|gap)-\d+|text-(?:xs|sm|base|lg|xl|[2-9]xl)|flex-col|items-center|justify-between)\b/i);
  add("Bootstrap", /class\s*=\s*["'][^"']*\b(?:col-(?:sm|md|lg|xl)-\d+|navbar-(?:nav|brand|toggler)|btn-(?:primary|secondary|outline-[a-z]+))\b/i);
  return found.slice(0, 5);
}

/** The labels of the main menu: the first `<nav>`, else the links in the `<header>`. */
export function navigationLabels(html: string): string[] {
  const region = html.match(/<nav\b[\s\S]*?<\/nav>/i)?.[0] ?? html.match(/<header\b[\s\S]*?<\/header>/i)?.[0] ?? "";
  const labels: string[] = [];
  for (const link of region.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = text(link[1] ?? "");
    if (label.length >= 2 && label.length <= 40 && !labels.includes(label)) labels.push(label);
    if (labels.length >= 12) break;
  }
  return labels;
}

/**
 * The custom properties a stylesheet defines, most useful first.
 *
 * Colours, fonts, radii and spacing, by what the value looks like — a
 * framework's hundreds of internal variables (`--tw-ring-offset-shadow`,
 * `--bs-gutter-x`, `--wp--preset--…`) are left out, because they are the
 * framework's vocabulary rather than this site's.
 */
export function designTokens(css: string[], limit = 24): Array<{ name: string; value: string }> {
  const seen = new Map<string, string>();
  for (const sheet of css) {
    for (const match of sheet.slice(0, 400_000).matchAll(/(--[a-zA-Z0-9_-]{2,48})\s*:\s*([^;{}]{1,80})[;}]/g)) {
      const name = match[1];
      const value = match[2].trim();
      if (seen.has(name)) continue;
      if (/^--(?:tw-|bs-|wp--|e-global-|swiper-|fa-|bulma-|mdc-|chakra-(?!colors-brand))/i.test(name)) continue;
      const colour = /^(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|lab\()/i.test(value);
      const font = /font|family|typeface/i.test(name) && /[a-z]/i.test(value);
      const size = /^-?\d*\.?\d+(?:px|rem|em|%)$/i.test(value) && /radius|space|spacing|gap|size|width|container/i.test(name);
      if (!colour && !font && !size) continue;
      seen.set(name, value.replace(/\s+/g, " "));
    }
  }
  const rank = (name: string) => (/brand|primary|accent|main/i.test(name) ? 0 : /colou?r|bg|background|text|ink|surface/i.test(name) ? 1 : /font|family/i.test(name) ? 2 : 3);
  return [...seen.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .slice(0, limit);
}

/**
 * What a website says about itself, from its home page and its stylesheets.
 *
 * `home` is the page that speaks for the business — the shortest path of the
 * pages read — and `open` is the page being edited, which decides the language
 * when the two differ (a French page on an English site is edited in French).
 */
export function siteProfile(input: { home: string; open?: string | null; css?: string[] }): SiteProfile {
  const { home } = input;
  const htmlTag = (input.open ?? home).match(/<html\b[^>]*>/i)?.[0] ?? home.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const description = home.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i)?.[0];
  const title = home.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = home.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const clip = (value: string | null | undefined, max: number) => {
    const clean = value ? text(value) : "";
    return clean ? clean.slice(0, max) : null;
  };
  return {
    builtWith: builtWith(`${home}\n${input.open ?? ""}`),
    language: (attribute(htmlTag, "lang") || null)?.slice(0, 12) ?? null,
    identity: {
      title: clip(title, 120),
      description: clip(description ? attribute(description, "content") : null, 240),
      heading: clip(heading, 160),
    },
    navigation: navigationLabels(home),
    designTokens: designTokens(input.css ?? []),
  };
}

/** What kind of page this is, from its path and title: the agent treats a contact page and a blog post differently. */
export function pageRole(page: { path: string; title: string }): string {
  const path = page.path.toLowerCase().replace(/\.html?$/, "").replace(/\/index$/, "/");
  const title = page.title.toLowerCase();
  const says = (pattern: RegExp) => pattern.test(path) || pattern.test(title);
  if (path === "" || path === "/" || /^\/?(?:index|home)$/.test(path)) return "home page";
  if (says(/\b(?:contact|get[- ]in[- ]touch|enquir|reach[- ]us)\b/)) return "contact page";
  if (says(/\b(?:pricing|prices|plans|packages|rates)\b/)) return "pricing page";
  if (says(/\babout|our[- ]story|who[- ]we[- ]are|team\b/)) return "about page";
  if (says(/\b(?:blog|news|insights|articles?|posts?|journal)\b/)) return /\/[^/]+\/[^/]+/.test(path) ? "article" : "article index";
  if (says(/\b(?:services?|what[- ]we[- ]do|solutions|products?|shop|store|menu)\b/)) return /\/[^/]+\/[^/]+/.test(path) ? "service or product page" : "services or products index";
  if (says(/\b(?:faq|help|support|questions)\b/)) return "help page";
  if (says(/\b(?:privacy|terms|cookies?|legal|policy|disclaimer)\b/)) return "legal page";
  if (says(/\b(?:portfolio|work|projects?|case[- ]stud|gallery)\b/)) return "portfolio page";
  if (says(/\b(?:book|booking|appointment|reserve|checkout|cart|sign[- ]?up|register|login)\b/)) return "action page";
  return "content page";
}
