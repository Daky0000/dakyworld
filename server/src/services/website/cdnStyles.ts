import { createHash } from "node:crypto";
import JSON5 from "json5";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import forms from "@tailwindcss/forms";
import containerQueries from "@tailwindcss/container-queries";
import typography from "@tailwindcss/typography";
import aspectRatio from "@tailwindcss/aspect-ratio";

/**
 * The stylesheet a page would have built in the browser, built here instead.
 *
 * Pages made with the Tailwind Play CDN (every Stitch, v0 and AI-builder
 * export, and a lot of hand-made ones) have no stylesheet. A script from
 * cdn.tailwindcss.com reads the classes on the page and writes the CSS at
 * load. The editor's preview runs no script but its own, and must not: it
 * shares the editor's origin, so a third-party script there could read the
 * signed-in session. So those pages arrived in the editor unstyled, and an
 * icon sized only by `w-4 h-4` filled the whole frame.
 *
 * This builds the same CSS on the server with Tailwind 3 (the version the
 * Play CDN serves) from the page's own classes and its own
 * `tailwind.config = {…}`. The config is read as data with JSON5, never run:
 * a config that is not a plain literal is ignored and the defaults are used.
 * The result goes only into the preview. The published page is untouched and
 * keeps loading the CDN itself.
 */

const CDN_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/cdn\.tailwindcss\.com\/?([^"']*)["'][^>]*>/i;

const PLUGINS: Record<string, unknown> = {
  forms,
  "container-queries": containerQueries,
  typography,
  "aspect-ratio": aspectRatio,
};

/** Only the parts of a config that describe design. `content` and `plugins` are ours to set. */
const KEPT_KEYS = ["theme", "darkMode", "important", "prefix", "separator", "corePlugins"];

const cache = new Map<string, string>();
const CACHE_LIMIT = 40;

/** True when the page builds its styles in the browser with the Tailwind Play CDN. */
export function usesTailwindCdn(html: string): boolean {
  return CDN_SCRIPT.test(html);
}

/** The object literal after `tailwind.config =`, read as data. Null when there is none it can read. */
export function readTailwindConfig(html: string): Record<string, unknown> | null {
  const at = html.search(/tailwind\.config\s*=/);
  if (at === -1) return null;
  const open = html.indexOf("{", at);
  if (open === -1) return null;
  // Brace matching that respects strings, so a "}" inside a colour name or a
  // font stack does not end the object early.
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < html.length && i < open + 200_000; i += 1) {
    const ch = html[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON5.parse(html.slice(open, i + 1)) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
          return Object.fromEntries(Object.entries(parsed).filter(([key]) => KEPT_KEYS.includes(key)));
        } catch {
          // Functions, spreads, variables: a config that is code. Defaults it is.
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * The CSS the Play CDN would have written for this page, or null when the page
 * does not use it. Cached by content, because the preview is rebuilt on every
 * save and most saves change a word, not a class.
 */
export async function tailwindCdnCss(html: string): Promise<string | null> {
  const script = CDN_SCRIPT.exec(html);
  if (!script) return null;
  const key = createHash("sha256").update(html).digest("hex");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const query = new URLSearchParams((script[1] ?? "").split("?")[1] ?? "");
  const plugins = (query.get("plugins") ?? "")
    .split(",")
    .map((name) => PLUGINS[name.trim()])
    .filter(Boolean);
  const config = readTailwindConfig(html) ?? {};
  // The page's own markup, with the CDN script and its config taken out: a
  // class name inside the config's JavaScript is not a class on the page.
  const content = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");

  try {
    const result = await postcss([
      tailwindcss({ ...config, content: [{ raw: content, extension: "html" }], plugins } as never),
    ]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;", { from: undefined });
    const css = result.css.replace(/<\/style/gi, "<\\/style");
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, css);
    return css;
  } catch {
    return null;
  }
}
