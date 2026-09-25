/**
 * What this editor can and cannot do with somebody's website, said before they
 * are sold it.
 *
 * The editor works on hand-written HTML that a developer goes on working in.
 * That is a real constraint and most websites meet only part of it: a page can
 * have a JavaScript menu the preview will not run, a `<picture>` whose sources
 * the image control cannot reach, a form that belongs to whoever wrote it. None
 * of that is a bug, and all of it is a support ticket if nobody says so first.
 *
 * So this reads a page and reports, in four grades:
 *
 * - **editable** — the client can change it here, safely.
 * - **limited** — editable, with something they should know first.
 * - **developer** — real, and it stays with whoever writes the code.
 * - **unsupported** — this page is not one the editor can carry.
 *
 * Deliberately pessimistic in the middle grades and deliberately specific in the
 * text: "3 dynamic components require developer editing" is actionable, and
 * "Compatibility: Good" on its own is a promise somebody will quote back.
 *
 * No database, no network, no site record — a string of HTML in, a report out.
 */

import { attr, parseHtml, walk, type ElementNode } from "./parse.js";
import { readPage, type FieldKind } from "./regions.js";

export type CompatibilityGrade = "editable" | "limited" | "developer" | "unsupported";

export type CompatibilityFinding = {
  /** Stable, so the client can group and the docs can name one. */
  code: string;
  grade: CompatibilityGrade;
  title: string;
  /** What it means for the person who will be editing, in their words. */
  detail: string;
  /** How many of it there are on the page. */
  count: number;
};

export type PageCompatibility = {
  /** How many of each kind of thing can be edited here. */
  fields: Record<FieldKind, number>;
  editable: number;
  findings: CompatibilityFinding[];
  grade: CompatibilityGrade;
};

const GRADE_ORDER: CompatibilityGrade[] = ["editable", "limited", "developer", "unsupported"];
const worst = (grades: CompatibilityGrade[]): CompatibilityGrade =>
  grades.reduce<CompatibilityGrade>((held, grade) => (GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(held) ? grade : held), "editable");

/** A tag with a hyphen in it is a custom element, and its content is its own. */
const isCustomElement = (tag: string) => tag.includes("-") && !tag.startsWith("!");

const STRUCTURED_DATA = /^application\/(ld\+json|json)$/i;

export function analysePage(html: string): PageCompatibility {
  const content = readPage(html);
  const fields: Record<FieldKind, number> = { text: 0, richtext: 0, link: 0, button: 0, image: 0, icon: 0, container: 0 };
  for (const field of content.fields) fields[field.kind] += 1;
  // The same rule the importer refuses a file by — see `importedWebsiteFields`.
  // A page's title and description are editable and are not *content*: a
  // JavaScript shell has both and nothing else, and counting them would make it
  // look like a page with something on it.
  const editable = content.fields.filter((field) => field.kind !== "container" && field.tag !== "title" && field.tag !== "meta").length;

  const counts = new Map<string, number>();
  const bump = (code: string, by = 1) => counts.set(code, (counts.get(code) ?? 0) + by);

  const root = parseHtml(html);
  const elements = [...walk(root)];
  for (const element of elements) {
    const tag = element.tag.toLowerCase();
    if (tag === "script") {
      const type = attr(element, "type") ?? "";
      // Structured data is not behaviour; it is content the page carries.
      if (!STRUCTURED_DATA.test(type.trim())) bump("scripts");
    }
    if (tag === "form") bump("forms");
    if (tag === "iframe" || tag === "object" || tag === "embed") bump("embeds");
    if (tag === "picture" || (tag === "source" && attr(element, "srcset") !== undefined)) bump("picture");
    if (tag === "img" && attr(element, "srcset") !== undefined) bump("srcset");
    if (tag === "template" || tag === "slot") bump("templates");
    if (isCustomElement(tag)) bump("custom-elements");
    if (tag === "video" || tag === "audio") bump("media");
    if (element.attrs.some((attribute) => /^on[a-z]+$/i.test(attribute.name))) bump("inline-handlers");
    if (tag === "a") {
      const href = (attr(element, "href") ?? "").trim();
      if (href === "" || href === "#" || href.toLowerCase().startsWith("javascript:")) bump("script-links");
    }
    if (attr(element, "data-dw-field") !== undefined) bump("annotations");
  }

  const findings: CompatibilityFinding[] = [];
  const add = (code: string, grade: CompatibilityGrade, title: string, detail: string) => {
    const count = counts.get(code) ?? 0;
    if (count > 0) findings.push({ code, grade, title, detail, count });
  };

  add(
    "scripts",
    "limited",
    "Scripts do not run in the editor",
    "Menus, sliders and anything else driven by JavaScript will not behave here as they do on the live site. What you edit is still published correctly; check the live page afterwards.",
  );
  add(
    "script-links",
    "limited",
    "Links driven by script",
    "These go nowhere on their own — something in the page's code decides where they lead. Their words can be edited here; where they go cannot.",
  );
  add("srcset", "limited", "Pictures with more than one size", "Replacing one of these here drops the alternative sizes the page had for it, so the new picture is used at every size.");
  add(
    "picture",
    "developer",
    "Picture groups",
    "A <picture> chooses between several files. Which files those are stays in the page's code; the editor does not change them.",
  );
  add("forms", "developer", "Forms", "The words and labels around a form can be edited. What it does when somebody submits it belongs to whoever wrote it.");
  add("embeds", "developer", "Embedded frames", "Maps, videos and other embedded pages are left exactly as they are; they do not load in the editor.");
  add("media", "limited", "Video and audio", "These are left as they are. Their sources are not editable here.");
  add("inline-handlers", "developer", "Behaviour written into the markup", "Some elements carry code in their attributes. The editor leaves it untouched and will not change it.");
  add("custom-elements", "developer", "Custom components", "Elements the browser does not know are built by code. Their content is not read or written here.");
  add("templates", "developer", "Templates", "Content held in a template is filled in by script when the page runs, so there is nothing fixed here to edit.");

  if (editable === 0) {
    findings.push({
      code: "no-content",
      grade: "unsupported",
      title: "Nothing editable on this page",
      detail: "There is no fixed text or image in this file — it is almost certainly a JavaScript application shell, whose content only exists once the page runs. That needs its source project connected instead.",
      count: 1,
    });
  }

  if ((counts.get("annotations") ?? 0) > 0) {
    findings.push({
      code: "annotations",
      grade: "editable",
      title: "Marked-up fields",
      detail: "This page names its own editable regions, which is the strongest kind of identity an edit can have — it survives the page being rearranged.",
      count: counts.get("annotations")!,
    });
  }

  return { fields, editable, findings, grade: worst(findings.map((finding) => finding.grade)) };
}

export type SiteCompatibility = {
  /** One line, and the one people will quote. Kept deliberately unexcited. */
  rating: "Excellent" | "Good" | "Good, with parts a developer keeps" | "Limited" | "Not supported";
  grade: CompatibilityGrade;
  pages: Array<{ pageId: string; title: string; path: string; editable: number; grade: CompatibilityGrade; findings: CompatibilityFinding[]; unreadable?: string }>;
  /** Every finding across the site, counted, worst grade first. */
  findings: CompatibilityFinding[];
  totals: { pages: number; readable: number; editable: number } & Record<FieldKind, number>;
  /** What has to be true before anything can go live, and whether it is. */
  publishing: { repository: boolean; credentials: boolean; branch: string | null; blocked: string | null };
  readiness: SiteReadiness;
};

/**
 * Where a connected site has got to.
 *
 * A state rather than a boolean because the interesting cases are in the middle:
 * a site can be perfectly editable and unpublishable, or publishable and full of
 * pages nobody should promise to a client.
 */
export type SiteReadiness = "CONNECTED" | "NEEDS_REVIEW" | "READY" | "LIMITED" | "PUBLISH_BLOCKED";

export const READINESS_LABEL: Record<SiteReadiness, string> = {
  CONNECTED: "Connected, not scanned",
  NEEDS_REVIEW: "Needs review",
  READY: "Ready for editing",
  LIMITED: "Ready, with limits",
  PUBLISH_BLOCKED: "Publishing blocked",
};

export function summariseCompatibility(input: {
  pages: Array<{ pageId: string; title: string; path: string; html?: string; unreadable?: string }>;
  publishing: { repository: boolean; credentials: boolean; branch: string | null; blocked: string | null };
}): SiteCompatibility {
  const pages: SiteCompatibility["pages"] = [];
  const totals = { pages: input.pages.length, readable: 0, editable: 0, text: 0, richtext: 0, link: 0, button: 0, image: 0, icon: 0, container: 0 };
  const merged = new Map<string, CompatibilityFinding>();

  for (const page of input.pages) {
    if (page.html === undefined) {
      pages.push({ pageId: page.pageId, title: page.title, path: page.path, editable: 0, grade: "unsupported", findings: [], unreadable: page.unreadable ?? "This page could not be read." });
      continue;
    }
    const report = analysePage(page.html);
    totals.readable += 1;
    totals.editable += report.editable;
    for (const kind of ["text", "richtext", "link", "button", "image", "container"] as const) totals[kind] += report.fields[kind];
    for (const finding of report.findings) {
      const held = merged.get(finding.code);
      if (held) held.count += finding.count;
      else merged.set(finding.code, { ...finding });
    }
    pages.push({ pageId: page.pageId, title: page.title, path: page.path, editable: report.editable, grade: report.grade, findings: report.findings });
  }

  const findings = [...merged.values()].sort((left, right) => GRADE_ORDER.indexOf(right.grade) - GRADE_ORDER.indexOf(left.grade) || right.count - left.count);
  const grade = worst(pages.map((page) => page.grade));

  // A site nobody could read at all is not "excellent" for having no findings.
  const rating: SiteCompatibility["rating"] =
    totals.readable === 0
      ? "Not supported"
      : grade === "unsupported"
        ? pages.filter((page) => page.grade === "unsupported").length === pages.length
          ? "Not supported"
          : "Limited"
        : grade === "developer"
          ? "Good, with parts a developer keeps"
          : grade === "limited"
            ? "Good"
            : "Excellent";

  const readiness: SiteReadiness =
    totals.pages === 0
      ? "CONNECTED"
      : input.publishing.blocked
        ? "PUBLISH_BLOCKED"
        : grade === "unsupported" || totals.readable < totals.pages
          ? "NEEDS_REVIEW"
          : grade === "developer" || grade === "limited"
            ? "LIMITED"
            : "READY";

  return { rating, grade, pages, findings, totals, publishing: input.publishing, readiness };
}
