import { prisma } from "../lib/prisma.js";
import { callModel } from "../lib/models/call.js";
import { PROVIDERS } from "../lib/models/registry.js";
import { chooseDirection, type DesignDirection } from "./designReferences.js";
import { companyProfile } from "./systemProfile.js";
import { writerSystem } from "./writers/brief.js";
import { appUrl } from "./emailSender.js";
import type { CompanyAudit } from "./companyAudit.js";
import type { HomepageLook } from "./homepageLook.js";

/**
 * Building the demo.
 *
 * The argument a cold email makes to a business with no website is hard to
 * make in words. "A site would bring you customers" is a claim; a page with
 * their own name on it, their own trade, the services they actually list, at a
 * link they can open on their phone, is the argument itself. Same for a bad
 * site: "yours is dated" is an opinion until they can put the two side by
 * side.
 *
 * So this builds one. The order matters:
 *
 *   1. **What is true about them** — from the scan, which already researched
 *      them, read their homepage and photographed it.
 *   2. **A design direction from real published work** — see
 *      services/designReferences.ts. This is the step that stops the output
 *      being the same centred hero everybody's model produces.
 *   3. **The page**, built by whoever serves the `html` job, which is ChatGPT.
 *
 * Three rules the build cannot get around:
 *
 *  - **Only their own facts.** Their name, their trade, their town, the
 *    services their own site or listing lists. No invented client count, no
 *    invented years-in-business, no testimonials — a fabricated review on a
 *    page carrying somebody's business name is the one thing here that could
 *    genuinely harm them.
 *  - **It says what it is.** The demo banner is injected by this file, not
 *    written by the model, so it cannot be left out. A page carrying a real
 *    business's name that does not say it is a concept is a page that can be
 *    mistaken for theirs.
 *  - **Nothing loads from anywhere else.** No external scripts, no hotlinked
 *    images off somebody's stock library. Fonts from Google are the single
 *    exception, and the served page carries a CSP that enforces all of it.
 */

/** The one outside origin a demo may reach: web fonts. Everything else is stripped. */
const ALLOWED_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

export interface DemoSubject {
  leadId: string;
  businessName: string;
  trade: string | null;
  town: string | null;
  region: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  rating: number | null;
  reviewsCount: number | null;
  services: string[];
  /** What the scan found wrong with what they have now. */
  problems: string[];
  /** What the scan found that is good — a page should not contradict it. */
  strengths: string[];
}

export interface BuildResult {
  demoId: string;
  slug: string;
  url: string;
  version: number;
  direction: DesignDirection;
  builtBy: string;
  costUsd: number;
  notes: string[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["html", "headline", "sections", "usedFacts", "notes"],
  properties: {
    html: {
      type: "string",
      description:
        "The complete page: <!doctype html> through </html>, with all CSS in one <style> block in the head and any JavaScript inline at the end of the body. Self-contained — nothing loads from another server except a Google Fonts stylesheet.",
    },
    headline: { type: "string", description: "The first line a visitor reads, as it appears on the page." },
    sections: { type: "array", items: { type: "string" }, description: "The sections you built, in order." },
    usedFacts: {
      type: "array",
      items: { type: "string" },
      description: "Every fact about the business that appears on the page, so a person can check each one against the record.",
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "What you left as a placeholder because the facts did not cover it — an address, opening hours, a photograph.",
    },
  },
} as const;

/**
 * How the page is designed. Overridable by `dev.web`.
 *
 * Note what is *not* in here. The fabrication rules and the build rules live
 * in `CONTRACT` below, out of reach of any edit, because this page goes on the
 * public internet carrying a real business's name and a rewritten voice must
 * not be able to authorise an invented testimonial on it. That is the sharpest
 * case for the doctrine/contract split in this codebase: the thing being
 * edited is taste, and the thing being protected is somebody else's reputation.
 */
export const SHIPPED_DOCTRINE = `You build one landing page for one small business, as a working demonstration of what their site could be.

This page is for the business, not for us. It carries their name, their trade and their words.

Take the *direction* from the references you are given. Never reproduce anybody's actual design, and never copy markup — that work belongs to whoever made it.

**What you may put on the page:**
- Only the facts you are given. Their name, trade, town, services, phone, email, rating and review count if those are supplied.
- Ordinary, true copy written around those facts.

Say what the business does in the first line — not a slogan, and not "Welcome to".`;

/**
 * The fabrication rules and the build rules. Never reachable by an edit.
 */
const CONTRACT = `**What you may never put on the page:**
- An invented testimonial, review, client name, case study, statistic, price, award, certification or number of years in business. A fabricated review on a page carrying somebody's real business name is the one thing here that could genuinely damage them, and it is the first thing they will check.
- A claim about what they do beyond what the facts say. If you were given three services, the page offers three services.
- Any image from another server. There are no photographs available to you. Build with type, colour, spacing, CSS gradients and inline SVG — a page that is well set and empty of stock imagery looks *more* considered than one wallpapered in somebody else's photographs, and it loads on a slow phone.

**How it must be built:**
- One file. \`<!doctype html>\` to \`</html>\`. All CSS in a single \`<style>\` in the head. Any JavaScript inline, at the end of the body, and only for behaviour a page genuinely needs — a mobile menu, a scroll reveal.
- Nothing loads from another server. The one exception is a Google Fonts stylesheet from fonts.googleapis.com, which you may use, with a real fallback stack on every rule.
- Mobile first, and it must be right at 390px wide. Most of the people who will open this are on a phone on a mobile connection.
- Real contact routes, using the details supplied: a \`tel:\` link on the phone number, \`mailto:\` on the address, a WhatsApp link where there is a number. A demo whose buttons do nothing is a demo of nothing.
- Accessible basics: one \`<h1>\`, real heading order, alt text on any SVG that carries meaning, colour contrast that passes on the body text.
- No cookie banner, no newsletter pop-up, no chat widget.

Write British English.`;

async function systemPrompt(direction: DesignDirection, senderName: string): Promise<string> {
  const chosen = `${senderName} built this to show them what is possible, and it will be sent to them as a link.

**The design direction, which was chosen by looking at real published work — follow it:**
${direction.direction}

${
    direction.references.length
      ? direction.references
          .map(
            (reference, index) =>
              `Reference ${index + 1} — ${reference.name} (${reference.source})
  Why it fits: ${reference.whyItFits}
  Layout: ${reference.layout}
  Look: ${reference.look}
  Motion: ${reference.motion}`,
          )
          .join("\n\n")
      : "No specific references were found, so build to the direction above and keep it plain, fast and clear."
  }

${direction.avoid.length ? `**Avoid, specifically for this trade:**\n${direction.avoid.map((entry) => `- ${entry}`).join("\n")}` : ""}`;

  return writerSystem("demo.page", SHIPPED_DOCTRINE, { facts: [chosen], contract: CONTRACT });
}

function buildPrompt(subject: DemoSubject): string {
  const parts = [
    `The business: ${subject.businessName}`,
    subject.trade ? `What they do: ${subject.trade}` : null,
    [subject.town, subject.region, subject.country].filter(Boolean).length
      ? `Where: ${[subject.town, subject.region, subject.country].filter(Boolean).join(", ")}`
      : null,
    subject.phone ? `Phone (make it a tel: link): ${subject.phone}` : null,
    subject.email ? `Email (make it a mailto: link): ${subject.email}` : null,
    subject.rating != null && subject.reviewsCount != null
      ? `Their public rating, which is true and may be shown: ${subject.rating} from ${subject.reviewsCount} reviews`
      : null,
    subject.services.length ? `Services they list, in their own words:\n${subject.services.map((entry) => `- ${entry}`).join("\n")}` : null,
  ].filter(Boolean);

  if (subject.website) {
    parts.push(
      "",
      `They already have a site at ${subject.website}. This is a redesign of it, and it has to be visibly better in ways they can name. What is wrong with the current one:`,
      subject.problems.map((entry) => `- ${entry}`).join("\n") || "- not recorded",
    );
    if (subject.strengths.length) {
      parts.push("", "What is already good about their setup, which the page must not contradict:", subject.strengths.map((entry) => `- ${entry}`).join("\n"));
    }
  } else {
    parts.push(
      "",
      "They have no website at all. This is the first thing about them on the internet that they would own, so it has to do the basic job completely: say who they are, what they do, where they are, and give three ways to reach them.",
    );
  }

  if (!subject.services.length) {
    parts.push(
      "",
      "No service list was found for them. Do not invent one. Build the page around what they do in general and leave a clearly marked placeholder section for their services — the note field should say so.",
    );
  }

  parts.push("", "Build the page.");
  return parts.join("\n");
}

// --- Making the page safe to serve ------------------------------------------

/**
 * The page comes from a model and is served from Dakyworld's own domain, so
 * what it is allowed to load is not left to the prompt.
 *
 * The CSP on the response is the real enforcement; this strips the obvious
 * things first so the page does not arrive visibly broken by its own headers.
 */
export function sanitiseDemoHtml(html: string): { html: string; stripped: string[] } {
  const stripped: string[] = [];
  let out = html.trim();

  // A script from another server, which the CSP would block anyway.
  out = out.replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi, (match, src: string) => {
    if (ALLOWED_ORIGINS.some((origin) => src.startsWith(origin))) return match;
    stripped.push(`external script: ${src}`);
    return "";
  });

  // Frames, which are somebody else's page inside ours.
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, () => {
    stripped.push("iframe");
    return "";
  });

  // A form that posts somewhere else takes a visitor's details off our domain.
  out = out.replace(/(<form\b[^>]*\baction\s*=\s*["'])(https?:\/\/[^"']+)(["'])/gi, (_match, before: string, action: string, after: string) => {
    stripped.push(`form posting to ${action}`);
    return `${before}#${after}`;
  });

  // Hotlinked images: they break under the CSP and they are somebody else's
  // property. Left as a note rather than silently swapped for a placeholder.
  for (const match of out.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    stripped.push(`external image: ${match[1]}`);
  }

  return { html: out, stripped };
}

/**
 * The bar that says what this is.
 *
 * Injected here rather than asked for in the prompt, because a page carrying a
 * real business's name that does not say it is a concept is a page that can be
 * mistaken for theirs — by them, by their customers, or by anybody the link
 * gets forwarded to. A model that forgets it once has produced that page.
 */
function demoBanner(businessName: string, senderName: string, senderSite: string): string {
  return `<div id="dw-demo-bar" role="note" style="position:sticky;top:0;z-index:2147483647;display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:center;padding:.6rem 1rem;background:#08101F;color:#F4F5F0;font:500 13px/1.4 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center">
<span>A concept design for <strong>${escapeHtml(businessName)}</strong> — not their website, and not affiliated with them.</span>
<a href="https://${escapeHtml(senderSite)}" style="color:#B8FF3D;text-decoration:underline;text-underline-offset:2px">Built by ${escapeHtml(senderName)}</a>
</div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function withBanner(html: string, businessName: string, senderName: string, senderSite: string): string {
  const banner = demoBanner(businessName, senderName, senderSite);
  // After the opening body tag when there is one; otherwise at the very top,
  // which is still correct HTML — browsers open an implicit body.
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (!bodyOpen) return banner + html;
  const at = bodyOpen.index + bodyOpen[0].length;
  return html.slice(0, at) + "\n" + banner + html.slice(at);
}

/**
 * The public address of a demo. One spelling, in one place — an email carrying
 * a link that does not match what the server serves is the whole feature
 * failing in the only place the prospect can see.
 */
export function demoUrl(slug: string, base: string): string {
  return `${base.replace(/\/$/, "")}/demos/${slug}`;
}

/** `Adjei Dental Centre` becomes `adjei-dental-centre`. */
export function demoSlug(businessName: string): string {
  const base = businessName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "demo";
}

async function uniqueSlug(businessName: string, existingId: string | null): Promise<string> {
  const base = demoSlug(businessName);
  for (let attempt = 0; attempt < 50; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const clash = await prisma.demo.findUnique({ where: { slug }, select: { id: true } });
    if (!clash || clash.id === existingId) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// --- The build --------------------------------------------------------------

/** Turns a lead and its research into the facts a page can be built from. */
export function subjectFromLead(
  lead: {
    id: string;
    contactName: string;
    companyName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    website: string | null;
    category: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    rating: unknown;
    reviewsCount: number | null;
  },
  audit: CompanyAudit | null,
  look: HomepageLook | null,
): DemoSubject {
  return {
    leadId: lead.id,
    businessName: lead.companyName ?? lead.contactName,
    trade: look?.states?.trade ?? lead.category,
    town: look?.states?.town ?? lead.city,
    region: lead.region,
    country: lead.country,
    phone: lead.contactPhone,
    email: lead.contactEmail,
    website: lead.website,
    rating: lead.rating != null ? Number(lead.rating) : null,
    reviewsCount: lead.reviewsCount,
    services: look?.states?.services ?? [],
    problems: [
      ...(audit?.findings ?? []).filter((finding) => finding.severity !== "GOOD").map((finding) => finding.observed),
      ...(look?.observations ?? []).filter((observation) => observation.severity !== "GOOD").map((observation) => observation.observed),
    ].slice(0, 8),
    strengths: [
      ...(audit?.findings ?? []).filter((finding) => finding.severity === "GOOD").map((finding) => finding.observed),
      ...(look?.observations ?? []).filter((observation) => observation.severity === "GOOD").map((observation) => observation.observed),
    ].slice(0, 4),
  };
}

export async function buildDemo(subject: DemoSubject, options: { rebuild?: boolean } = {}): Promise<BuildResult> {
  const notes: string[] = [];
  const profile = await companyProfile();

  // 1. Where the design comes from.
  const direction = await chooseDirection({
    businessName: subject.businessName,
    trade: subject.trade,
    town: subject.town,
    services: subject.services,
    hasExistingSite: Boolean(subject.website),
    problems: subject.problems,
  });
  if (direction.note) notes.push(direction.note);

  // 2. The page.
  const result = await callModel<{
    html: string;
    headline: string;
    sections: string[];
    usedFacts: string[];
    notes: string[];
  }>({
    purpose: "demo.build",
    // Complete web pages. The one job ChatGPT was picked for.
    job: "html",
    system: await systemPrompt(direction, profile.displayName),
    prompt: () => buildPrompt(subject),
    schema: SCHEMA as unknown as Record<string, unknown>,
    effort: "high",
    /*
     * A whole page of HTML and CSS — the largest single thing this app asks a
     * model for, but not 32,000 tokens' worth. A generous landing page is
     * 30-40KB, which is around 12,000. The reservation was the problem rather
     * than the page: providers count `max_completion_tokens` against the
     * per-minute budget whether or not it is used, so asking for the moon is a
     * good way to be rate-limited for a page that would have fitted anyway.
     */
    maxTokens: 16_000,
    messages: {
      noKey: "No model is connected for building pages. Add a ChatGPT key under Settings → AI models.",
      truncated: "The page ran out of room before it finished. Try again — if it keeps happening, the brief is too large.",
      refusal: "The builder declined this one.",
    },
  });
  notes.push(...(result.data.notes ?? []));

  // 3. Make it safe to serve, and make it say what it is.
  const cleaned = sanitiseDemoHtml(result.data.html);
  if (cleaned.stripped.length) notes.push(`Removed from the page before serving: ${cleaned.stripped.join("; ")}.`);
  const html = withBanner(cleaned.html, subject.businessName, profile.displayName, profile.web ?? "dakyworld.com");

  const existing = options.rebuild ? await prisma.demo.findFirst({ where: { leadId: subject.leadId }, orderBy: { createdAt: "desc" } }) : null;
  const slug = existing?.slug ?? (await uniqueSlug(subject.businessName, null));
  const costUsd = direction.costUsd + result.costUsd;

  const brief = {
    headline: result.data.headline,
    sections: result.data.sections,
    usedFacts: result.data.usedFacts,
    subject,
  };

  const demo = existing
    ? await prisma.demo.update({
        where: { id: existing.id },
        data: {
          html,
          brief: brief as never,
          references: direction as never,
          builtBy: PROVIDERS[result.provider].name,
          buildCostUsd: costUsd,
          version: existing.version + 1,
          // A rebuild of a page already sent is a draft again until somebody
          // looks at it: the link is live and the content just changed.
          status: existing.status === "SENT" ? "READY" : existing.status,
        },
      })
    : await prisma.demo.create({
        data: {
          slug,
          leadId: subject.leadId,
          title: `${subject.businessName} — ${subject.website ? "redesign" : "new site"}`,
          businessName: subject.businessName,
          html,
          brief: brief as never,
          references: direction as never,
          builtBy: PROVIDERS[result.provider].name,
          buildCostUsd: costUsd,
          status: "DRAFT",
        },
      });

  return {
    demoId: demo.id,
    slug: demo.slug,
    url: demoUrl(demo.slug, await appUrl()),
    version: demo.version,
    direction,
    builtBy: PROVIDERS[result.provider].name,
    costUsd,
    notes,
  };
}

