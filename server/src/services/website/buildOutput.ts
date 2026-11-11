/**
 * Which tool built an imported site, and how to make its pages hold an edit.
 *
 * 11 Nov 2026. A Next.js static export (Gulf Contracting, made with Gemini)
 * imported as a ZIP opened in the editor looking perfect, and every edit was
 * undone on the published site. Each page carries its content twice: once as
 * HTML and once as React data in inline `self.__next_f.push(...)` scripts. On a
 * hosted page the site's own scripts run, React hydrates from that data, finds
 * the HTML no longer matches, and renders the original text back over the edit.
 * Measured in Chromium: an edited `<h1>` read "EDITED" at load and the original
 * heading three seconds later.
 *
 * Gatsby, Nuxt, SvelteKit, Remix and Astro islands hydrate the same way. So
 * when an import is recognised as one of them its pages are **frozen**: the
 * runtime scripts, the data they hydrate from and the preloads that fetch more
 * of them are taken out, and the HTML that was already there becomes the page.
 * What those scripts did for a visitor — mostly opening a menu, a drawer or a
 * tab — is put back by one small script of our own, `BEHAVIOURS_SCRIPT`, which
 * reads only attributes the page already has (`aria-controls`,
 * `aria-expanded`, `<dialog>`, `role="tab"`).
 *
 * Webflow and plain HTML are recognised and left alone: their scripts add
 * behaviour to the HTML rather than replacing it, so an edit survives them.
 *
 * Pure string work, no database: `checks/websiteSitePackage.ts`.
 */
import { attr, decodeEntities, parseHtml, walk, type ElementNode } from "./parse.js";

export type BuildKind = "next-app" | "next-pages" | "gatsby" | "nuxt" | "sveltekit" | "remix" | "astro" | "webflow" | "plain";

export type BuildRecognition = {
  kind: BuildKind;
  /** For a sentence: "a Next.js export". */
  label: string;
  /** Whether its pages are frozen on import. */
  freezes: boolean;
};

type Rule = {
  kind: BuildKind;
  label: string;
  freezes: boolean;
  /** Is this the tool that built these files? */
  detect(files: readonly string[], html: string): boolean;
  /** A script `src` or preload `href` that belongs to the runtime. */
  runtime?: RegExp;
  /** Inline script text that is the runtime or the data it hydrates from. */
  inline?: RegExp;
  /** `id` of a data script (`<script id="__NEXT_DATA__" type="application/json">`). */
  dataIds?: RegExp;
};

const anyFile = (files: readonly string[], pattern: RegExp) => files.some((file) => pattern.test(file));

const RULES: Rule[] = [
  {
    kind: "next-app",
    label: "a Next.js export",
    freezes: true,
    detect: (files, html) => /self\.__next_f/.test(html) && (/\/_next\/static\//.test(html) || anyFile(files, /(^|\/)_next\/static\//)),
    runtime: /(?:^|\/)_next\//,
    // The flight data, and React's streaming helpers ($RC, $RS, $RX) that
    // reveal Suspense boundaries from it.
    inline: /self\.__next_[fs]\b|__next_f\.push|\$R[CSX]\s*=\s*function|\$RC\(/,
  },
  {
    kind: "next-pages",
    label: "a Next.js export",
    freezes: true,
    detect: (files, html) => /id=["']?__NEXT_DATA__/.test(html) || (/\/_next\/static\//.test(html) && anyFile(files, /(^|\/)_next\/static\/[^/]+\/_buildManifest\.js$/)),
    runtime: /(?:^|\/)_next\//,
    inline: /self\.__next_[fs]\b|__NEXT_DATA__|__NEXT_P\b/,
    dataIds: /^__NEXT_DATA__$/,
  },
  {
    kind: "gatsby",
    label: "a Gatsby build",
    freezes: true,
    detect: (files, html) => /id=["']?___gatsby/.test(html) || anyFile(files, /(^|\/)page-data\/app-data\.json$/),
    runtime: /(?:^|\/)(?:app|framework|webpack-runtime|commons|polyfill|component---[^/]*)-[0-9a-f]+\.js$|(?:^|\/)page-data\//,
    inline: /___chunkMapping|___webpackCompilationHash|window\.pagePath|___gatsby/,
    dataIds: /^gatsby-(?:script-loader|chunk-mapping)$/,
  },
  {
    kind: "nuxt",
    label: "a Nuxt build",
    freezes: true,
    detect: (files, html) => /\/_nuxt\//.test(html) || /__NUXT(?:_DATA)?__/.test(html) || anyFile(files, /(^|\/)_nuxt\//),
    runtime: /(?:^|\/)_nuxt\//,
    inline: /window\.__NUXT__|__NUXT_DATA__|__NUXT__\s*=/,
    dataIds: /^__NUXT_DATA__$/,
  },
  {
    kind: "sveltekit",
    label: "a SvelteKit build",
    freezes: true,
    detect: (files, html) => /\/_app\/immutable\//.test(html) || anyFile(files, /(^|\/)_app\/immutable\//),
    runtime: /(?:^|\/)_app\/immutable\//,
    inline: /__sveltekit_|kit\.start\(|_app\/immutable\//,
  },
  {
    kind: "remix",
    label: "a Remix build",
    freezes: true,
    detect: (_files, html) => /__remixContext|__remixManifest/.test(html),
    runtime: /(?:^|\/)(?:build|assets)\/(?:entry\.client|root|manifest|routes\/|_shared\/)[^"']*\.js$/,
    inline: /__remixContext|__remixManifest|__remixRouteModules/,
  },
  {
    kind: "astro",
    label: "an Astro build",
    freezes: true,
    // Plain Astro output is static HTML and is left alone. Only islands —
    // components Astro hydrates — repaint, so only they make it a freeze.
    detect: (_files, html) => /<astro-island\b/i.test(html),
    runtime: /(?:^|\/)_astro\/[^"']*\.js$/,
    inline: /customElements\.define\(\s*["']astro-island|window\.Astro\b|astro:(?:load|idle|visible|only|media)/,
  },
  {
    kind: "webflow",
    label: "a Webflow export",
    freezes: false,
    detect: (_files, html) => /\bdata-wf-(?:page|site)=/.test(html) || /webflow(?:\.[a-z0-9]+)*\.js/i.test(html),
  },
];

const PLAIN: BuildRecognition = { kind: "plain", label: "plain HTML", freezes: false };

/** Which tool built these pages. The first page that answers decides it. */
export function recogniseBuild(files: readonly string[], pages: ReadonlyArray<{ html: string }>): BuildRecognition {
  // The home page is usually the most representative; a handful is enough.
  const sample = pages.slice(0, 8).map((page) => page.html).join("\n");
  for (const rule of RULES) {
    if (rule.detect(files, sample)) return { kind: rule.kind, label: rule.label, freezes: rule.freezes };
  }
  return PLAIN;
}

const ruleFor = (kind: BuildKind) => RULES.find((rule) => rule.kind === kind);

/** The path part of a URL, for matching against a runtime pattern. */
function pathOf(url: string): string {
  const clean = url.trim().split(/[?#]/)[0] ?? "";
  try {
    return /^(?:https?:)?\/\//i.test(clean) ? new URL(clean, "https://x.invalid").pathname : clean;
  } catch {
    return clean;
  }
}

export type FrozenPage = {
  html: string;
  /** Elements taken out, by kind, for the import's summary. */
  removed: { scripts: number; data: number; preloads: number };
  /**
   * Parts the server never drew: a client component that bailed out of
   * server rendering leaves an empty Suspense boundary, and with its script
   * gone it stays empty.
   */
  clientOnlyParts: number;
  /** Controls the behaviours script now works, and controls that may do nothing. */
  interactions: { restored: number; unrestored: string[] };
};

const PRELOAD_RELS = /\b(?:preload|modulepreload|prefetch|prerender)\b/i;

/**
 * Takes the runtime out of one page and puts back what it did that matters.
 * A page from a build that does not freeze comes back as it was.
 */
export function freezePage(html: string, build: BuildRecognition): FrozenPage {
  const rule = ruleFor(build.kind);
  const nothing: FrozenPage = { html, removed: { scripts: 0, data: 0, preloads: 0 }, clientOnlyParts: 0, interactions: { restored: 0, unrestored: [] } };
  if (!build.freezes || !rule) return nothing;

  const removed = { scripts: 0, data: 0, preloads: 0 };
  const cuts: Array<{ start: number; end: number }> = [];
  for (const node of walk(parseHtml(html))) {
    if (node.tag === "script") {
      const src = attr(node, "src");
      const id = attr(node, "id") ?? "";
      if (src !== undefined) {
        if (rule.runtime?.test(pathOf(src))) {
          cuts.push(node);
          removed.scripts++;
        }
        continue;
      }
      const text = html.slice(node.innerStart, node.innerEnd);
      if ((rule.dataIds && rule.dataIds.test(id)) || (rule.inline && rule.inline.test(text))) {
        cuts.push(node);
        removed.data++;
      }
      continue;
    }
    if (node.tag === "link") {
      const rel = attr(node, "rel") ?? "";
      const href = attr(node, "href") ?? "";
      const as = (attr(node, "as") ?? "").toLowerCase();
      if (!PRELOAD_RELS.test(rel)) continue;
      // Pictures, fonts and stylesheets are the page; scripts and data are the runtime.
      if (as === "script" || as === "fetch" || /modulepreload/i.test(rel) || (rule.runtime?.test(pathOf(href)) && !["image", "font", "style"].includes(as))) {
        cuts.push(node);
        removed.preloads++;
      }
    }
  }

  let out = html;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) out = out.slice(0, cut.start) + out.slice(cut.end);

  const clientOnlyParts = (out.match(/BAILOUT_TO_CLIENT_SIDE_RENDERING/g) ?? []).length;
  const interactions = interactionsIn(out);
  if (!out.includes("data-dw-behaviours")) out = insertBeforeBodyEnd(out, `<script data-dw-behaviours="1">${BEHAVIOURS_SCRIPT}</script>`);
  return { html: out, removed, clientOnlyParts, interactions };
}

function insertBeforeBodyEnd(html: string, snippet: string): string {
  const body = [...walk(parseHtml(html))].find((node) => node.tag === "body");
  if (body && body.innerEnd > body.innerStart) return html.slice(0, body.innerEnd) + snippet + html.slice(body.innerEnd);
  const close = html.toLowerCase().lastIndexOf("</body>");
  return close >= 0 ? html.slice(0, close) + snippet + html.slice(close) : html + snippet;
}

/** A short, readable name for a control: its label, else its words. */
function controlName(html: string, node: ElementNode): string {
  const label = attr(node, "aria-label") ?? attr(node, "title");
  const text = decodeEntities(label ?? html.slice(node.innerStart, node.innerEnd).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
  return (text || `<${node.tag}${attr(node, "class") ? ` class="${attr(node, "class")!.split(/\s+/)[0]}"` : ""}>`).slice(0, 60);
}

/**
 * The buttons on a frozen page, sorted into those the behaviours script now
 * drives and those that may do nothing. A submit button belongs to its form,
 * which a hosted page sends to the site's inbox, so it is neither.
 */
export function interactionsIn(html: string): FrozenPage["interactions"] {
  let restored = 0;
  const unrestored: string[] = [];
  for (const node of walk(parseHtml(html))) {
    const role = (attr(node, "role") ?? "").toLowerCase();
    const isButton = node.tag === "button" || role === "button" || role === "tab";
    if (!isButton) continue;
    if (attr(node, "aria-controls") || role === "tab") {
      restored++;
      continue;
    }
    const type = (attr(node, "type") ?? (node.tag === "button" ? "submit" : "")).toLowerCase();
    let inForm = false;
    for (let up = node.parent; up; up = up.parent) if (up.tag === "form") inForm = true;
    let inDialog = false;
    for (let up = node.parent; up; up = up.parent) if (up.tag === "dialog") inDialog = true;
    if (inForm && type === "submit") continue;
    // A close button inside a dialog is handled by the script's close rule.
    if (inDialog && /close|dismiss/i.test(`${attr(node, "aria-label") ?? ""} ${attr(node, "class") ?? ""} ${html.slice(node.innerStart, node.innerEnd)}`)) {
      restored++;
      continue;
    }
    unrestored.push(controlName(html, node));
  }
  return { restored, unrestored };
}

/**
 * What a frozen page's scripts did for a visitor, done again from the page's
 * own attributes. Kept small and dependency-free, and it changes nothing until
 * somebody clicks: a page with none of these patterns is exactly as frozen.
 *
 * - A button with `aria-controls` and `aria-expanded` opens and closes what it
 *   names: `showModal()` for a `<dialog>`; otherwise `hidden` comes off and
 *   `data-dw-open` (and the common `is-open`/`open` classes) go on.
 * - Inside an open dialog, a button that says close or dismiss closes it, so
 *   does the backdrop, and so does following a link in it.
 * - `role="tab"` selects its panel and hides its siblings'.
 * - Escape closes whatever a button opened.
 */
export const BEHAVIOURS_SCRIPT = `(function(){if(window.__dwBehaviours)return;window.__dwBehaviours=1;var d=document;
function tgt(el){var id=(el.getAttribute("aria-controls")||"").split(/\\s+/)[0];return id?d.getElementById(id):null}
function sync(id,open){var b=d.querySelectorAll("[aria-controls][aria-expanded]");for(var i=0;i<b.length;i++){if((b[i].getAttribute("aria-controls")||"").split(/\\s+/)[0]===id)b[i].setAttribute("aria-expanded",open?"true":"false")}}
function setOpen(t,open){if(t.tagName==="DIALOG"){if(open&&!t.open){try{t.showModal()}catch(e){t.setAttribute("open","")}}else if(!open&&t.open){t.close()}}else if(open){t.removeAttribute("hidden");t.setAttribute("data-dw-open","");t.classList.add("is-open","open")}else{if(t.hasAttribute("data-dw-hidden"))t.setAttribute("hidden","");t.removeAttribute("data-dw-open");t.classList.remove("is-open","open")}if(t.id)sync(t.id,open)}
function init(){var b=d.querySelectorAll("[aria-controls][aria-expanded]");for(var i=0;i<b.length;i++){var t=tgt(b[i]);if(t&&t.hasAttribute("hidden"))t.setAttribute("data-dw-hidden","")}}
if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",init);else init();
d.addEventListener("click",function(e){var n=e.target;if(n&&n.tagName==="DIALOG"&&n.open){var r=n.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom){n.close();return}}
var el=n&&n.closest?n.closest("button,[role=button],[role=tab],a"):null;if(!el)return;
if(el.getAttribute("role")==="tab"){var list=el.closest("[role=tablist]");if(list){var tabs=list.querySelectorAll("[role=tab]");for(var i=0;i<tabs.length;i++){var on=tabs[i]===el;tabs[i].setAttribute("aria-selected",on?"true":"false");var p=tgt(tabs[i]);if(p){if(on)p.removeAttribute("hidden");else p.setAttribute("hidden","")}}e.preventDefault();return}}
var t=tgt(el);if(t&&el.hasAttribute("aria-expanded")&&el.tagName!=="A"){e.preventDefault();setOpen(t,t.tagName==="DIALOG"?!t.open:el.getAttribute("aria-expanded")!=="true");return}
var dl=el.closest("dialog");if(dl&&dl.open){if(el.tagName==="A"){dl.close();return}var words=(el.getAttribute("aria-label")||"")+" "+(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className||"")+" "+(el.textContent||"").slice(0,40);if(/close|dismiss/i.test(words)){e.preventDefault();dl.close()}}},false);
d.addEventListener("close",function(e){var t=e.target;if(t&&t.id)sync(t.id,false)},true);
d.addEventListener("keydown",function(e){if(e.key!=="Escape")return;var b=d.querySelectorAll("[aria-controls][aria-expanded=true]");for(var i=0;i<b.length;i++){var t=tgt(b[i]);if(t&&t.tagName!=="DIALOG")setOpen(t,false)}});})();`;
