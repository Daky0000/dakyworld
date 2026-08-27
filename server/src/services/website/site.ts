import { randomBytes } from "node:crypto";
import { commitFiles, GitHubError, GitHubNotConfiguredError, githubConfigured, listTree, readFile, RepoNotAllowedError } from "../../lib/github.js";
import type { Site, SitePage } from "@prisma/client";
import type { SiteField } from "./regions.js";

/**
 * Where a page's HTML comes from, and where an edited one goes.
 *
 * The repository is the source of truth. Nothing here keeps a copy of a page
 * between edits, and that is the point: the developer goes on working on these
 * files, and an editor holding its own copy would either overwrite that work or
 * quietly show a client a page that no longer exists.
 *
 * Reading has two routes and prefers the first:
 *
 *  1. **GitHub**, which is exact and immediate — it is the same commit the site
 *     will be built from, whether or not Pages has finished building it.
 *  2. **The live site over HTTP**, when no token is configured. Good enough to
 *     read and edit with, and it is the honest fallback rather than a blank
 *     screen: what it returns is what the public can see.
 *
 * Writing has one route. A publish is a commit, GitHub Pages rebuilds, and a
 * minute later the change is live. Without a token that can write, publishing
 * says so — it does not save a draft and call it published.
 */

/** A failure with a sentence written for the person who caused it. */
export class WebsiteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WebsiteError";
    this.status = status;
  }
}

const FETCH_TIMEOUT_MS = 20_000;

/** `owner/name`, or null when the site has no repository configured. */
export function siteRepo(site: Pick<Site, "repoOwner" | "repoName">): string | null {
  return site.repoOwner && site.repoName ? `${site.repoOwner}/${site.repoName}` : null;
}

/** The file's path inside the repository, with the site's folder in front of it. */
export function repoFilePath(site: Pick<Site, "repoPath">, page: Pick<SitePage, "filePath">): string {
  const folder = site.repoPath.replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${page.filePath}` : page.filePath;
}

/** The address a page is served at. */
export function pageUrl(site: Pick<Site, "publicUrl">, page: Pick<SitePage, "path">): string {
  return `${site.publicUrl.replace(/\/+$/, "")}${page.path === "/" ? "/" : page.path}`;
}

export type PageSource = {
  html: string;
  /** Which of the two routes answered, so the editor can say where it is looking. */
  from: "repository" | "live site";
};

async function fetchLive(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Dakyworld-OS-Editor" } });
    if (!response.ok) throw new WebsiteError(502, `${url} answered ${response.status}. The page may have been renamed or removed.`);
    return await response.text();
  } catch (err) {
    if (err instanceof WebsiteError) throw err;
    throw new WebsiteError(502, `Could not read ${url}. The site may be down, or this machine may have no way to reach it.`);
  } finally {
    clearTimeout(timer);
  }
}

/** The page as it stands right now, before any unpublished edits. */
export async function pageSource(site: Site, page: SitePage): Promise<PageSource> {
  const repo = siteRepo(site);
  if (repo && (await githubConfigured())) {
    const html = await readFile(repo, repoFilePath(site, page), site.repoBranch).catch(() => null);
    if (html !== null) return { html, from: "repository" };
    // A configured repository that does not have the file is worth saying out
    // loud rather than silently falling back to a live page that might be a
    // cached copy of something already deleted.
    throw new WebsiteError(
      404,
      `${repoFilePath(site, page)} is not in ${repo} on branch ${site.repoBranch}. It may have been renamed — remove the page here, or rescan the site.`,
    );
  }
  return { html: await fetchLive(pageUrl(site, page)), from: "live site" };
}

/** `about.html` → `/about`, `index.html` → `/`. The site serves extensionless paths. */
export function pathFromFile(filePath: string): string {
  const name = filePath.replace(/\.html$/i, "");
  if (name === "index") return "/";
  return `/${name}`;
}

/** `how-we-work.html` → `How we work`. A starting name, not a permanent one. */
export function titleFromFile(filePath: string): string {
  const name = filePath.replace(/\.html$/i, "").replace(/[-_]+/g, " ").trim();
  if (!name || name === "index") return "Home";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export type DiscoveredPage = {
  filePath: string;
  path: string;
  title: string;
  /** In the site's own sitemap, and so a page the public is meant to find. */
  listed: boolean;
};

/** The paths a site publishes, read from its sitemap. Empty when it has none. */
async function sitemapPaths(site: Site): Promise<Set<string>> {
  const paths = new Set<string>();
  try {
    const xml = await fetchLive(`${site.publicUrl.replace(/\/+$/, "")}/sitemap.xml`);
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      try {
        const url = new URL(match[1]!.trim());
        paths.add(url.pathname.replace(/\/$/, "") || "/");
      } catch {
        // A malformed <loc> is the sitemap's problem, not this scan's.
      }
    }
  } catch {
    // No sitemap is normal for a small site. Every page is simply unlisted.
  }
  return paths;
}

/**
 * Finds the pages a site has.
 *
 * From the repository where one is configured, because that is the complete
 * list — including a page nobody has linked to yet. From the sitemap otherwise,
 * which is the only list a static site publishes about itself.
 *
 * A file that the sitemap does not mention is still discovered, but arrives
 * hidden. That is how the plan document and the 404 page stay out of a client's
 * page list without anybody having to name them here: the site itself already
 * says which files are pages, and this listens to it.
 */
export async function discoverPages(site: Site): Promise<DiscoveredPage[]> {
  const listed = await sitemapPaths(site);
  const repo = siteRepo(site);

  if (repo && (await githubConfigured())) {
    const folder = site.repoPath.replace(/^\/+|\/+$/g, "");
    const tree = await listTree(repo, folder, site.repoBranch);
    return tree
      .filter((entry) => entry.type === "blob" || entry.type === "file")
      .map((entry) => (folder ? entry.path.slice(folder.length + 1) : entry.path))
      // Top level only. A file in a subfolder is an asset or an archive of old
      // work — `website-drafts/` on this site is exactly that.
      .filter((relative) => relative.endsWith(".html") && !relative.includes("/"))
      .map((relative) => ({
        filePath: relative,
        path: pathFromFile(relative),
        title: titleFromFile(relative),
        listed: listed.has(pathFromFile(relative)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  if (listed.size === 0) {
    throw new WebsiteError(
      424,
      `Could not work out which pages ${site.publicUrl} has. Connect the repository under Settings → Developer, or publish a sitemap.xml.`,
    );
  }

  return [...listed]
    .map((path) => {
      const filePath = path === "/" ? "index.html" : `${path.replace(/^\//, "")}.html`;
      return { filePath, path, title: titleFromFile(filePath), listed: true };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Writes an edited page back to the repository.
 *
 * One file, one commit, on the branch the site is built from. GitHub Pages
 * notices and rebuilds; the change is live within a minute or two.
 *
 * The two ways this refuses are both configuration, and both say what to do:
 * no token at all, and a token whose repository has not been added to the
 * writable list. Neither is a bug and neither should read like one.
 */
export async function publishPage(input: {
  site: Site;
  page: SitePage;
  html: string;
  message: string;
}): Promise<{ sha: string; url: string }> {
  const repo = siteRepo(input.site);
  if (!repo) {
    throw new WebsiteError(
      409,
      `${input.site.name} has no repository connected, so there is nowhere to publish to. Add one on the site's settings before publishing.`,
    );
  }
  // Asked before the commit, because `commitFiles` checks the writable-repository
  // list first and would answer "add it to the list" to somebody who has not
  // connected GitHub at all. An error should name the first thing that is
  // missing, not the second.
  if (!(await githubConfigured())) {
    throw new WebsiteError(
      503,
      "Publishing needs a GitHub token with permission to write to the website's repository. Add one under Settings → Developer.",
    );
  }

  try {
    return await commitFiles({
      repo,
      branch: input.site.repoBranch,
      message: input.message,
      files: [{ path: repoFilePath(input.site, input.page), content: input.html }],
    });
  } catch (err) {
    if (err instanceof GitHubNotConfiguredError) {
      throw new WebsiteError(
        503,
        "Publishing needs a GitHub token with permission to write to the website's repository. Add one under Settings → Developer.",
      );
    }
    if (err instanceof RepoNotAllowedError) {
      throw new WebsiteError(
        403,
        `${repo} is not on the list of repositories this system may write to. Add it under Settings → Developer, then publish again.`,
      );
    }
    // Everything else GitHub refuses is a setting on the token or the
    // repository, and every one of them is fixable by the person reading it.
    // Left as a raw GitHubError they arrive as "Something went wrong", which
    // sends somebody hunting for a bug that is not there.
    if (err instanceof GitHubError) {
      if (err.status === 401) {
        throw new WebsiteError(
          403,
          "GitHub rejected the access token — it has expired or been revoked. Create a new one and paste it under Settings → Developer.",
        );
      }
      if (err.status === 403) {
        throw new WebsiteError(
          403,
          `The GitHub token cannot write to ${repo}. Give it Contents: write on that repository — a fine-grained token must also list ${repo} among the repositories it can reach — then publish again.`,
        );
      }
      if (err.status === 404) {
        throw new WebsiteError(
          404,
          `GitHub cannot find ${repo} on branch ${input.site.repoBranch}, or the token cannot see it. Check the repository and branch on the site's settings, and that the token has access to it.`,
        );
      }
      if (err.status === 409 || err.status === 422) {
        throw new WebsiteError(
          409,
          `GitHub would not accept the commit to ${input.site.repoBranch}: ${err.message}. A branch protection rule is the usual cause.`,
        );
      }
      throw new WebsiteError(502, `GitHub would not accept the publish: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Hosts a preview must never reach, whatever the page itself allows.
 *
 * Analytics, above all. A preview that loads the site's tag manager reports
 * itself as a visit, so an afternoon of editing quietly becomes traffic in the
 * owner's own reporting — and the pages being "visited" are drafts nobody has
 * seen. The editor must be invisible to the instruments.
 */
const NEVER_IN_PREVIEW = [/https:\/\/[\w.-]*googletagmanager\.com/g, /https:\/\/[\w.-]*google-analytics\.com/g, /https:\/\/[\w.-]*doubleclick\.net/g];

/** What a page with no policy of its own gets. Deliberately close to this site's. */
const FALLBACK_POLICY =
  "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'";

export type PreviewDocument = {
  html: string;
  /**
   * The policy to send as a header. It has to be a header rather than the tag
   * in the page: a `<meta>` policy can only ever *narrow* what a header already
   * allows, so the app's own header — written for the app, where `'self'` is
   * os.dakyworld.com — would go on forbidding the website's stylesheet however
   * the page's own tag were rewritten. That is what a first version of this did,
   * and the preview rendered as unstyled black text on white.
   */
  csp: string;
};

/**
 * Prepares a page for display inside the editor's preview frame.
 *
 * Three changes, and the preview is wrong without any one of them.
 *
 * **A `<base>`**, because the HTML is served from the OS's own domain, where
 * `assets/site.css` and every logo the page asks for do not exist. With one,
 * every relative address resolves against the real site.
 *
 * **The page's own policy, widened to include that site.** The site's CSP is
 * written entirely in terms of `'self'`, and served from anywhere else `'self'`
 * is the wrong origin — so the page forbids its own stylesheet, its own fonts
 * and its own images, and `base-uri 'self'` forbids the tag just added. Taking
 * the author's policy and only widening `'self'` keeps every restriction they
 * wrote: `object-src 'none'` stays `'none'`.
 *
 * **Two directives overridden rather than widened.** `frame-ancestors` has to
 * allow the editor to frame it at all, and `form-action` is forced to `'none'`
 * because a preview of the contact page must not be able to send a real enquiry.
 */
export function previewDocument(html: string, baseUrl: string, editable?: SiteField[]): PreviewDocument {
  const origin = baseUrl.replace(/\/+$/, "");
  const declared = /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]*)"/i.exec(html)?.[1];

  let policy = (declared ?? FALLBACK_POLICY).replace(/'self'/g, `'self' ${origin}`);
  for (const host of NEVER_IN_PREVIEW) policy = policy.replace(host, "");
  policy = policy
    .split(";")
    .map((directive) => directive.trim().replace(/\s+/g, " "))
    .filter((directive) => directive && !/^(frame-ancestors|form-action)\b/i.test(directive))
    .concat(["frame-ancestors 'self'", "form-action 'none'"])
    .join("; ");

  // Marking the elements happens on the original offsets, before anything else
  // is spliced in — every one of those inserts would move them.
  const marked = editable?.length ? markEditable(html, editable) : html;

  const base = `<base href="${origin}/">`;
  const headOpen = /<head[^>]*>/i.exec(marked);
  const withBase = headOpen
    ? marked.slice(0, headOpen.index + headOpen[0].length) + base + marked.slice(headOpen.index + headOpen[0].length)
    : base + marked;

  // The tag in the page is rewritten too. It cannot loosen the header, but a
  // stale `'self'` left in it would narrow the result back down to the app's
  // own origin — the two policies are intersected, not chosen between.
  const out = withBase.replace(
    /(<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=")([^"]*)(")/i,
    (_whole, before: string, _old: string, after: string) => `${before}${policy}${after}`,
  );

  if (!editable?.length) return { html: out, csp: policy };

  // The picker is a script and a stylesheet the page did not ask for, so the
  // policy has to name them. A nonce rather than 'unsafe-inline': the page's
  // own inline scripts stay forbidden, and only this one runs.
  const nonce = randomBytes(16).toString("base64");
  const withPicker = out.replace(/<\/body>/i, `${pickerAssets(nonce)}</body>`);
  const picking = policy
    .split(";")
    .map((directive) => directive.trim())
    .map((directive) =>
      /^script-src\b/i.test(directive)
        ? `${directive} 'nonce-${nonce}'`
        : /^style-src\b/i.test(directive)
          ? `${directive} 'nonce-${nonce}'`
          : directive,
    )
    .join("; ");

  return { html: withPicker === out ? out + pickerAssets(nonce) : withPicker, csp: picking };
}

/**
 * Names every editable element in the page, so a click in the preview can say
 * which field it landed on.
 *
 * Written as a splice at the offsets the parse already recorded rather than
 * matched in the browser: the ids are positional, and anything that recomputed
 * them on the other side of the frame would be a second implementation of
 * `readPage` that has to agree with the first for ever.
 */
function markEditable(html: string, fields: SiteField[]): string {
  const marks = fields
    .filter((field) => field.attrInsert !== undefined)
    .map((field) => ({ at: field.attrInsert as number, id: field.id, kind: field.kind }))
    // Backwards, so each insert leaves the earlier offsets valid.
    .sort((a, b) => b.at - a.at);

  let out = html;
  for (const mark of marks) {
    out = `${out.slice(0, mark.at)} data-dw-field="${mark.id.replace(/"/g, "&quot;")}" data-dw-kind="${mark.kind}"${out.slice(mark.at)}`;
  }
  return out;
}

/**
 * Click to select, double click to type, and nothing else.
 *
 * Deliberately no library behind it. What a person wants from a visual editor
 * is to point at the thing they mean; the drag-and-drop layout builders that
 * word usually implies need a component model the page does not have, and would
 * turn a hand-written site into something only the builder can open.
 *
 * Three channels back to the editor, and the split matters:
 *
 *  - `select` says which field was clicked. The panel follows the page.
 *  - `text` carries what is being typed, straight out of the element it is
 *    being typed into. Editing happens on the page, in place, at the real size
 *    and in the real typeface — the panel's own box is the fallback, not the
 *    main way in.
 *  - `style` comes the other way: the panel writes the element's inline style
 *    live so a change is visible while the slider is still moving, instead of
 *    only after the draft saves and the frame reloads.
 *
 * Only text, richtext and link fields can be typed into. A picture is changed
 * by address, in the panel, because there is nothing to type into it.
 *
 * Navigation is stopped for the same reason `form-action` is `'none'`: a click
 * on a link in a preview should select the link, not leave the page.
 */
function pickerAssets(nonce: string): string {
  return `
<style nonce="${nonce}">
  [data-dw-field] { cursor: pointer; }
  [data-dw-field]:hover { outline: 2px dashed rgba(49,87,255,.55); outline-offset: 2px; }
  [data-dw-selected] { outline: 2px solid #3157FF !important; outline-offset: 2px; background: rgba(49,87,255,.06); }
  [data-dw-editing] { cursor: text !important; outline: 2px solid #3157FF !important; outline-offset: 2px; background: rgba(49,87,255,.10); }
  [data-dw-editing]:hover { outline-style: solid !important; }
  [data-dw-shown] { opacity: 1 !important; transform: none !important; filter: none !important; }
</style>
<script nonce="${nonce}">
(function () {
  var selected = null;
  var editing = null;
  var timer = null;

  function post(message) {
    message.source = "dakyworld-preview";
    parent.postMessage(message, "*");
  }
  function find(id) {
    return id ? document.querySelector('[data-dw-field="' + String(id).replace(/"/g, "") + '"]') : null;
  }
  function mark(el) {
    if (selected && selected !== el) selected.removeAttribute("data-dw-selected");
    selected = el;
    if (el) el.setAttribute("data-dw-selected", "");
  }
  // A picture has nothing to type into; its address is changed in the panel.
  function typeable(el) {
    var kind = el.getAttribute("data-dw-kind");
    return kind === "text" || kind === "richtext" || kind === "link";
  }
  // Never the element's own innerHTML: it carries the attributes this script
  // put on its children, and a data-* attribute survives sanitising on purpose
  // (the homepage figures are data-target). Handing them back would commit the
  // editor's scaffolding into the published page.
  var OURS = ["data-dw-field", "data-dw-kind", "data-dw-shown", "data-dw-selected", "data-dw-editing"];
  function words(el) {
    var copy = el.cloneNode(true);
    var marked = copy.querySelectorAll("[" + OURS.join("],[") + "]");
    for (var i = 0; i < marked.length; i++) {
      for (var j = 0; j < OURS.length; j++) marked[i].removeAttribute(OURS[j]);
    }
    return copy.innerHTML;
  }
  function push(final) {
    if (!editing) return;
    post({ type: "text", id: editing.getAttribute("data-dw-field"), html: words(editing), final: !!final });
  }
  function startEdit(el) {
    if (!el || !typeable(el) || editing === el) return;
    stopEdit();
    editing = el;
    el.setAttribute("contenteditable", "true");
    el.setAttribute("data-dw-editing", "");
    el.focus();
    post({ type: "editing", id: el.getAttribute("data-dw-field") });
  }
  function stopEdit() {
    if (!editing) return;
    clearTimeout(timer);
    push(true);
    var was = editing;
    editing = null;
    was.removeAttribute("contenteditable");
    was.removeAttribute("data-dw-editing");
    was.blur();
    post({ type: "editing", id: null });
  }

  document.addEventListener("click", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-dw-field]") : null;
    // While typing, a click inside the same element is the caret being placed.
    if (editing && el === editing) return;
    // A click on nothing in particular clears the selection rather than
    // leaving the panel describing something the eye has moved on from.
    event.preventDefault();
    event.stopPropagation();
    stopEdit();
    mark(el);
    post({ type: "select", id: el ? el.getAttribute("data-dw-field") : null });
  }, true);

  document.addEventListener("dblclick", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-dw-field]") : null;
    if (!el || !typeable(el)) return;
    event.preventDefault();
    event.stopPropagation();
    mark(el);
    post({ type: "select", id: el.getAttribute("data-dw-field") });
    startEdit(el);
  }, true);

  document.addEventListener("input", function () {
    if (!editing) return;
    clearTimeout(timer);
    timer = setTimeout(function () { push(false); }, 250);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (!editing) return;
    if (event.key === "Escape") { event.preventDefault(); stopEdit(); return; }
    // Lines within an element, not new paragraphs — the browser's default here
    // is a <div>, which would put a block inside a heading.
    if (event.key === "Enter") { event.preventDefault(); document.execCommand("insertLineBreak"); }
  }, true);

  document.addEventListener("paste", function (event) {
    if (!editing) return;
    // Pasting out of a word processor brings its markup with it. The words are
    // what somebody meant to paste.
    event.preventDefault();
    var text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
    document.execCommand("insertText", false, text);
  }, true);

  // A page whose sections fade in as you scroll shows almost nothing in a
  // frame that has never been scrolled, and nobody can click a heading they
  // cannot see. Sweep the page once so every IntersectionObserver fires the
  // way it would for a reader, then force anything still invisible.
  //
  // Only here, never in the plain Preview: that one is meant to be the page
  // exactly as a visitor gets it, animations and all.
  function force() {
    var fields = document.querySelectorAll("[data-dw-field]");
    for (var i = 0; i < fields.length; i++) {
      var node = fields[i];
      while (node && node !== document.body) {
        if (!node.hasAttribute("data-dw-shown")) {
          var style = window.getComputedStyle(node);
          // Something the page means to keep hidden — a closed menu, a tab
          // nobody is on — has no box and stays hidden.
          if (style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) < 0.1) {
            node.setAttribute("data-dw-shown", "");
          }
        }
        node = node.parentElement;
      }
    }
  }
  var swept = false;
  function sweep() {
    if (swept) return;
    swept = true;
    var height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    var step = Math.max(240, Math.round(window.innerHeight * 0.8));
    // Put the page back where it was, not at the top: by the time this runs the
    // editor may already have scrolled to something that was clicked.
    var was = window.scrollY || 0;
    var at = 0;
    (function next() {
      window.scrollTo(0, at);
      at += step;
      if (at < height + step) window.requestAnimationFrame(next);
      else {
        window.scrollTo(0, was);
        window.setTimeout(force, 80);
      }
    })();
  }
  if (document.readyState === "complete") window.setTimeout(sweep, 120);
  else window.addEventListener("load", function () { window.setTimeout(sweep, 120); });

  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.source !== "dakyworld-editor") return;
    if (data.type === "reveal") { sweep(); return; }
    if (data.type === "select") {
      stopEdit();
      var el = find(data.id);
      if (!el && data.id) post({ type: "absent", id: data.id, want: "select" });
      mark(el);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (data.type === "edit") {
      var target = find(data.id);
      if (target) { mark(target); startEdit(target); }
    } else if (data.type === "stopEdit") {
      stopEdit();
    } else if (data.type === "style") {
      // The whole inline style, because that is what the panel edits — including
      // the declarations it has no control for, which ride through untouched.
      var styled = find(data.id);
      // Nothing to write it on: say so, rather than letting the change vanish.
      if (!styled) { post({ type: "absent", id: data.id, want: "style" }); return; }
      if (data.style) styled.setAttribute("style", String(data.style));
      else styled.removeAttribute("style");
      post({ type: "applied", id: data.id, want: "style" });
    } else if (data.type === "text") {
      var written = find(data.id);
      if (!written) { post({ type: "absent", id: data.id, want: "text" }); return; }
      // Never while it is being typed into: that would move the caret.
      if (written !== editing) written.innerHTML = String(data.html == null ? "" : data.html);
      post({ type: "applied", id: data.id, want: "text" });
    }
  });
  // Announced after the listener above exists, and again on load, because an
  // editor that pushed before this point would have pushed into nothing.
  post({ type: "ready" });
  if (document.readyState !== "complete") window.addEventListener("load", function () { post({ type: "ready" }); });
})();
</script>`;
}
