import { callModel } from "../../lib/models/call.js";
import { PROVIDERS } from "../../lib/models/registry.js";
import type { AuditEvidence } from "./evidence.js";
import { DISCIPLINE_AGENTS, scoreFindings, sortBySeverity, trimFindings, type AuditFindingDetail, type DisciplineReport } from "./types.js";

/**
 * The speed and findability review.
 *
 * Like the security section, the findings are arithmetic rather than opinion:
 * a title tag is present or it is not, the page answered in 1,840ms or it did
 * not, seventeen images have no alt text or they do not. Every one of these is
 * checkable by the person reading, which is the whole point — a report a
 * business owner can verify a line of is a report they believe the rest of.
 *
 * The model's job here is the part arithmetic cannot do: reading fifteen true
 * measurements and saying which one is actually costing this business money.
 * It is given the numbers and told it may not invent another. If no model is
 * connected, the section still stands — the findings are all still there, and
 * the summary is assembled from them instead.
 *
 * **What is deliberately absent:** a Lighthouse score, Core Web Vitals, a
 * "performance grade out of 100" borrowed from somewhere. Those need a real
 * browser rendering the page, and this is a small Node process. Reporting a
 * number we did not measure would be the same failure as an invented finding,
 * dressed up as precision.
 */

/** Above this, a visitor on a phone has already decided the site is slow. */
const SLOW_MS = 2500;
const SLUGGISH_MS = 1200;
const BRISK_MS = 600;

export async function reviewSpeedAndSeo(evidence: AuditEvidence, business: { name: string; trade: string | null; town: string | null }): Promise<DisciplineReport> {
  const findings: AuditFindingDetail[] = [];
  const checked: string[] = [];
  const notes: string[] = [];
  const add = (finding: Omit<AuditFindingDetail, "discipline" | "region" | "marker">) =>
    findings.push({ ...finding, discipline: "SPEED_SEO", region: null, marker: null });

  const page = evidence.page;
  const seo = evidence.seo;

  if (!page || !seo) {
    notes.push(
      evidence.fetch.domainDoesNotResolve
        ? "There is no site at that address, so there was nothing to measure."
        : "Their homepage could not be retrieved, so nothing about its speed or its search tags could be measured.",
    );
    return {
      discipline: "SPEED_SEO",
      reviewer: DISCIPLINE_AGENTS.SPEED_SEO.name,
      reviewedBy: "Measured directly, no model",
      score: 0,
      scored: false,
      headline: "The page could not be retrieved, so nothing was measured",
      summary: notes[0],
      findings: [],
      checked,
      notes,
      costUsd: 0,
    };
  }

  // --- Speed ---------------------------------------------------------------
  checked.push("How long the homepage takes to answer");
  if (page.responseMs > SLOW_MS) {
    add({
      id: "perf-ttfb-slow",
      severity: "HIGH",
      title: "The page takes too long to answer",
      observed: `The homepage took ${(page.responseMs / 1000).toFixed(1)} seconds to send its first byte, from a server on a fast connection. A customer on a phone waits longer than that.`,
      evidence: `Time to first byte: ${page.responseMs}ms for ${evidence.finalUrl}`,
      impact:
        "Half of mobile visitors leave a page that takes more than three seconds, and this is before a single image has started loading. Every one of those is somebody who searched for this business and gave up on the way in.",
      plainly: `Their site takes about ${(page.responseMs / 1000).toFixed(1)} seconds just to start loading. Most people on a phone give up before it finishes.`,
      recommendation: "Find where the time is going — usually the hosting plan, an unoptimised database query, or a plugin — and put a cache or a CDN in front of it.",
    });
  } else if (page.responseMs > SLUGGISH_MS) {
    add({
      id: "perf-ttfb-sluggish",
      severity: "MEDIUM",
      title: "The page is slower to answer than it should be",
      observed: `The homepage took ${page.responseMs}ms to send its first byte. Under 600ms is what good hosting gives you.`,
      evidence: `Time to first byte: ${page.responseMs}ms for ${evidence.finalUrl}`,
      impact: "Not fatal, but it is a delay before anything else can even start, and it is paid by every visitor on every page.",
      plainly: "The site is a little slow to start loading — noticeable on a phone, and usually a hosting or caching setting.",
      recommendation: "Turn on page caching, and check whether the hosting plan is the constraint.",
    });
  } else if (page.responseMs <= BRISK_MS) {
    add({
      id: "perf-ttfb-good",
      severity: "GOOD",
      title: "The server answers quickly",
      observed: `The homepage sent its first byte in ${page.responseMs}ms.`,
      evidence: `Time to first byte: ${page.responseMs}ms for ${evidence.finalUrl}`,
      impact: "The hosting is not what is slowing anything down.",
      plainly: "Their hosting is quick, which is one thing they will not have to spend money on.",
      recommendation: null,
    });
  }

  checked.push("Whether the page is compressed on the way to the browser");
  if (!page.contentEncoding) {
    add({
      id: "perf-no-compression",
      severity: "MEDIUM",
      title: "The page is sent uncompressed",
      observed: `The homepage is served with no compression, at ${Math.round(page.htmlBytes / 1024)}KB of markup${page.htmlTruncated ? " or more" : ""}. Compression typically removes three quarters of that.`,
      evidence: "No `content-encoding` response header (no gzip, no brotli).",
      impact: "Every visitor downloads several times more than they need to, and on a mobile connection that is seconds, not milliseconds. It is a switch on the server.",
      plainly: "Their pages are sent to visitors uncompressed, so everything downloads several times bigger than it needs to be. It is a setting, not a rebuild.",
      recommendation: "Turn on gzip or brotli compression at the web server or CDN.",
    });
  }

  checked.push("How many files the browser must fetch and run before it can show anything");
  const blocking = [...page.scripts.filter((script) => script.blocking), ...page.stylesheets.filter((sheet) => sheet.blocking)];
  if (blocking.length >= 6) {
    add({
      id: "perf-render-blocking",
      severity: blocking.length >= 12 ? "HIGH" : "MEDIUM",
      title: "The browser is made to wait for too many files before it can paint",
      observed: `${blocking.length} stylesheets and scripts must be downloaded and processed before anything appears on screen (${page.scripts.filter((script) => script.blocking).length} of them scripts in the head).`,
      evidence: blocking
        .slice(0, 4)
        .map((resource) => resource.url)
        .join(", "),
      impact:
        "The screen stays blank until the slowest of them arrives. On a phone on mobile data that is where most of the wait actually is — not the hosting, which may be perfectly fast.",
      plainly: "The page waits for a queue of files before showing anything, so visitors look at a blank screen longer than they should.",
      recommendation: "Add `defer` to the scripts that do not need to run first, and inline the small amount of CSS the first screen needs.",
    });
  }

  if (page.thirdPartyHosts.length >= 6) {
    add({
      id: "perf-third-party",
      severity: "MEDIUM",
      title: "The page loads from a lot of other companies' servers",
      observed: `The homepage pulls files from ${page.thirdPartyHosts.length} other hosts: ${page.thirdPartyHosts.slice(0, 6).join(", ")}${page.thirdPartyHosts.length > 6 ? ", and more" : ""}.`,
      evidence: page.thirdPartyHosts.join(", "),
      impact:
        "Each one is a separate connection to open before the page is done, and each one can be slow or down independently of their own hosting. It is also every one of those companies watching their visitors.",
      plainly: "The page depends on files from several other companies' servers, so it is only as fast as the slowest of them.",
      recommendation: "Remove the tags nobody reads any more, and self-host the fonts.",
    });
  }

  checked.push("Whether images are sized and loaded sensibly");
  const images = page.images;
  if (images.length >= 10) {
    const lazy = images.filter((image) => image.lazy).length;
    if (lazy === 0) {
      add({
        id: "perf-no-lazy-images",
        severity: "MEDIUM",
        title: "Every image loads at once, including the ones nobody scrolls to",
        observed: `${images.length} images on the homepage and not one is marked to load only when it comes into view.`,
        evidence: `${images.length} <img> tags, 0 with loading="lazy".`,
        impact: "A visitor downloads the whole page's worth of pictures to look at the top of it, and pays for the data whether they scroll or not.",
        plainly: "All the pictures download at once, even the ones further down the page nobody scrolls to.",
        recommendation: 'Add `loading="lazy"` to every image below the first screen.',
      });
    }
  }
  const unsized = images.filter((image) => !image.hasDimensions).length;
  if (images.length >= 5 && unsized / images.length > 0.6) {
    add({
      id: "perf-unsized-images",
      severity: "LOW",
      title: "Images have no size set, so the page jumps as it loads",
      observed: `${unsized} of ${images.length} images carry no width and height, so the browser cannot reserve space for them.`,
      evidence: `${unsized} <img> tags without both width and height attributes.`,
      impact: "The content shifts under the reader's thumb as each picture arrives. It is the single most irritating thing a page can do on a phone, and Google measures it.",
      plainly: "The page jumps around while it loads because the pictures have no size set, which is why people tap the wrong thing.",
      recommendation: "Set width and height on every image, or a CSS aspect-ratio.",
    });
  }

  // --- Findability ---------------------------------------------------------
  checked.push("The tags that decide how the site appears in a search result");

  if (!seo.title) {
    add({
      id: "seo-no-title",
      severity: "CRITICAL",
      title: "The page has no title",
      observed: "There is no <title> on the homepage, so a search result shows the address instead of the business name.",
      evidence: "No <title> element in the homepage markup.",
      impact: "The title is the blue line somebody clicks in a search result. Without it there is nothing to click and nothing that says who they are.",
      plainly: "Their homepage has no title, so in Google it shows up as a web address instead of the business name.",
      recommendation: `Write a title of about 55 characters: what they do, then where. "${business.trade ?? "Trade"} in ${business.town ?? "Town"} | ${business.name}".`,
    });
  } else {
    const generic = /^(home|welcome|untitled|index|home page)\b/i.test(seo.title.trim());
    if (generic) {
      add({
        id: "seo-generic-title",
        severity: "HIGH",
        title: "The page title says nothing about the business",
        observed: `The homepage title is "${seo.title}".`,
        evidence: `<title>${seo.title}</title>`,
        impact:
          "That is the line somebody reads in a search result before deciding whether to click. It contains neither what they do nor where they are, so a search for the trade will never surface it and a search for the name shows nothing useful.",
        plainly: `In Google their page is listed as "${seo.title}" — it does not say what they do or where they are, so nobody searching for the service finds them.`,
        recommendation: `Change it to what they do and where: "${business.trade ?? "Trade"} in ${business.town ?? "Town"} | ${business.name}".`,
      });
    } else if (seo.titleLength > 65 || seo.titleLength < 20) {
      add({
        id: "seo-title-length",
        severity: "LOW",
        title: seo.titleLength > 65 ? "The page title is cut off in search results" : "The page title is very short",
        observed: `The title is ${seo.titleLength} characters: "${seo.title}". Google shows roughly 55 to 60.`,
        evidence: `<title>${seo.title}</title>`,
        impact: seo.titleLength > 65 ? "The end of it — often where the town is — is replaced with an ellipsis in the result." : "There is room to say what they do and where, and it is not being used.",
        plainly: seo.titleLength > 65 ? "The title Google shows gets cut off part-way through." : "The title in search results is shorter than it needs to be, so it says less than it could.",
        recommendation: "Aim for 50 to 60 characters: what they do, where, then the business name.",
      });
    }
  }

  if (!seo.description) {
    add({
      id: "seo-no-description",
      severity: "HIGH",
      title: "No description under the search result",
      observed: "The homepage has no meta description, so Google writes its own from whatever text it finds on the page.",
      evidence: 'No <meta name="description"> in the homepage markup.',
      impact:
        "The two lines under the blue link are the only sales copy in a search result, and right now they are being written by a machine from a fragment of the page — often a cookie notice or a navigation menu.",
      plainly: "The two lines of text under their listing in Google are being made up automatically, so they are often nonsense.",
      recommendation: "Write a 150-character description saying what they do, where, and why to call them.",
    });
  } else if (seo.descriptionLength > 165 || seo.descriptionLength < 60) {
    add({
      id: "seo-description-length",
      severity: "LOW",
      title: "The search description is the wrong length",
      observed: `The meta description is ${seo.descriptionLength} characters. Google shows about 155.`,
      evidence: `<meta name="description" content="${seo.description.slice(0, 120)}${seo.description.length > 120 ? "…" : ""}">`,
      impact: seo.descriptionLength > 165 ? "The end is cut off, which is usually where the reason to call them was." : "There is unused room in the one piece of copy every searcher reads.",
      plainly: "The description under their Google listing is the wrong length, so it either gets cut off or wastes the space.",
      recommendation: "Rewrite it at 140 to 155 characters, ending with what to do next.",
    });
  }

  checked.push("Whether the page can be read on a phone");
  if (!seo.viewport) {
    add({
      id: "seo-no-viewport",
      severity: "CRITICAL",
      title: "The site is not built for phones",
      observed: "The homepage has no viewport tag, so a phone renders it at desktop width and shrinks the whole thing to fit.",
      evidence: 'No <meta name="viewport"> in the homepage markup.',
      impact:
        "Text arrives too small to read and buttons too small to press, and the visitor has to pinch and drag to use the site at all. Most of their customers are on a phone, and Google ranks mobile-unfriendly pages below mobile-friendly ones on mobile searches — which is most searches.",
      plainly: "On a phone their site comes out shrunk to unreadable size. Most people looking for them are on a phone.",
      recommendation: 'Add `<meta name="viewport" content="width=device-width, initial-scale=1">` and check the layout actually reflows.',
    });
  }

  checked.push("Whether search engines are allowed to index the site");
  if (/noindex/i.test(seo.robots ?? "")) {
    add({
      id: "seo-noindex",
      severity: "CRITICAL",
      title: "The site tells Google not to list it",
      observed: `The homepage carries a robots tag of "${seo.robots}", which asks every search engine to leave it out of results entirely.`,
      evidence: `<meta name="robots" content="${seo.robots}">`,
      impact:
        "This is almost always left over from when the site was being built. While it is there, the business cannot be found by search at all, no matter what else is done.",
      plainly: "Their website is currently telling Google not to list it. It is usually a leftover switch from when the site was built, and it is a two-minute fix.",
      recommendation: "Remove the noindex, then request indexing in Google Search Console.",
    });
  }
  if (evidence.robots.robotsTxt?.disallowsEverything) {
    add({
      id: "seo-robots-blocked",
      severity: "CRITICAL",
      title: "robots.txt blocks the whole site",
      observed: "Their robots.txt contains `Disallow: /` for all crawlers, which asks every search engine to stay off the entire site.",
      evidence: `${new URL("/robots.txt", evidence.finalUrl!).toString()} — User-agent: * / Disallow: /`,
      impact: "Nothing on the site can appear in a search result while that line is there.",
      plainly: "There is a file on their site telling Google to stay away from all of it.",
      recommendation: "Remove the blanket Disallow, leaving only the paths that genuinely should not be indexed.",
    });
  }

  checked.push("Whether the page has one clear heading");
  if (page.h1Count === 0) {
    add({
      id: "seo-no-h1",
      severity: "MEDIUM",
      title: "The page has no main heading",
      observed: "There is no <h1> on the homepage, so neither a search engine nor a screen reader can tell what the page is about.",
      evidence: `Headings found: ${page.headings.length ? page.headings.map((heading) => `h${heading.level}`).join(", ") : "none"}.`,
      impact: "The main heading is the strongest single signal of what a page is for. Leaving it out throws away the easiest ranking there is.",
      plainly: "The page has no main heading, which is one of the first things Google looks for.",
      recommendation: `Make the first line of the page an <h1> saying what they do and where: "${business.trade ?? "What they do"}${business.town ? ` in ${business.town}` : ""}".`,
    });
  } else if (page.h1Count > 1) {
    add({
      id: "seo-many-h1",
      severity: "LOW",
      title: "The page has several main headings",
      observed: `${page.h1Count} separate <h1> elements on one page.`,
      evidence: page.headings
        .filter((heading) => heading.level === 1)
        .map((heading) => `"${heading.text}"`)
        .join(", "),
      impact: "It dilutes the signal — the page claims to be about several things at once.",
      plainly: "The page has several competing main headings, so it is less clear what it is about.",
      recommendation: "Keep one <h1> and demote the rest to <h2>.",
    });
  }

  checked.push("Whether the site describes itself to Google as a local business");
  const localTypes = seo.structuredData.filter((type) => /LocalBusiness|Organization|Store|Restaurant|Dentist|ProfessionalService|Service/i.test(type));
  if (!seo.structuredData.length) {
    add({
      id: "seo-no-structured-data",
      severity: "MEDIUM",
      title: "No structured data at all",
      observed: "The homepage carries no JSON-LD, so nothing tells Google their address, opening hours, phone number or rating in a form it can use.",
      evidence: "No <script type=\"application/ld+json\"> blocks in the homepage markup.",
      impact:
        "This is what fills in the panel beside a search result — the stars, the hours, the map pin, the phone button. Without it the result is a plain blue link next to competitors who have all of that.",
      plainly: "Google has nothing to build their listing from — no hours, no phone button, no stars — so their result looks bare next to competitors.",
      recommendation: "Add LocalBusiness JSON-LD with name, address, phone, opening hours and the areas served.",
    });
  } else if (!localTypes.length) {
    add({
      id: "seo-no-local-schema",
      severity: "LOW",
      title: "Structured data, but not the kind a local business needs",
      observed: `The page declares ${seo.structuredData.join(", ")}, but nothing that describes the business itself.`,
      evidence: `JSON-LD @type values: ${seo.structuredData.join(", ")}`,
      impact: "The address, the hours and the phone number are not being handed to Google in a form it can put in the result.",
      plainly: "Some of the behind-the-scenes information is there, but not the part that gives them hours and a phone button in Google.",
      recommendation: "Add a LocalBusiness block alongside what is already there.",
    });
  } else {
    add({
      id: "seo-local-schema-good",
      severity: "GOOD",
      title: "The business describes itself to search engines properly",
      observed: `The page declares ${localTypes.join(", ")} structured data.`,
      evidence: `JSON-LD @type values: ${seo.structuredData.join(", ")}`,
      impact: "Google has what it needs to show hours, a phone number and a map pin beside their result.",
      plainly: "They have already given Google the details it needs to show their hours and phone number in search.",
      recommendation: null,
    });
  }

  checked.push("What the site looks like when its address is shared");
  if (!seo.ogTitle || !seo.ogImage) {
    add({
      id: "seo-no-link-preview",
      severity: "LOW",
      title: "A shared link shows no preview",
      observed: `The page is missing ${[!seo.ogTitle ? "og:title" : null, !seo.ogDescription ? "og:description" : null, !seo.ogImage ? "og:image" : null].filter(Boolean).join(" and ")}.`,
      evidence: "Open Graph meta tags absent from the homepage head.",
      impact: "Pasted into WhatsApp or Facebook, the address arrives as a bare grey link with no picture and no name — which is most of how a small business actually gets shared.",
      plainly: "When someone shares their website in WhatsApp it shows up as a plain link with no picture, so it looks like nothing.",
      recommendation: "Add og:title, og:description and a 1200x630 og:image.",
    });
  }

  checked.push("Whether pictures on the page carry text alternatives");
  const withUrls = images.filter((image) => image.url);
  const missingAlt = withUrls.filter((image) => image.alt === null).length;
  if (withUrls.length >= 5 && missingAlt / withUrls.length > 0.4) {
    add({
      id: "seo-missing-alt",
      severity: "MEDIUM",
      title: "Most pictures have no text description",
      observed: `${missingAlt} of ${withUrls.length} images have no alt attribute at all.`,
      evidence: `${missingAlt} <img> tags without an alt attribute on ${evidence.finalUrl}.`,
      impact:
        "Anybody using a screen reader gets nothing from those pictures, image search cannot index them, and it is one of the few accessibility failures that is also a legal exposure.",
      plainly: "Most of the pictures have no description attached, so blind visitors get nothing and Google cannot read them either.",
      recommendation: "Write a short factual alt for every picture that carries meaning, and alt=\"\" for the decorative ones.",
    });
  }

  if (page.links.internal < 3) {
    add({
      id: "seo-thin-navigation",
      severity: "MEDIUM",
      title: "The homepage barely links anywhere",
      observed: `Only ${page.links.internal} link${page.links.internal === 1 ? "" : "s"} on the homepage go anywhere else on the site.`,
      evidence: `${page.links.internal} internal links, ${page.links.external} external, ${page.links.empty} going nowhere.`,
      impact: "Search engines find the rest of a site by following links from the homepage. Pages nothing links to are pages nobody finds.",
      plainly: "The front page hardly links to the rest of the site, so both visitors and Google struggle to find the other pages.",
      recommendation: "Link the main services and the contact page from the homepage, in the navigation and in the body.",
    });
  }

  if (!evidence.robots.sitemap?.found) {
    add({
      id: "seo-no-sitemap",
      severity: "LOW",
      title: "No sitemap",
      observed: "No XML sitemap was found at the usual address or declared in robots.txt.",
      evidence: `Checked ${evidence.robots.sitemap?.url ?? "/sitemap.xml"} and robots.txt.`,
      impact: "Search engines have to discover every page by following links. A sitemap is the list, and every CMS can generate one automatically.",
      plainly: "There is no list of their pages for Google to work from — a setting in most website software.",
      recommendation: "Generate a sitemap, declare it in robots.txt, and submit it in Search Console.",
    });
  }

  if (!seo.lang) {
    add({
      id: "seo-no-lang",
      severity: "LOW",
      title: "The page does not declare its language",
      observed: "The <html> element has no lang attribute.",
      evidence: "<html> tag with no lang attribute on the homepage.",
      impact: "Screen readers guess the pronunciation and browsers guess whether to offer a translation.",
      plainly: "The page does not say which language it is in, which affects screen readers and translation.",
      recommendation: 'Set `<html lang="en">`.',
    });
  }

  const { kept, dropped } = trimFindings(findings, { medium: 6, low: 4, good: 3 });
  if (dropped) notes.push(`${dropped} smaller point${dropped === 1 ? "" : "s"} of the same kind were left out of this section to keep it readable.`);

  const sorted = sortBySeverity(kept);
  const score = scoreFindings(sorted);
  const written = await writeSummary(sorted, evidence, business);

  return {
    discipline: "SPEED_SEO",
    reviewer: DISCIPLINE_AGENTS.SPEED_SEO.name,
    reviewedBy: written.by,
    score,
    // Every finding in this section is measured rather than judged, so a
    // missing model costs it its summary and nothing else. It stays scored.
    scored: true,
    headline: written.headline,
    summary: written.summary,
    findings: sorted,
    checked,
    notes: [...notes, ...written.notes],
    costUsd: written.costUsd,
  };
}

// --- The part arithmetic cannot do ------------------------------------------

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary"],
  properties: {
    headline: {
      type: "string",
      description: "One sentence, under fifteen words: the state of this site's speed and findability. No jargon.",
    },
    summary: {
      type: "string",
      description:
        "Two or three sentences a business owner reads instead of the list below it. Name the one measurement that matters most and what it costs them. Every number you use must be one that was given to you.",
    },
  },
} as const;

async function writeSummary(
  findings: AuditFindingDetail[],
  evidence: AuditEvidence,
  business: { name: string; trade: string | null; town: string | null },
): Promise<{ headline: string; summary: string; by: string; notes: string[]; costUsd: number }> {
  const measurements = [
    `Time to first byte: ${evidence.page!.responseMs}ms`,
    `Compression: ${evidence.page!.contentEncoding ?? "none"}`,
    `HTML delivered: ${Math.round(evidence.page!.htmlBytes / 1024)}KB${evidence.page!.htmlTruncated ? " (capped, so a floor)" : ""}`,
    `Scripts: ${evidence.page!.scripts.length} (${evidence.page!.scripts.filter((script) => script.blocking).length} blocking the first paint)`,
    `Stylesheets: ${evidence.page!.stylesheets.length}`,
    `Images: ${evidence.page!.images.length}`,
    `Other companies' servers involved: ${evidence.page!.thirdPartyHosts.length}`,
    `Title: ${evidence.seo!.title ? `"${evidence.seo!.title}"` : "none"}`,
    `Meta description: ${evidence.seo!.description ? `${evidence.seo!.descriptionLength} characters` : "none"}`,
    `Mobile viewport tag: ${evidence.seo!.viewport ? "present" : "absent"}`,
    `Structured data: ${evidence.seo!.structuredData.join(", ") || "none"}`,
    `Words of visible text: ${evidence.page!.wordCount}`,
  ];

  const fallback = () => {
    const worst = findings.find((finding) => finding.severity === "CRITICAL") ?? findings.find((finding) => finding.severity === "HIGH");
    const problems = findings.filter((finding) => finding.severity !== "GOOD");
    return {
      headline: worst
        ? worst.title
        : problems.length
          ? `${problems.length} thing${problems.length === 1 ? "" : "s"} to tighten, ${problems.length === 1 ? "and it is not" : "none of them"} urgent`
          : "Fast enough, and findable",
      summary: worst
        ? `${worst.plainly} ${problems.length - 1 > 0 ? `There are ${problems.length - 1} other things worth fixing below.` : ""}`.trim()
        : problems.length
          ? `Nothing here is costing them customers today, but ${problems.length} smaller things below are each worth an hour.`
          : "The page answers quickly and carries the tags a search engine needs. Nothing to do here.",
    };
  };

  try {
    const result = await callModel<{ headline: string; summary: string }>({
      purpose: "audit.speed_seo",
      // Prose about numbers somebody else measured. Routed with the rest of
      // the system's writing.
      job: "text",
      system: `You are the Dakyworld SEO Specialist writing the speed-and-findability section of a website review for ${business.name}${business.trade ? `, ${business.trade}` : ""}${business.town ? ` in ${business.town}` : ""}.

The measurements below were taken by the system, not by you. **You may not state a number that is not in that list, and you may not describe a fault that is not in the findings.** If you want to say the site is slow, the measurement has to say so. A review that overstates a fault to a business owner who then checks it is worse than no review.

Write for somebody who runs a business and does not know what a meta description is. Say what it costs them, in customers and enquiries, not in ranking factors. British English. No exclamation marks, no "leverage", no "optimise" — say what actually happens.`,
      prompt: () =>
        [
          "What was measured on their homepage:",
          measurements.map((line) => `- ${line}`).join("\n"),
          "",
          findings.length ? "What the checks found, worst first:" : "The checks found nothing wrong.",
          findings.map((finding) => `- [${finding.severity}] ${finding.title} — ${finding.observed}`).join("\n"),
          "",
          "Write the headline and the summary.",
        ].join("\n"),
      schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
      effort: "low",
      maxTokens: 900,
    });
    return {
      headline: result.data.headline.trim(),
      summary: result.data.summary.trim(),
      by: PROVIDERS[result.provider].name,
      notes: result.fallbackNote ? [result.fallbackNote] : [],
      costUsd: result.costUsd,
    };
  } catch (err) {
    // The findings are the section. Losing the summary because no model is
    // connected must not lose the twelve measurements underneath it.
    const written = fallback();
    return {
      ...written,
      by: "Measured directly, no model",
      notes: [`The summary of this section was assembled from the findings rather than written: ${(err as Error).message}`],
      costUsd: 0,
    };
  }
}
